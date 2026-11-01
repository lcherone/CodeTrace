import { randomUUID } from "node:crypto";
import type { GraphEdge, GraphNode, GraphResponse, HistoryEvent } from "@trace/contracts";
import { crossRepositoryRelationships, graphNode, GraphService, relationEdge, type QueryState } from "./graph.js";
import type { IndexedSymbol, ParsedMethod, ParsedType } from "./model.js";
import { linkComposerRevisions, resolveRelationships, symbolsFromFiles } from "./relationships.js";
import { SourceNavigation, type SourceLink } from "./source-navigation.js";
import { TraceStore } from "./store.js";
import { GitRepository } from "./git.js";
import { parsePhp } from "./php.js";
import { assessOverride, type ContractAssessment } from "./compatibility.js";

export interface CompatibilityRow {
  consumer: string; method: string; packageName: string; installedVersion: string; installedCommit: string;
  parentSignature?: string; childSignature: string; current: ContractAssessment;
  targetCommit?: string; targetSignature?: string; target: ContractAssessment; links: SourceLink[];
}
export interface CompatibilityResult { itemId: string; rows: CompatibilityRow[]; limitations: string[] }

export interface ExplorerDetails {
  queryId: string; itemId: string; title: string; kind: string; repositoryUrl?: string;
  links: SourceLink[]; preview?: string; sections: Array<{ title: string; text?: string; rows: Array<{ label: string; value: string; nodeId?: string }> }>;
  history: HistoryEvent[]; limitations: string[];
}

export class ExplorationService {
  readonly sources: SourceNavigation;
  constructor(private readonly store: TraceStore, private readonly graphs: GraphService) { this.sources = new SourceNavigation(store); }

  private repositoryId(node: GraphNode): string | undefined {
    if (node.occurrence) return node.occurrence.revision.repositoryId;
    if (node.kind === "project" && node.id.startsWith("project:")) return node.id.slice(8);
    if (typeof node.metadata.repositoryId === "string") return node.metadata.repositoryId;
    if (typeof node.metadata.indexedRepositoryId === "string") return node.metadata.indexedRepositoryId;
    const packageName = typeof node.metadata.packageName === "string" ? node.metadata.packageName : node.label;
    return this.store.activePackages().find((item) => item.name === packageName)?.repositoryId;
  }

  private anchor(query: QueryState): IndexedSymbol | undefined {
    return query.anchor ?? query.symbols.find((item) => item.id === query.response.focusNodeId);
  }

  async compatibility(queryId: string, itemId: string, targetRef?: string): Promise<CompatibilityResult> {
    const query = this.graphs.query(queryId);
    const selected = query.response.nodes.find((node) => node.id === itemId);
    if (!selected) throw new Error("This item is not present in the selected graph");
    const result: CompatibilityResult = { itemId, rows: [], limitations: ["Checks cover supported native PHP signature rules; class subtyping, intersection types, trait adaptations, PHP-version-specific rules, and behaviour may require review", "Consumer state is based on indexed code and lock files, not deployment", ...(targetRef ? [] : ["No proposed target revision was selected"])] };
    if (selected.occurrence?.revision.dirty || selected.metadata.unsavedEditor) { result.limitations.push("Unsaved declaration: exact committed compatibility is unavailable for this local overlay"); return result; }
    const packages = this.store.activePackages(), dependencies = this.store.activeDependencies();
    const methods = query.symbols.filter((item) => item.kind === "method" && (selected.kind === "method" ? item.id === itemId : selected.kind === "class" ? item.classFqn === selected.label : true)).slice(0, 30);
    const files = new Map<string, Promise<ReturnType<typeof parsePhp> | undefined>>();
    const methodAt = async (symbol: IndexedSymbol, revision: string, owner: string, member: string): Promise<ParsedMethod | undefined> => {
      const repository = this.store.repository(symbol.repositoryId);
      if (!repository) return undefined;
      const key = `${symbol.repositoryId}:${revision}:${symbol.path}`;
      let parsed = files.get(key);
      if (!parsed) {
        parsed = new GitRepository(repository.root).show(revision, symbol.path).then((source) => { if (!source) return undefined; try { return parsePhp(source, symbol.path); } catch { return undefined; } });
        files.set(key, parsed);
      }
      return (await parsed)?.types.find((type) => type.fqn.toLowerCase() === owner.toLowerCase())?.methods.find((method) => method.name.toLowerCase() === member.toLowerCase());
    };
    for (const child of methods) {
      const owner = query.symbols.find((item) => item.kind !== "method" && item.fqn === child.classFqn);
      const parentName = (owner?.data as ParsedType | undefined)?.parent;
      if (!parentName) continue;
      const candidates = this.store.activeSymbolsMatchingClasses(packages.map((pkg) => pkg.repositoryId), [parentName], false);
      const parent = candidates.find((candidate) => packages.some((pkg) => pkg.repositoryId === candidate.repositoryId && dependencies.some((dependency) => dependency.repositoryId === child.repositoryId && dependency.packageName === pkg.name)));
      if (!parent) continue;
      const parentPackage = packages.find((pkg) => pkg.repositoryId === parent.repositoryId)!;
      const dependency = dependencies.find((item) => item.repositoryId === child.repositoryId && item.packageName === parentPackage.name)!;
      const installedCommit = dependency.resolvedSourceCommit;
      const childMethod = await methodAt(child, child.commit, child.classFqn!, child.memberName!);
      const installedMethod = installedCommit ? await methodAt(parent, installedCommit, parentName, child.memberName!) : undefined;
      const repository = this.store.repository(parent.repositoryId);
      const targetCommit = targetRef && repository ? await new GitRepository(repository.root).resolveCommit(targetRef) : undefined;
      const targetMethod = targetCommit ? await methodAt(parent, targetCommit, parentName, child.memberName!) : undefined;
      const unknown = (reason: string): ContractAssessment => ({ state: "unknown", reasons: [reason] });
      const row: CompatibilityRow = {
        consumer: packages.find((pkg) => pkg.repositoryId === child.repositoryId)?.name ?? child.repositoryId,
        method: child.fqn, packageName: parentPackage.name,
        installedVersion: dependency.resolvedVersion ?? dependency.declaredConstraint ?? "Unresolved",
        installedCommit: installedCommit ?? "Unavailable", childSignature: childMethod?.signature ?? (child.data as ParsedMethod).signature,
        ...(installedMethod ? { parentSignature: installedMethod.signature } : {}),
        current: childMethod && installedMethod ? assessOverride(childMethod, installedMethod) : unknown("The exact installed parent declaration or child source could not be reconstructed"),
        ...(targetCommit ? { targetCommit } : {}), ...(targetMethod ? { targetSignature: targetMethod.signature } : {}),
        target: targetMethod && childMethod ? assessOverride(childMethod, targetMethod) : unknown(targetRef ? "The proposed declaration could not be resolved in the local Git repository; no revision was substituted" : "Select a proposed package commit, branch, or release"),
        links: [this.sources.link(child.repositoryId, child.commit, child.path, child.range, false, "Consumer override")],
      };
      if (installedMethod && installedCommit) row.links.push(this.sources.link(parent.repositoryId, installedCommit, parent.path, installedMethod.range, false, "Installed parent contract"));
      if (targetMethod && targetCommit) row.links.push(this.sources.link(parent.repositoryId, targetCommit, parent.path, targetMethod.range, false, "Proposed parent contract"));
      result.rows.push(row);
    }
    if (!result.rows.length) result.limitations.push("No reconstructable cross-package override pair is present in this focused view. Explore a relevant consumer class or overriding method.");
    if (methods.length === 30) result.limitations.push("Assessment was bounded to 30 methods in this focused view");
    return result;
  }

  async explore(queryId: string, nodeId: string, signal?: AbortSignal, overview = false): Promise<GraphResponse> {
    const query = this.graphs.query(queryId);
    const selected = query.response.nodes.find((node) => node.id === nodeId);
    if (!selected) throw new Error("This item is not present in the selected graph");
    const repositoryId = this.repositoryId(selected);
    if (!repositoryId) throw new Error("This item has no indexed source repository. Inspect its dependency evidence instead.");
    signal?.throwIfAborted();
    const packages = this.store.activePackages();
    const dependencies = this.store.activeDependencies();
    linkComposerRevisions(packages, dependencies, this.store.packageMappings());
    let local = this.store.activeSymbolsForRepositories([repositoryId], undefined, true);
    const reconstructedSelection = selected.occurrence && this.store.activeGenerationBasis(repositoryId)?.commit !== selected.occurrence.revision.commit;
    if (reconstructedSelection) {
      local = query.symbols.filter((item) => item.repositoryId === repositoryId && item.commit === selected.occurrence!.revision.commit);
      const sourcePackage = packages.find((pkg) => pkg.repositoryId === repositoryId);
      if (sourcePackage) {
        sourcePackage.sourceCommit = selected.occurrence!.revision.commit;
        for (const dependency of dependencies.filter((item) => item.packageName === sourcePackage.name && item.resolvedSourceCommit === selected.occurrence!.revision.commit)) {
          dependency.indexedRepositoryId = repositoryId; dependency.indexedRevision = selected.occurrence!.revision.commit; dependency.resolution = "exact";
        }
      }
    }
    const anchor = this.anchor(query);
    const unsavedPaths = new Set(query.response.nodes.filter((node) => node.metadata.unsavedEditor && node.occurrence).map((node) => `${node.occurrence!.revision.repositoryId}:${node.occurrence!.path}`));
    const anchorOwner = anchor?.kind === "method" ? anchor.classFqn : anchor?.fqn;
    const anchorType = anchor && anchor.kind !== "method" ? anchor : query.symbols.find((item) => item.kind !== "method" && item.fqn === anchorOwner) ?? (anchorOwner && anchor ? this.store.activeSymbolsMatchingClasses([anchor.repositoryId], [anchorOwner], false)[0] : undefined);
    const anchorData = anchorType?.data as ParsedType | undefined;
    const names = new Set([anchorOwner, anchorData?.parent, ...(anchorData?.interfaces ?? [])].filter((item): item is string => Boolean(item)).map((name) => name.toLowerCase()));
    const relatedClassNames = new Set(names);
    // Descendant discovery follows intermediate local classes to a fixed point.
    for (let pass = 0; pass < 32; pass++) {
      const size = relatedClassNames.size;
      for (const type of local.filter((item) => item.kind !== "method")) {
        const data = type.data as ParsedType;
        if ([data.parent, ...data.interfaces].some((name) => name && relatedClassNames.has(name.toLowerCase()))) relatedClassNames.add(type.fqn.toLowerCase());
      }
      if (size === relatedClassNames.size) break;
    }
    const isContainer = selected.kind === "project" || selected.kind === "package-revision";
    const selectedId = typeof selected.metadata.indexedCandidateId === "string" ? selected.metadata.indexedCandidateId : selected.id;
    if (selected.kind === "method" && !reconstructedSelection) local.push(...this.store.activeSymbolsForRepositories([repositoryId], undefined, false, [selectedId]));
    const selectedSymbol = local.find((item) => item.id === selectedId);
    const selectedOwner = selectedSymbol?.kind === "method" ? selectedSymbol.classFqn : selectedSymbol?.fqn;
    let relevant = isContainer
      ? local.filter((item) => relatedClassNames.has((item.classFqn ?? item.fqn).toLowerCase()))
      : local.filter((item) => item.id === selectedId || item.fqn === selectedOwner || item.classFqn === selectedOwner);
    if (!isContainer && selectedOwner) {
      const descendants = new Set([selectedOwner.toLowerCase()]);
      for (let pass = 0; pass < 32; pass++) {
        const size = descendants.size;
        for (const item of local.filter((item) => item.kind !== "method")) {
          const parent = (item.data as ParsedType).parent;
          if (parent && descendants.has(parent.toLowerCase())) descendants.add(item.fqn.toLowerCase());
        }
        if (size === descendants.size) break;
      }
      relevant = local.filter((item) => descendants.has((item.classFqn ?? item.fqn).toLowerCase()));
    }
    const localDeclarations = reconstructedSelection ? [] : this.store.activeSymbolsMatchingClasses([repositoryId], relevant.filter((item) => item.kind !== "method").map((item) => item.fqn));
    relevant = [...new Map([...relevant, ...localDeclarations].map((item) => [item.id, item])).values()];
    local = [...new Map([...local, ...localDeclarations].map((item) => [item.id, item])).values()];
    if (overview) {
      const focus = isContainer ? { ...selected, focused: true, metadata: { ...selected.metadata, repositoryId, explored: true } } : selectedSymbol ? graphNode(selectedSymbol, true) : { ...selected, focused: true };
      focus.metadata.explored = true;
      const nodes = [focus, ...relevant.filter((item) => item.id !== focus.id).map((item) => graphNode(item))].slice(0, 150);
      const ids = new Set(nodes.map((node) => node.id));
      const edges = query.response.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
      for (const node of nodes.filter((node) => node.occurrence)) {
        if (unsavedPaths.has(`${node.occurrence!.revision.repositoryId}:${node.occurrence!.path}`)) node.metadata.unsavedEditor = true;
        node.metadata.scopeLabel = packages.find((pkg) => pkg.repositoryId === node.occurrence!.revision.repositoryId)?.name ?? repositoryId;
        const provider = isContainer && node.kind !== "method" ? focus : nodes.find((candidate) => candidate.kind !== "method" && candidate.label === node.occurrence!.logical.fullyQualifiedName);
        if (!provider || provider.id === node.id || edges.some((edge) => edge.source === provider.id && edge.target === node.id && edge.type === "declares")) continue;
        edges.push({ id: `overview-declares:${provider.id}:${node.id}`, source: provider.id, target: node.id, type: "declares", label: node.kind === "method" ? "Declares method" : "Relevant class", confidence: "confirmed", evidence: [{ repositoryId, commit: node.occurrence!.revision.commit, path: node.occurrence!.path, range: node.occurrence!.range, resolutionMethod: "indexed-declaration", confidence: "confirmed", detail: `${provider.label} declares ${node.label}`, limitations: [] }] });
      }
      return this.graphs.remember({ response: { ...query.response, queryId: randomUUID(), focusNodeId: focus.id, nodes, edges, history: this.store.history(focus.id), freshness: { ...query.response.freshness, partial: true, limitations: ["Focused declarations loaded; parent contracts and wider relationships are loading in the background"] } }, symbols: relevant, relationships: [], ...(anchor ? { anchor } : {}) });
    }
    // Keep referenced contracts at exact indexed dependency revisions only.
    const allowedRepositories = dependencies.filter((item) => !reconstructedSelection && item.repositoryId === repositoryId && item.indexedRepositoryId && item.indexedRevision && !["ambiguous", "unavailable"].includes(item.resolution))
      .filter((item) => packages.some((pkg) => pkg.repositoryId === item.indexedRepositoryId && pkg.sourceCommit === item.indexedRevision)).map((item) => item.indexedRepositoryId!);
    const references = new Set<string>();
    for (const item of relevant.filter((item) => item.kind !== "method")) {
      const data = item.data as ParsedType;
      for (const name of [data.parent, ...data.interfaces, ...data.traits]) if (name) references.add(name);
    }
    let contracts = reconstructedSelection ? [] : this.store.activeSymbolsMatchingClasses([...new Set([repositoryId, ...allowedRepositories])], [...references]);
    const reconstructedIds = new Set<string>();
    // Reconstruct a missing exact locked contract from local Git, never substitute HEAD.
    if (!reconstructedSelection) for (const name of references) {
      if (contracts.some((item) => item.kind !== "method" && item.fqn.toLowerCase() === name.toLowerCase())) continue;
      const candidates = this.store.activeSymbolsMatchingClasses(packages.map((pkg) => pkg.repositoryId), [name], false).filter((item) => item.repositoryId !== repositoryId);
      for (const candidate of candidates) {
        const pkg = packages.find((item) => item.repositoryId === candidate.repositoryId);
        const dependency = pkg && dependencies.find((item) => item.repositoryId === repositoryId && item.packageName === pkg.name && item.resolvedSourceCommit);
        const sourceRepository = this.store.repository(candidate.repositoryId);
        if (!pkg || !dependency?.resolvedSourceCommit || !sourceRepository) continue;
        const source = await new GitRepository(sourceRepository.root).show(dependency.resolvedSourceCommit, candidate.path);
        if (!source) continue;
        try {
          const parsed = parsePhp(source, candidate.path);
          if (!parsed.types.some((type) => type.fqn.toLowerCase() === name.toLowerCase())) continue;
          const exact = symbolsFromFiles(candidate.repositoryId, 0, dependency.resolvedSourceCommit, [parsed]);
          contracts.push(...exact); exact.forEach((item) => reconstructedIds.add(item.id));
          pkg.sourceCommit = dependency.resolvedSourceCommit;
          dependency.indexedRepositoryId = candidate.repositoryId; dependency.indexedRevision = dependency.resolvedSourceCommit; dependency.resolution = "exact";
          break;
        } catch { /* Missing historical syntax remains explicitly unresolved. */ }
      }
    }
    for (let depth = 0; depth < 8; depth++) {
      const next = contracts.filter((item) => item.kind !== "method" && !reconstructedIds.has(item.id)).flatMap((item) => { const data = item.data as ParsedType; return [data.parent, ...data.interfaces, ...data.traits].filter((name): name is string => Boolean(name) && !references.has(name!)); });
      if (!next.length) break;
      next.forEach((name) => references.add(name));
      contracts = [...new Map([...contracts, ...this.store.activeSymbolsMatchingClasses([...new Set([repositoryId, ...allowedRepositories])], next)].map((item) => [item.id, item])).values()];
    }
    // Package-origin drill-down includes exact consumers and their descendant declarations.
    const packageNames = new Set(packages.filter((item) => item.repositoryId === repositoryId).map((item) => item.name));
    const consumers = dependencies.filter((item) => packageNames.has(item.packageName) && item.indexedRepositoryId === repositoryId && item.indexedRevision === local[0]?.commit && !["ambiguous", "unavailable"].includes(item.resolution));
    const consumerSymbols: IndexedSymbol[] = [];
    for (const consumer of consumers) {
      signal?.throwIfAborted();
      const items = this.store.activeSymbolsForRepositories([consumer.repositoryId], undefined, true);
      const targets = new Set(relevant.filter((item) => item.kind !== "method").map((item) => item.fqn.toLowerCase()));
      for (let pass = 0; pass < 32; pass++) {
        const size = targets.size;
        for (const item of items.filter((item) => item.kind !== "method")) {
          const data = item.data as ParsedType;
          if ([data.parent, ...data.interfaces].some((name) => name && targets.has(name.toLowerCase()))) targets.add(item.fqn.toLowerCase());
        }
        if (size === targets.size) break;
      }
      consumerSymbols.push(...this.store.activeSymbolsMatchingClasses([consumer.repositoryId], items.filter((item) => targets.has(item.fqn.toLowerCase())).map((item) => item.fqn)));
    }
    const symbols = [...new Map([...relevant, ...contracts, ...consumerSymbols].map((item) => [item.id, item])).values()];
    let relations = [
      ...resolveRelationships(repositoryId, selectedSymbol?.generation ?? local[0]?.generation ?? 0, selectedSymbol?.commit ?? local[0]?.commit ?? "unknown", local),
      ...this.store.activeRelationshipsForRepositories([...new Set(symbols.map((item) => item.repositoryId))], symbols.map((item) => item.id)),
      ...crossRepositoryRelationships(symbols, packages, dependencies, new Map()),
    ];
    if (selectedSymbol?.kind === "method") {
      const linked = new Set(relations.filter((edge) => edge.sourceId === selectedId || edge.targetId === selectedId).flatMap((edge) => [edge.sourceId, edge.targetId]));
      for (const item of this.store.activeSymbolsForRepositories([repositoryId], undefined, false, [...linked].slice(0, 300))) if (!symbols.some((known) => known.id === item.id)) symbols.push(item);
    }
    const nodes = symbols.map((item) => graphNode(item, item.id === selectedId));
    for (const node of nodes) if (node.occurrence && unsavedPaths.has(`${node.occurrence.revision.repositoryId}:${node.occurrence.path}`)) node.metadata.unsavedEditor = true;
    for (const node of nodes) if (node.occurrence) node.metadata.scopeLabel = packages.find((pkg) => pkg.repositoryId === node.occurrence!.revision.repositoryId)?.name ?? node.occurrence.revision.repositoryId;
    for (const node of nodes) if (reconstructedIds.has(node.id) || reconstructedSelection && node.occurrence?.revision.repositoryId === repositoryId) node.metadata.revisionContext = `Reconstructed from the exact locked Git revision ${node.occurrence?.revision.commit}. The working checkout was not substituted.`;
    if (isContainer) nodes.unshift({ ...selected, focused: true, metadata: { ...selected.metadata, repositoryId } });
    if (!nodes.length) nodes.push({ ...selected, focused: true });
    const edges: GraphEdge[] = [];
    const ids = new Set(nodes.map((node) => node.id));
    const seen = new Set<string>();
    for (const edge of relations) if (ids.has(edge.sourceId) && ids.has(edge.targetId)) {
      const key = `${edge.sourceId}:${edge.targetId}:${edge.type}`;
      if (!seen.has(key)) { edges.push(relationEdge(edge)); seen.add(key); }
    }
    const focusId = isContainer ? selected.id : selectedSymbol?.id ?? selected.id;
    if (isContainer) for (const node of nodes.filter((node) => node.occurrence?.revision.repositoryId === repositoryId && node.kind !== "method")) edges.push({ id: `explorer-owner:${focusId}:${node.id}`, source: focusId, target: node.id, type: "declares", label: "Relevant class", confidence: "confirmed", evidence: [{ repositoryId, commit: node.occurrence!.revision.commit, path: node.occurrence!.path, range: node.occurrence!.range, resolutionMethod: "indexed-declaration", confidence: "confirmed", detail: `${selected.label} declares ${node.label}`, limitations: [] }] });
    this.addInheritedMethods(nodes, edges);
    const relevantPackage = selected.kind === "package-revision" ? (typeof selected.metadata.packageName === "string" ? selected.metadata.packageName : selected.label) : undefined;
    const projectTracePackage = selected.kind === "project" && typeof selected.metadata.packageName === "string" ? selected.metadata.packageName : undefined;
    const scopedDependencies = dependencies.filter((item) => item.repositoryId === repositoryId && (!projectTracePackage || item.packageName === projectTracePackage) || relevantPackage && item.packageName === relevantPackage);
    for (const dependency of scopedDependencies.slice(0, 80)) {
      const projectId = `project:${dependency.repositoryId}`;
      const packageId = relevantPackage === dependency.packageName ? selected.id : `explorer-package:${dependency.repositoryId}:${dependency.packageName}`;
      if (!nodes.some((node) => node.id === projectId)) nodes.push({ id: projectId, kind: "project", label: packages.find((item) => item.repositoryId === dependency.repositoryId)?.name ?? dependency.repositoryId, metadata: { repositoryId: dependency.repositoryId } });
      if (!nodes.some((node) => node.id === packageId)) nodes.push({ id: packageId, kind: "package-revision", label: dependency.packageName, subtitle: dependency.resolvedVersion ?? dependency.declaredConstraint ?? "Unresolved", metadata: { ...dependency, packageName: dependency.packageName, repositoryId: dependency.indexedRepositoryId ?? packages.find((item) => item.name === dependency.packageName)?.repositoryId } });
      const basis = this.store.activeGenerationBasis(dependency.repositoryId);
      edges.push({ id: `explorer-dependency:${projectId}:${packageId}`, source: projectId, target: packageId, type: "requires", label: "Resolves package", confidence: "dependency-only", evidence: [{ repositoryId: dependency.repositoryId, commit: basis?.commit ?? "unknown", path: dependency.resolvedVersion ? "composer.lock" : "composer.json", resolutionMethod: "composer-index", confidence: "dependency-only", detail: `${dependency.repositoryId} resolves ${dependency.packageName} to ${dependency.resolvedVersion ?? dependency.declaredConstraint ?? "an unresolved version"}${dependency.resolvedSourceCommit ? ` (${dependency.resolvedSourceCommit})` : ""}`, limitations: ["Installing the package does not prove use of a class or method"] }] });
    }
    const focus = nodes.find((node) => node.id === focusId) ?? nodes[0]!;
    focus.focused = true;
    focus.metadata.explored = true;
    if (selected.metadata.indexedCandidateId) focus.metadata.revisionContext = `Indexed parent candidate at ${focus.occurrence?.revision.commit ?? "unknown"}; the original consumer installs ${String(selected.metadata.expectedRevision ?? "an unavailable revision")}. This is not an exact installed contract.`;
    const limitations = ["Exploration is bounded to relevant indexed declarations and exact dependency contracts", ...(selected.metadata.indexedCandidateId ? ["This is the indexed parent candidate; its revision differs from the original consumer lock"] : []), ...(!relevant.length ? ["No relevant class declarations were found in this indexed repository"] : [])];
    const containerRank = (node: GraphNode) => ["project", "package-revision"].includes(node.kind) ? 0 : node.kind !== "method" ? 1 : 2;
    const boundedNodes = [focus, ...nodes.filter((node) => node.id !== focus.id).sort((left, right) => containerRank(left) - containerRank(right))].slice(0, 300);
    const boundedIds = new Set(boundedNodes.map((node) => node.id));
    if (nodes.length > 300) limitations.push("Additional declarations are available through narrower class or method exploration");
    signal?.throwIfAborted();
    return this.graphs.remember({ response: { ...query.response, queryId: randomUUID(), focusNodeId: focus.id, nodes: boundedNodes, edges: edges.filter((edge) => boundedIds.has(edge.source) && boundedIds.has(edge.target)).sort((left, right) => Number(right.source === focus.id || right.target === focus.id) - Number(left.source === focus.id || left.target === focus.id)).slice(0, 500), history: this.store.history(focus.id), freshness: { ...query.response.freshness, partial: true, limitations, repositories: [...new Map(symbols.map((item) => [item.repositoryId, { repositoryId: item.repositoryId, commit: item.commit, dirty: false }])).values()] } }, symbols, relationships: relations, ...(anchor ? { anchor } : {}) });
  }

  private addInheritedMethods(nodes: GraphNode[], edges: GraphEdge[]): void {
    for (const child of nodes.filter((node) => node.kind === "class")) {
      const declared = new Set(nodes.filter((node) => node.kind === "method" && node.occurrence?.logical.fullyQualifiedName === child.label).map((node) => node.occurrence?.logical.memberName?.toLowerCase()));
      const visited = new Set<string>();
      let owner = child;
      for (let depth = 0; depth < 32; depth++) {
        const parentEdge = edges.find((edge) => edge.source === owner.id && edge.type === "extends" && edge.confidence === "confirmed");
        const parent = parentEdge && nodes.find((node) => node.id === parentEdge.target);
        if (!parent || visited.has(parent.id)) break;
        visited.add(parent.id);
        for (const method of nodes.filter((node) => node.kind === "method" && node.occurrence?.logical.fullyQualifiedName === parent.label && node.metadata.visibility !== "private")) {
          const name = method.occurrence?.logical.memberName?.toLowerCase();
          if (!name || declared.has(name)) continue;
          declared.add(name);
          const hasTraits = Array.isArray(child.metadata.traits) && child.metadata.traits.length > 0;
          const confidence = hasTraits ? "possible" : "confirmed";
          edges.push({ id: `inherits:${child.id}:${method.id}`, source: child.id, target: method.id, type: "inherits", label: hasTraits ? "May inherit · review traits" : "Inherits unchanged", confidence, evidence: [{ repositoryId: child.occurrence!.revision.repositoryId, commit: child.occurrence!.revision.commit, path: child.occurrence!.path, range: child.occurrence!.range, resolutionMethod: "exact-indexed-parent-chain", confidence, detail: `${child.label} ${hasTraits ? "may inherit" : "inherits"} ${method.label} from ${parent.label}; this is inheritance, not a call`, limitations: ["Trait adaptations and runtime dispatch require additional review"] }] });
        }
        owner = parent;
      }
    }
  }

  async details(queryId: string, itemId: string): Promise<ExplorerDetails> {
    const query = this.graphs.query(queryId);
    const node = query.response.nodes.find((item) => item.id === itemId);
    const edge = query.response.edges.find((item) => item.id === itemId);
    if (!node && !edge) throw new Error("This item is not present in the selected graph");
    const result: ExplorerDetails = { queryId, itemId, title: node?.label ?? edge!.label, kind: node?.kind ?? "relationship", links: [], sections: [], history: [], limitations: [] };
    if (typeof node?.metadata.revisionContext === "string") result.limitations.push(node.metadata.revisionContext);
    if (edge) {
      for (const evidence of edge.evidence) {
        if (edge.type === "requires") {
          const target = query.response.nodes.find((item) => item.id === edge.target);
          if (target) result.links.push(...await this.sources.dependency(evidence.repositoryId, target.label, evidence.commit));
        } else if (evidence.path) result.links.push(this.sources.link(evidence.repositoryId, evidence.commit, evidence.path, evidence.range, query.response.nodes.some((item) => item.occurrence?.revision.repositoryId === evidence.repositoryId && item.occurrence.revision.dirty)));
      }
      return result;
    }
    const repositoryId = this.repositoryId(node!);
    if (repositoryId) {
      const url = this.sources.repositoryUrl(repositoryId);
      if (url) result.repositoryUrl = url;
    }
    if (node!.occurrence) {
      const occurrence = node!.occurrence;
      const context = String(node!.metadata.revisionContext ?? "");
      const link = this.sources.link(occurrence.revision.repositoryId, occurrence.revision.commit, occurrence.path, occurrence.range, occurrence.revision.dirty || Boolean(node!.metadata.unsavedEditor), context.startsWith("Reconstructed") ? "Exact installed contract · reconstructed from Git" : context ? "Indexed candidate source · not the installed contract" : "Indexed declaration");
      result.links.push(link);
      const preview = await this.sources.preview(link);
      if (preview !== undefined) result.preview = preview;
      result.history = this.store.history(node!.id).map(({ beforeSource: _before, afterSource: _after, ...event }) => event);
      const historyRows = ["introduction", "signature", "implementation"].map((category) => {
        const events = result.history.filter((item) => item.category === category);
        const event = category === "introduction" ? events[0] : events.at(-1);
        return { label: category === "introduction" ? "Earliest observed introduction" : `Last ${category} change`, value: event ? `${event.authoredAt.slice(0, 10)} · ${event.commit.slice(0, 12)} · ${event.summary}` : "Not analyzed for this declaration" };
      });
      result.sections.push({ title: "Declaration history", rows: historyRows });
    }
    const packages = this.store.activePackages();
    const dependencies = this.store.activeDependencies();
    if (node!.kind === "project" && repositoryId) {
      const items = dependencies.filter((item) => item.repositoryId === repositoryId);
      result.sections.push({ title: "Resolved dependencies", rows: items.map((item) => ({ label: item.packageName, value: `${item.resolvedVersion ?? item.declaredConstraint ?? "Unresolved"} · ${item.resolvedSourceCommit ?? "No source revision"}`, ...(query.response.nodes.find((candidate) => candidate.kind === "package-revision" && candidate.label === item.packageName) ? { nodeId: query.response.nodes.find((candidate) => candidate.kind === "package-revision" && candidate.label === item.packageName)!.id } : {}) })) });
      const anchor = this.anchor(query);
      const relevantPackages = new Set(query.response.nodes.filter((item) => item.kind === "package-revision" || item.metadata.packageName).map((item) => typeof item.metadata.packageName === "string" ? item.metadata.packageName : item.label));
      if (typeof node!.metadata.packageName === "string") { relevantPackages.clear(); relevantPackages.add(node!.metadata.packageName); }
      const packageName = packages.find((pkg) => pkg.repositoryId === anchor?.repositoryId)?.name;
      if (packageName) relevantPackages.add(packageName);
      for (const item of items.filter((item) => relevantPackages.has(item.packageName)).slice(0, 4)) result.links.push(...await this.sources.dependency(repositoryId, item.packageName));
    }
    if (node!.kind === "package-revision") {
      const packageName = typeof node!.metadata.packageName === "string" ? node!.metadata.packageName : node!.label;
      const pkg = packages.find((item) => item.repositoryId === repositoryId && item.name === packageName);
      const basis = repositoryId && this.store.activeGenerationBasis(repositoryId);
      result.sections.push({ title: "Package source", rows: [{ label: "Repository", value: repositoryId ?? "Not indexed" }, { label: "Indexed source revision", value: basis ? basis.commit : "Not indexed" }, { label: "Selected dependency revision", value: String(node!.metadata.resolvedSourceCommit ?? node!.metadata.expectedRevision ?? "Consumer revisions listed below") }] });
      result.sections.push({ title: "Installed revisions across consumers", rows: dependencies.filter((item) => item.packageName === packageName).map((item) => ({ label: packages.find((pkg) => pkg.repositoryId === item.repositoryId)?.name ?? item.repositoryId, value: `${item.resolvedVersion ?? item.declaredConstraint ?? "Unresolved"} · ${item.resolvedSourceCommit ?? "No source revision"}`, ...(query.response.nodes.some((candidate) => candidate.id === `project:${item.repositoryId}`) ? { nodeId: `project:${item.repositoryId}` } : {}) })) });
      if (repositoryId && basis) result.links.push(this.sources.link(repositoryId, basis.commit, `${pkg?.rootPath ? `${pkg.rootPath}/` : ""}composer.json`, undefined, false, "Package declaration"));
      if (repositoryId && basis) {
        const repository = this.store.repository(repositoryId);
        if (repository) {
          const releases = await new GitRepository(repository.root).tagsContaining(basis.commit).catch(() => [] as string[]);
          result.sections.push({ title: "Relevant releases", text: releases.length ? "Local Git tags containing the indexed package revision. Tags are not deployment proof." : "No local release tag contains this indexed package revision.", rows: releases.slice(0, 40).map((tag) => ({ label: tag, value: `Contains ${basis.commit.slice(0, 12)}` })) });
        }
      }
    }
    const related = query.response.edges.filter((item) => item.source === itemId || item.target === itemId);
    const groups = new Map<string, Array<{ label: string; value: string; nodeId: string }>>();
    for (const relation of related) {
      const outgoing = relation.source === itemId;
      const otherId = outgoing ? relation.target : relation.source;
      const other = query.response.nodes.find((item) => item.id === otherId);
      const group = relation.type === "calls" || relation.type === "calls-parent" ? outgoing ? "Outgoing calls" : "Incoming calls" : relation.type === "inherits" ? "Inherited methods and providers" : relation.type === "overrides" ? outgoing ? "Parent declarations" : "Overrides" : relation.label;
      groups.set(group, [...(groups.get(group) ?? []), { label: other?.label ?? otherId, value: relation.confidence, nodeId: otherId }]);
    }
    for (const [title, rows] of groups) result.sections.push({ title, rows });
    for (const relation of related.filter((item) => item.source === itemId && ["overrides", "implements-method"].includes(item.type))) {
      const parent = query.response.nodes.find((item) => item.id === relation.target);
      if (!parent) continue;
      const events = this.store.history(parent.id);
      result.sections.push({ title: `Parent contract history · ${parent.label}`, rows: [{ label: "Inspect parent declaration", value: String(parent.metadata.signature ?? "Signature unavailable"), nodeId: parent.id }, ...["introduction", "signature", "implementation"].map((category) => {
        const event = category === "introduction" ? events.find((item) => item.category === category) : events.filter((item) => item.category === category).at(-1);
        return { label: category === "introduction" ? "Earliest observed introduction" : `Last ${category} change`, value: event ? `${event.authoredAt.slice(0, 10)} · ${event.commit.slice(0, 12)} · ${event.summary}` : "Not analyzed for this parent declaration" };
      })] });
    }
    result.sections.push({ title: "Compatibility", text: "Current state is evaluated only where the installed parent contract is indexed. Select a proposed package revision before assessing update compatibility. Signature compatibility alone does not establish behavioural safety.", rows: [{ label: "Current contract", value: related.some((item) => ["overrides", "implements-method"].includes(item.type) && item.confidence === "confirmed") ? "Parent contract available for review in Contract provenance" : "Insufficient indexed evidence for a compatibility conclusion" }, { label: "Proposed update", value: "No target package revision selected" }] });
    return result;
  }
}
