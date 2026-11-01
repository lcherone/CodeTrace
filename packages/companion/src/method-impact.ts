import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GraphNode, GraphEdge, GraphResponse, HistoryEvent } from "@trace/contracts";
import type { IndexedSymbol, ParsedMethod } from "./model.js";
import { GraphService, graphNode } from "./graph.js";
import { RevisionResolver, type RevisionScope, type MethodAt, type MethodResolution } from "./revision-resolver.js";
import { assessOverride, type ContractAssessment } from "./compatibility.js";
import { SourceNavigation, type SourceLink } from "./source-navigation.js";
import { HistoryService } from "./history.js";
import { GitRepository } from "./git.js";
import { parsePhp } from "./php.js";
import { TraceStore } from "./store.js";

export interface MethodImpactRequest { queryId: string; itemId: string; methodName?: string | undefined; targetRef?: string | undefined; localSignature?: string | undefined; workingTree?: boolean | undefined; phpVersion?: string | undefined; includeHistory?: boolean | undefined }
export interface DeclarationHistory { symbolId: string; introduction?: HistoryEvent; signature?: HistoryEvent; implementation?: HistoryEvent; events: HistoryEvent[]; limitations: string[] }
export interface MethodImpactRow {
  id: string; repositoryId: string; consumer: string; className?: string; methodName: string;
  installedVersion: string; installedCommit: string; relationship: "override" | "inherits" | "dependency-only" | "unknown";
  current: ContractAssessment; target: ContractAssessment; group: "changes-required" | "review-recommended" | "no-signature-incompatibility" | "insufficient-evidence";
  phpVersion: string; phpBasis: string; currentSignature?: string; targetSignature?: string; consumerSignature?: string;
  inheritancePath: Array<{ name: string; repositoryId: string; commit: string; nodeId: string }>;
  effectiveImplementation?: string; callsParent: boolean; links: SourceLink[]; nodeId?: string; history?: DeclarationHistory; relationshipHistory?: HistoryEvent[];
}
export interface MethodImpactResult {
  analysisId: string; originalQueryId: string; itemId: string; methodName: string; packageName: string;
  origin: { name: string; repositoryId: string; commit: string; signature: string; nodeId: string; history?: DeclarationHistory; links: SourceLink[] };
  target: { kind: "current" | "revision" | "local-preview" | "unavailable"; label: string; commit?: string; signature?: string; history?: DeclarationHistory; releases: string[]; links: SourceLink[] };
  rows: MethodImpactRow[]; graph: GraphResponse; complete: boolean; limitations: string[];
}
const unknown = (reason: string): ContractAssessment => ({ state: "unknown", reasons: [reason] });
const nativeNames = (method: ParsedMethod): string[] => [method.returnType, ...(method.parameters ?? []).map((parameter) => parameter.type)].flatMap((type) => type?.resolved ?? []);

export class MethodImpactService {
  constructor(private readonly store: TraceStore, private readonly graphs: GraphService) {}

  async analyze(request: MethodImpactRequest, signal?: AbortSignal, progress?: (result: MethodImpactResult) => void): Promise<MethodImpactResult> {
    const query = this.graphs.query(request.queryId);
    const unsavedSources = new Set(query.response.nodes.filter((node) => node.occurrence && (node.metadata.unsavedEditor || node.occurrence.revision.dirty)).map((node) => `${node.occurrence!.revision.repositoryId}:${node.occurrence!.path}`));
    const selected = query.response.nodes.find((node) => node.id === request.itemId);
    if (!selected?.occurrence) throw new Error("Choose a source-backed class or method to trace a method contract");
    const member = selected.occurrence.logical.memberName ?? request.methodName;
    if (!member) throw new Error("Select a method, or enter the method name for the selected class");
    const owner = selected.occurrence.logical.fullyQualifiedName;
    const resolver = new RevisionResolver(this.store);
    const sources = new SourceNavigation(this.store);
    const seedScope = resolver.scope(selected.occurrence.revision.repositoryId, selected.occurrence.revision.commit);
    let seed = await resolver.lineage(seedScope, owner, member);
    if (!seed.declarations.some((declaration) => declaration.symbol.repositoryId !== seedScope.repositoryId)) seed = await resolver.resolve(seedScope, owner, member);
    const remote = seed.declarations.filter((declaration) => declaration.symbol.repositoryId !== seedScope.repositoryId);
    const origin = remote.at(-1) ?? seed.contracts.find((contract) => contract.symbol.repositoryId !== seedScope.repositoryId) ?? seed.declarations.at(-1) ?? seed.effective;
    if (!origin) throw new Error(`The exact originating contract for ${owner}::${member} is unavailable. ${seed.problems.join(" ")}`);
    const pkg = resolver.package(origin.symbol.repositoryId);
    if (!pkg) throw new Error("The originating declaration has no indexed Composer package identity");
    const repository = this.store.repository(origin.symbol.repositoryId)!;
    const git = new GitRepository(repository.root);
    const targetCommit = request.targetRef ? await git.resolveCommit(request.targetRef) : origin.symbol.commit;
    let targetMethod: MethodAt | undefined;
    if (targetCommit) {
      const targetScope = resolver.scope(origin.symbol.repositoryId, targetCommit);
      targetMethod = (await resolver.lineage(targetScope, origin.owner.type.fqn, origin.method.name)).effective ?? (await resolver.resolve(targetScope, origin.owner.type.fqn, origin.method.name)).effective;
    }
    let localPreview: ParsedMethod | undefined;
    if (request.localSignature) {
      if (/[{}]/.test(request.localSignature)) throw new Error("Local preview accepts a method signature only, without a method body");
      const namespace = origin.owner.file.namespace;
      const imports = Object.entries(origin.owner.file.imports).map(([alias, fqn]) => `use \\${fqn} as ${alias};`).join("\n");
      const signature = request.localSignature.trim().replace(/;$/, "").replace(/\babstract\s+/g, "");
      const parsed = parsePhp(`<?php ${namespace ? `namespace ${namespace};` : ""} ${imports} class ${origin.owner.type.shortName}${origin.owner.type.parent ? ` extends \\${origin.owner.type.parent}` : ""} { ${signature} {} }`, origin.symbol.path);
      localPreview = parsed.types[0]?.methods.find((method) => method.name.toLowerCase() === member.toLowerCase());
      if (!localPreview || parsed.types[0]?.methods.length !== 1) throw new Error("The preview must declare exactly the traced method");
      localPreview = { ...localPreview, range: origin.method.range };
    } else if (request.workingTree) {
      const absolute = path.resolve(repository.root, origin.symbol.path);
      if (!absolute.startsWith(`${path.resolve(repository.root)}${path.sep}`)) throw new Error("Working-tree preview must remain inside its source repository");
      const source = await readFile(absolute, "utf8");
      localPreview = parsePhp(source, origin.symbol.path).types.find((type) => type.fqn === origin.owner.type.fqn)?.methods.find((method) => method.name.toLowerCase() === member.toLowerCase());
      if (!localPreview) throw new Error("The traced parent method is unavailable in the working-tree file");
    }
    if (localPreview) targetMethod = { ...origin, method: localPreview, symbol: { ...origin.symbol, id: `${origin.symbol.id}#local-preview`, data: localPreview, range: localPreview.range } };
    const link = (method: MethodAt, label: string, dirty = false) => { const baseline = !dirty && unsavedSources.has(`${method.symbol.repositoryId}:${method.symbol.path}`); return sources.link(method.symbol.repositoryId, method.symbol.commit, method.symbol.path, method.method.range, dirty || baseline, baseline ? `Indexed baseline · ${label}` : label); };
    const nodes = new Map<string, GraphNode>(); const edges = new Map<string, GraphEdge>(); const symbols = new Map<string, IndexedSymbol>();
    const addMethod = (method: MethodAt, role?: string) => {
      symbols.set(method.symbol.id, method.symbol); symbols.set(method.owner.symbol.id, method.owner.symbol);
      const node = graphNode(method.symbol, method.symbol.id === origin.symbol.id);
      node.metadata.scopeLabel = resolver.package(method.symbol.repositoryId)?.name ?? method.symbol.repositoryId;
      if (role) { node.metadata.impactOverview = true; node.metadata.impactRole = method.symbol.id === origin.symbol.id ? "origin-contract" : role; }
      if (method.symbol.id.includes("#local-preview") && node.occurrence) { node.occurrence.revision.dirty = true; node.metadata.unsavedEditor = true; }
      nodes.set(node.id, { ...nodes.get(node.id), ...node, metadata: { ...nodes.get(node.id)?.metadata, ...node.metadata } });
      if (!nodes.has(method.owner.symbol.id)) nodes.set(method.owner.symbol.id, graphNode(method.owner.symbol));
    };
    const addEdge = (id: string, source: string, target: string, type: GraphEdge["type"], label: string, declaration: MethodAt, detail: string, confidence: GraphEdge["confidence"] = "confirmed") => edges.set(id, { id, source, target, type, label, confidence, evidence: [{ repositoryId: declaration.symbol.repositoryId, commit: declaration.symbol.commit, path: declaration.symbol.path, range: declaration.method.range, resolutionMethod: "exact-lock-method-resolution", confidence, detail, limitations: ["Static relationships and signature compatibility do not prove runtime behaviour"] }] });
    addMethod(origin, "origin-contract");
    if (seed.effective) { addMethod(seed.effective, "selected-method"); if (seed.effective.symbol.id !== origin.symbol.id) addEdge(`seed:${seed.effective.symbol.id}`, seed.effective.symbol.id, origin.symbol.id, "overrides", "Traced parent contract", seed.effective, `The selected declaration traces through ${seed.chain.map((type) => type.type.fqn).join(" → ")}`); }
    if (targetMethod) { addMethod(targetMethod, "proposed-contract"); if (targetMethod.symbol.id !== origin.symbol.id) addEdge("proposed-contract", origin.symbol.id, targetMethod.symbol.id, "possible-lineage", localPreview ? "Local proposed contract" : "Proposed package revision", origin, `${origin.method.signature} → ${targetMethod.method.signature}`, "possible"); }
    const packageId = `impact-package:${pkg.name}`;
    nodes.set(packageId, { id: packageId, kind: "package-revision", label: pkg.name, subtitle: `${origin.symbol.commit.slice(0, 8)} → ${localPreview ? "local preview" : targetCommit?.slice(0, 8) ?? "unavailable"}`, metadata: { repositoryId: pkg.repositoryId, packageName: pkg.name, impactOverview: true } });
    addEdge("package-contract", packageId, origin.symbol.id, "declares", "Provides contract", origin, `${pkg.name} provides ${origin.symbol.fqn} at the exact source revision`);
    const result: MethodImpactResult = {
      analysisId: randomUUID(), originalQueryId: request.queryId, itemId: request.itemId, methodName: member, packageName: pkg.name,
      origin: { name: origin.symbol.fqn, repositoryId: origin.symbol.repositoryId, commit: origin.symbol.commit, signature: origin.method.signature, nodeId: origin.symbol.id, links: [link(origin, "Originating contract")] },
      target: { kind: localPreview ? "local-preview" : request.targetRef ? targetCommit ? "revision" : "unavailable" : "current", label: localPreview ? "Local unreleased contract preview" : request.targetRef ?? "Current selected contract", ...(targetCommit ? { commit: targetCommit } : {}), ...(targetMethod ? { signature: targetMethod.method.signature } : {}), releases: [], links: targetMethod ? [link(targetMethod, localPreview ? "Local preview · no immutable source link" : "Proposed contract", Boolean(localPreview))] : [] },
      rows: [], graph: query.response, complete: false, limitations: ["Only indexed repository inventories and locally available exact Git revisions are searched", "A dependency lock is not deployment evidence; behavioural compatibility requires review", ...seed.problems],
    };
    if (!request.phpVersion) result.limitations.push("PHP version is selected per consumer from Composer platform or its minimum PHP requirement; absent versions remain unknown");
    if (unsavedSources.size) result.limitations.push("The editor has unsaved changes. Current-state findings use the committed baseline; paste the edited parent signature to assess an unsaved contract preview. Exact GitHub links for unsaved source files are unavailable.");
    const dependencies = this.store.activeDependencies().filter((dependency) => dependency.packageName === pkg.name);
    const groupedRepositories = [...new Set(dependencies.map((dependency) => dependency.repositoryId))];
    const rowsResolution = new Map<string, MethodResolution>();
    const buildGraph = () => {
      for (const node of nodes.values()) if (node.occurrence && unsavedSources.has(`${node.occurrence.revision.repositoryId}:${node.occurrence.path}`)) { node.metadata.unsavedEditor = true; node.metadata.indexedBaseline = !node.id.includes("#local-preview"); node.occurrence.revision.dirty = true; }
      const events = [...result.origin.history?.events ?? [], ...result.target.history?.events ?? [], ...result.rows.flatMap((row) => [...row.history?.events ?? [], ...row.relationshipHistory ?? []])];
      const graph: GraphResponse = { ...query.response, queryId: randomUUID(), mode: "impact", focusNodeId: origin.symbol.id, nodes: [...nodes.values()], edges: [...edges.values()], history: [...new Map(events.map((event) => [event.id, event])).values()], freshness: { ...query.response.freshness, partial: Boolean(unsavedSources.size) || !result.complete || result.rows.some((row) => row.current.state === "unknown" || row.target.state === "unknown"), limitations: result.limitations, repositories: [...new Map([...symbols.values()].map((symbol) => [symbol.repositoryId, { repositoryId: symbol.repositoryId, commit: symbol.commit, dirty: [...unsavedSources].some((source) => source.startsWith(`${symbol.repositoryId}:`)) }])).values()] } };
      graph.nodes.find((node) => node.id === origin.symbol.id)!.metadata.methodImpact = true;
      result.graph = this.graphs.remember({ response: graph, symbols: [...symbols.values()], relationships: [], ...(query.anchor ? { anchor: query.anchor } : {}) });
    };
    buildGraph(); progress?.(result);
    await resolver.initialize(signal);
    const knownNames = new Set([origin.owner.type.fqn.toLowerCase()]);
    const originLevel = seed.chain.findIndex((type) => type.symbol.repositoryId === origin.symbol.repositoryId && type.type.fqn === origin.owner.type.fqn);
    for (const type of originLevel >= 0 ? seed.chain.slice(0, originLevel + 1) : seed.chain.slice(0, 1)) knownNames.add(type.type.fqn.toLowerCase());
    for (let pass = 0; pass < 64; pass++) {
      signal?.throwIfAborted(); await new Promise<void>((resolve) => setImmediate(resolve));
      const size = knownNames.size;
      for (const type of resolver.indexedTypes) { const data = type.data as import("./model.js").ParsedType; if ([data.parent, ...data.interfaces, ...data.traits].some((name) => name && knownNames.has(name.toLowerCase()))) knownNames.add(type.fqn.toLowerCase()); }
      if (size === knownNames.size) break;
    }
    for (const repositoryId of groupedRepositories) {
      signal?.throwIfAborted(); await new Promise<void>((resolve) => setImmediate(resolve));
      const basis = this.store.activeGenerationBasis(repositoryId); const dependency = dependencies.find((item) => item.repositoryId === repositoryId)!;
      const manifest = basis ? await resolver.manifest(repositoryId, basis.commit) : undefined;
      const version = request.phpVersion ?? manifest?.phpVersion;
      const consumer = resolver.package(repositoryId)?.name ?? repositoryId;
      const projectId = `project:${repositoryId}`;
      nodes.set(projectId, { id: projectId, kind: "project", label: consumer, subtitle: `${dependency.resolvedVersion ?? "unresolved"} · ${dependency.resolvedSourceCommit?.slice(0, 8) ?? "unknown"}`, metadata: { repositoryId, packageName: pkg.name, impactOverview: true, installedCommit: dependency.resolvedSourceCommit, targetCommit, localPreview: Boolean(localPreview) } });
      const dependencyLinks = await sources.dependency(repositoryId, pkg.name, basis?.commit);
      edges.set(`installed:${repositoryId}`, { id: `installed:${repositoryId}`, source: projectId, target: packageId, type: "requires", label: "Installs package", confidence: "dependency-only", evidence: dependencyLinks.filter((item) => item.path).map((item) => ({ repositoryId, commit: item.commit, path: item.path!, ...(item.range ? { range: item.range } : {}), resolutionMethod: "composer-lock", confidence: "dependency-only" as const, detail: `${consumer} installs ${pkg.name} ${dependency.resolvedVersion ?? dependency.declaredConstraint ?? "unresolved"} at ${dependency.resolvedSourceCommit ?? "an unavailable commit"}`, limitations: ["Installation does not prove method use"] })) });
      const candidates = resolver.indexedTypes.filter((type) => type.repositoryId === repositoryId && type.kind === "class" && knownNames.has(type.fqn.toLowerCase()) && !(type.repositoryId === origin.symbol.repositoryId && type.fqn === origin.owner.type.fqn));
      if (!basis || !candidates.length) {
        result.rows.push({ id: `consumer:${repositoryId}`, repositoryId, consumer, methodName: member, installedVersion: dependency.resolvedVersion ?? dependency.declaredConstraint ?? "Unresolved", installedCommit: dependency.resolvedSourceCommit ?? "Unavailable", relationship: "dependency-only", current: unknown("The repository installs the package, but no relevant indexed descendant declaration was found"), target: unknown("Package installation alone does not prove method use or compatibility"), group: "insufficient-evidence", phpVersion: version ?? "Unknown", phpBasis: request.phpVersion ? "Explicit analysis version" : manifest?.phpBasis ?? "No PHP configuration", inheritancePath: [], callsParent: false, links: await sources.dependency(repositoryId, pkg.name), nodeId: projectId });
        buildGraph(); progress?.(result); continue;
      }
      for (const candidate of candidates) {
        signal?.throwIfAborted();
        const scope = resolver.scope(repositoryId, basis.commit);
        const current = await resolver.resolve(scope, candidate.fqn, member);
        const proposedScope: RevisionScope = { ...scope, ...(targetCommit ? { targets: new Map([[pkg.name, { repositoryId: pkg.repositoryId, commit: targetCommit }]]) } : {}) };
        const proposed = targetCommit ? await resolver.resolve(proposedScope, candidate.fqn, member) : undefined;
        const own = current.chain[0]?.type.methods.find((method) => method.name.toLowerCase() === member.toLowerCase());
        const currentProvider = current.effective;
        const relation = own || currentProvider?.owner.type.kind === "trait" && currentProvider.owner.type.fqn !== origin.owner.type.fqn ? "override" : currentProvider ? "inherits" : "unknown";
        const rootContract = [...current.declarations, ...current.contracts].some((declaration) => declaration.symbol.repositoryId === origin.symbol.repositoryId && declaration.owner.type.fqn.toLowerCase() === origin.owner.type.fqn.toLowerCase());
        const assess = async (resolution: MethodResolution, preview?: ParsedMethod): Promise<ContractAssessment> => {
          if (!version) return unknown("Configure the consumer PHP version before a language-level compatibility conclusion");
          if (!resolution.effective && resolution.contracts.length && !resolution.chain[0]?.type.abstract) return { state: "incompatible", reasons: ["A concrete consumer does not implement the required interface method"] };
          const hasContract = [...resolution.declarations, ...resolution.contracts].some((declaration) => declaration.symbol.repositoryId === origin.symbol.repositoryId && declaration.owner.type.fqn.toLowerCase() === origin.owner.type.fqn.toLowerCase());
          if (!rootContract || !hasContract || !resolution.effective) return unknown(`The exact installed inheritance or implementation could not be resolved. ${resolution.problems.join(" ")}`);
          if (resolution.chain.slice(1).some((type) => type.type.final)) return { state: "incompatible", reasons: ["The inheritance chain extends a final class"] };
          if (resolution.effective.method.abstract && !resolution.chain[0]?.type.abstract) return { state: "incompatible", reasons: ["A concrete consumer has no effective implementation for the abstract method requirement"] };
          const hierarchy = await resolver.hierarchy(resolution.chain[0]!.scope, resolution.declarations.flatMap((declaration) => nativeNames(declaration.method)).concat(resolution.chain.map((type) => type.type.fqn)));
          const assessments: ContractAssessment[] = resolution.problems.length ? [unknown(resolution.problems.join("; "))] : [];
          for (let index = 0; index < resolution.declarations.length - 1; index++) {
            const child = resolution.declarations[index]!, parent = resolution.declarations[index + 1]!;
            const parentMethod = preview && parent.owner.type.fqn === origin.owner.type.fqn ? preview : parent.method;
            assessments.push(assessOverride(child.method, parentMethod, { phpVersion: version, isSubtype: hierarchy, childClassFinal: child.owner.type.final ?? false }));
          }
          for (const contract of resolution.contracts) if (contract.symbol.id !== resolution.effective.symbol.id) assessments.push(assessOverride(resolution.effective.method, preview && contract.owner.type.fqn === origin.owner.type.fqn ? preview : contract.method, { phpVersion: version, isSubtype: hierarchy }));
          const state = assessments.some((item) => item.state === "incompatible") ? "incompatible" : assessments.some((item) => item.state === "unknown") ? "unknown" : assessments.some((item) => item.state === "review") ? "review" : "no-signature-incompatibility";
          return { state, reasons: assessments.flatMap((assessment) => assessment.reasons).concat(!assessments.length ? ["The class inherits the resolved implementation without declaring an override"] : []) };
        };
        const currentAssessment = await assess(current);
        let targetAssessment = proposed ? await assess(proposed, localPreview) : unknown("The proposed package revision is not locally available; no branch or HEAD was substituted");
        if (relation === "inherits" && proposed?.effective && targetAssessment.state === "no-signature-incompatibility" && (localPreview || currentProvider?.method.signatureFingerprint !== proposed.effective.method.signatureFingerprint || currentProvider?.method.implementationFingerprint !== proposed.effective.method.implementationFingerprint)) targetAssessment = { state: "review", reasons: ["The inherited method adopts the proposed contract or implementation unchanged; callers and behaviour require review"] };
        const group = currentAssessment.state === "incompatible" || targetAssessment.state === "incompatible" ? "changes-required" : currentAssessment.state === "unknown" || targetAssessment.state === "unknown" ? "insufficient-evidence" : targetAssessment.state === "review" || currentAssessment.state === "review" ? "review-recommended" : "no-signature-incompatibility";
        const installedContract = [...current.declarations, ...current.contracts].find((declaration) => declaration.owner.type.fqn === origin.owner.type.fqn && declaration.symbol.repositoryId === origin.symbol.repositoryId);
        const row: MethodImpactRow = { id: `${repositoryId}:${candidate.fqn}`, repositoryId, consumer, className: candidate.fqn, methodName: member, installedVersion: dependency.resolvedVersion ?? dependency.declaredConstraint ?? "Unresolved", installedCommit: dependency.resolvedSourceCommit ?? "Unavailable", relationship: relation, current: currentAssessment, target: targetAssessment, group, phpVersion: version ?? "Unknown", phpBasis: request.phpVersion ? "Explicit analysis version" : manifest?.phpBasis ?? "Unknown", ...(installedContract ? { currentSignature: installedContract.method.signature } : {}), ...(targetMethod ? { targetSignature: targetMethod.method.signature } : {}), ...(own ? { consumerSignature: own.signature } : {}), inheritancePath: current.chain.map((type) => ({ name: type.type.fqn, repositoryId: type.symbol.repositoryId, commit: type.symbol.commit, nodeId: type.symbol.id })), ...(currentProvider ? { effectiveImplementation: currentProvider.symbol.fqn } : {}), callsParent: own?.calls.some((call) => call.receiver === "parent" && call.methodName?.toLowerCase() === member.toLowerCase()) ?? false, links: [], nodeId: own && currentProvider ? currentProvider.symbol.id : candidate.id };
        for (const type of current.chain) { symbols.set(type.symbol.id, type.symbol); nodes.set(type.symbol.id, { ...graphNode(type.symbol), metadata: { ...graphNode(type.symbol).metadata, scopeLabel: resolver.package(type.symbol.repositoryId)?.name, impactRowId: row.id } }); }
        for (let index = 0; index < current.chain.length - 1; index++) { const child = current.chain[index]!, parent = current.chain[index + 1]!; const evidence = { ...(currentProvider ?? origin), symbol: child.symbol, method: { ...(currentProvider ?? origin).method, range: child.type.range } }; addEdge(`extends:${child.symbol.id}:${parent.symbol.id}`, child.symbol.id, parent.symbol.id, "extends", "Extends", evidence, `${child.type.fqn} extends ${parent.type.fqn}`); }
        for (const declaration of current.declarations) addMethod(declaration);
        if (currentProvider?.owner.type.kind === "trait" && current.chain[0]) addEdge(`trait:${row.id}`, current.chain[0].symbol.id, currentProvider.owner.symbol.id, "uses-trait", "Uses trait", { ...currentProvider, symbol: current.chain[0].symbol, method: { ...currentProvider.method, range: current.chain[0].type.range } }, `${candidate.fqn} uses ${currentProvider.owner.type.fqn}`);
        for (const contract of current.contracts) { addMethod(contract); addEdge(`interface:${candidate.id}:${contract.symbol.id}`, current.chain[0]!.symbol.id, contract.symbol.id, "implements-method", "Implements contract", currentProvider ?? contract, `${candidate.fqn} implements ${contract.symbol.fqn}`); }
        for (let index = 0; index < current.declarations.length - 1; index++) { const child = current.declarations[index]!, parent = current.declarations[index + 1]!; addEdge(`contract:${child.symbol.id}:${parent.symbol.id}`, child.symbol.id, parent.symbol.id, "overrides", "Overrides parent declaration", child, `${child.symbol.fqn} overrides ${parent.symbol.fqn}`); }
        if (currentProvider) {
          addMethod(currentProvider); row.links.push(link(currentProvider, relation === "inherits" ? "Effective inherited implementation" : "Consumer override"));
          row.links.push(...dependencyLinks);
          for (const caller of current.chain[0]?.type.methods ?? []) {
            for (const call of caller.calls.filter((item) => ["this", "self", "static"].includes(item.receiver ?? "") && item.methodName?.toLowerCase() === member.toLowerCase()).slice(0, 30)) {
              const declaration = resolver.method(current.chain[0]!, caller); addMethod(declaration);
              addEdge(`call:${declaration.symbol.id}:${call.range.startLine}:${call.range.startColumn}`, declaration.symbol.id, currentProvider.symbol.id, "calls", "Calls method", { ...declaration, method: { ...declaration.method, range: call.range } }, `${declaration.symbol.fqn} calls ${currentProvider.symbol.fqn}`, call.receiver === "static" ? "possible" : "confirmed");
            }
          }
          addEdge(`method:${row.id}`, current.chain[0]!.symbol.id, currentProvider.symbol.id, relation === "inherits" ? "inherits" : "declares", relation === "inherits" ? "Inherits unchanged" : "Declares override", currentProvider, `${candidate.fqn} ${relation === "inherits" ? "inherits" : "declares"} ${currentProvider.symbol.fqn}`);
          if (relation === "override" && currentProvider.symbol.id !== origin.symbol.id) addEdge(`override:${row.id}`, currentProvider.symbol.id, origin.symbol.id, "overrides", "Overrides contract", currentProvider, `${currentProvider.symbol.fqn} overrides the package contract even when it does not call parent`);
          if (row.callsParent && current.chain[1]) { const parent = current.chain[1]; const called = (await resolver.resolve(parent.scope, parent.type.fqn, member)).effective; if (called) { addMethod(called); const call = own!.calls.find((item) => item.receiver === "parent" && item.methodName?.toLowerCase() === member.toLowerCase())!; const callOwner = { ...currentProvider, method: { ...currentProvider.method, range: call.range } }; addEdge(`parent-call:${row.id}`, currentProvider.symbol.id, called.symbol.id, "calls-parent", "Calls parent explicitly", callOwner, `${candidate.fqn}::${member} explicitly calls parent::${member}(), resolving to ${called.symbol.fqn}`); } }
          for (const call of currentProvider.method.calls.filter((item) => ["this", "self", "static"].includes(item.receiver ?? "") && item.methodName && item.methodName.toLowerCase() !== member.toLowerCase()).slice(0, 30)) {
            const called = (await resolver.resolve(currentProvider.owner.scope, currentProvider.owner.type.fqn, call.methodName!)).effective;
            if (!called) continue; addMethod(called);
            addEdge(`outgoing:${currentProvider.symbol.id}:${call.range.startLine}:${call.range.startColumn}`, currentProvider.symbol.id, called.symbol.id, "calls", "Calls method", { ...currentProvider, method: { ...currentProvider.method, range: call.range } }, `${currentProvider.symbol.fqn} calls ${called.symbol.fqn}`, call.receiver === "static" ? "possible" : "confirmed");
          }
          const state = request.targetRef || localPreview ? targetAssessment.state : currentAssessment.state;
          const targetNode = targetMethod ?? origin; addMethod(targetNode);
          addEdge(`compatibility:${row.id}`, row.nodeId!, targetNode.symbol.id, state === "incompatible" ? "signature-incompatible" : state === "unknown" ? "signature-unknown" : "signature-compatible", `${request.targetRef || localPreview ? "Target" : "Current"}: ${state}`, currentProvider, `${consumer}: current ${currentAssessment.state}; proposed ${targetAssessment.state}. ${targetAssessment.reasons.join("; ")}`, state === "unknown" ? "unresolved" : state === "review" ? "possible" : "confirmed");
        }
        const type = current.chain[0]; if (type) { row.nodeId ??= type.symbol.id; const evidence = { ...(currentProvider ?? origin), symbol: type.symbol, method: { ...(currentProvider ?? origin).method, range: type.type.range } }; addEdge(`consumer-class:${row.id}`, projectId, type.symbol.id, "declares", "Relevant consumer class", evidence, `${consumer} declares ${candidate.fqn}`); }
        result.rows.push(row); rowsResolution.set(row.id, current);
      }
      buildGraph(); progress?.(result);
    }
    if (targetCommit) result.target.releases = (await git.tagsContaining(targetCommit).catch(() => [])).slice(0, 40);
    if (request.includeHistory) {
      const history = new HistoryService(this.store);
      const summarize = async (method: MethodAt): Promise<DeclarationHistory> => {
        const repo = this.store.repository(method.symbol.repositoryId)!;
        const events = await history.analyze(repo.root, method.symbol, signal, 1000);
        const implementationEvents = events.filter((event) => { if (event.category === "implementation") return true; if (event.category !== "signature" || !event.beforeSource || !event.afterSource) return false; try { const parse = (source: string) => parsePhp(`<?php class HistoryPreview { ${source} }`, "preview.php").types[0]?.methods[0]?.implementationFingerprint; return parse(event.beforeSource) !== parse(event.afterSource); } catch { return false; } });
        const clean = events.map(({ beforeSource: _before, afterSource: _after, ...event }) => event);
        const introduction = clean.find((event) => event.category === "introduction"), signature = clean.filter((event) => event.category === "signature").at(-1), implementation = clean.find((event) => event.id === implementationEvents.at(-1)?.id);
        return { symbolId: method.symbol.id, ...(introduction ? { introduction } : {}), ...(signature ? { signature } : {}), ...(implementation ? { implementation } : {}), events: clean, limitations: [...new Set(clean.flatMap((event) => event.limitations))] };
      };
      result.origin.history = await summarize(origin); buildGraph(); progress?.(result);
      if (targetMethod && !localPreview && targetMethod.symbol.id !== origin.symbol.id) result.target.history = await summarize(targetMethod);
      for (const row of result.rows) {
        const resolution = rowsResolution.get(row.id); const provider = resolution?.effective;
        if (provider && row.relationship === "override") row.history = await summarize(provider);
        const first = resolution?.chain[0];
        if (first) { const repo = this.store.repository(first.symbol.repositoryId)!; const events = await history.analyze(repo.root, first.symbol, signal, 1000); row.relationshipHistory = events.filter((event) => ["introduction", "relationship"].includes(event.category)).map(({ beforeSource: _before, afterSource: _after, ...event }) => event); }
        buildGraph(); progress?.(result);
      }
    }
    result.complete = true; buildGraph(); progress?.(result);
    return result;
  }
}
