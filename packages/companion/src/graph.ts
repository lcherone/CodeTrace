import { randomUUID } from "node:crypto";
import type { GraphEdge, GraphNode, GraphResponse, HistoryEvent, Selection } from "@trace/contracts";
import { PROTOCOL_VERSION } from "@trace/contracts";
import type { ComposerDependency, ComposerPackage, IndexedRelationship, IndexedSymbol, ParsedMethod, ParsedType } from "./model.js";
import { parsePhp } from "./php.js";
import { linkComposerRevisions, resolveRelationships, symbolsFromFiles } from "./relationships.js";
import { TraceStore } from "./store.js";

type Mode = GraphResponse["mode"];

interface ActiveGraphSnapshot {
  key: string;
  symbols: IndexedSymbol[];
  relationships: IndexedRelationship[];
  crossRepositoryRelationships: IndexedRelationship[];
  crossSourceRepositories?: Set<string>;
  packages: ComposerPackage[];
  dependencies: ComposerDependency[];
  mappings: Map<string, string>;
  repositoryCommits: Map<string, string>;
  historyBySymbol?: Map<string, HistoryEvent[]>;
  indexedAt?: string;
  active: boolean;
}

export interface GraphSnapshotData {
  symbols: IndexedSymbol[];
  relationships: IndexedRelationship[];
  packages: ComposerPackage[];
  dependencies: ComposerDependency[];
  mappings?: Map<string, string>;
  repositoryCommits: Map<string, string>;
  historyBySymbol?: Map<string, HistoryEvent[]>;
  indexedAt?: string;
}

export interface QueryState { response: GraphResponse; symbols: IndexedSymbol[]; relationships: IndexedRelationship[]; anchor?: IndexedSymbol }

const label = (type: IndexedRelationship["type"]): string => type.split("-").map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ");

export function graphNode(symbol: IndexedSymbol, focus = false, overlayId?: string): GraphNode {
  const method = symbol.kind === "method" ? symbol.data as ParsedMethod : undefined;
  const type = symbol.kind !== "method" ? symbol.data as ParsedType : undefined;
  const parameters = (method?.parameters ?? []).map((parameter) => {
    const effective = parameter.type ?? parameter.docType;
    return {
      name: parameter.name,
      byReference: parameter.byReference,
      variadic: parameter.variadic,
      ...(effective ? { declaredType: effective.declared, resolvedTypes: effective.resolved, typeSource: effective.source, nullable: effective.nullable, lateStatic: effective.lateStatic } : {}),
      ...(parameter.type && parameter.docType ? { phpDocType: parameter.docType.declared } : {}),
      ...(parameter.description ? { description: parameter.description } : {}),
    };
  });
  const effectiveReturn = method?.returnType ?? method?.docReturnType;
  return {
    id: symbol.id,
    kind: symbol.kind,
    label: method ? `${method.classFqn}::${method.name}` : symbol.fqn,
    subtitle: `${symbol.repositoryId} · ${symbol.commit.slice(0, 8)}`,
    focused: focus,
    occurrence: {
      id: symbol.id,
      logical: { kind: symbol.kind, fullyQualifiedName: symbol.kind === "method" ? method?.classFqn ?? symbol.fqn : symbol.fqn, ...(symbol.memberName ? { memberName: symbol.memberName } : {}) },
      revision: { repositoryId: symbol.repositoryId, commit: symbol.commit, dirty: Boolean(overlayId) },
      path: symbol.path,
      range: symbol.range,
      ...(overlayId ? { overlayId } : {}),
    },
    metadata: method ? {
      visibility: method.visibility,
      static: method.static,
      signature: method.signature,
      ...(method.description ? { description: method.description } : {}),
      ...(method.documentationDetails ? { documentationDetails: method.documentationDetails } : {}),
      parameters,
      ...(effectiveReturn ? { returnType: { declaredType: effectiveReturn.declared, resolvedTypes: effectiveReturn.resolved, typeSource: effectiveReturn.source, nullable: effectiveReturn.nullable, lateStatic: effectiveReturn.lateStatic, ...(method.docReturnType && method.returnType ? { phpDocType: method.docReturnType.declared } : {}), ...(method.returnDescription ? { description: method.returnDescription } : {}) } } : {}),
      lateStaticBindings: method.lateStaticBindings ?? [],
      receiverAnalysis: method.receiverAnalysis ?? [],
    } : {
      ...(type?.description ? { description: type.description } : {}),
      ...(type?.documentationDetails ? { documentationDetails: type.documentationDetails } : {}),
      ...(type?.parent ? { parent: type.parent } : {}),
      ...(type?.interfaces.length ? { interfaces: type.interfaces } : {}),
      ...(type?.traits.length ? { traits: type.traits } : {}),
    },
  };
}

export function relationEdge(relation: IndexedRelationship): GraphEdge {
  return {
    id: relation.id, source: relation.sourceId, target: relation.targetId, type: relation.type,
    label: label(relation.type), confidence: relation.confidence,
    evidence: [{ repositoryId: relation.repositoryId, commit: relation.commit, ...(relation.path ? { path: relation.path } : {}), ...(relation.range ? { range: relation.range } : {}), resolutionMethod: relation.resolutionMethod ?? "static-analysis", confidence: relation.confidence, detail: relation.detail, limitations: relation.limitations }],
  };
}

function methodContractMetadata(method: ParsedMethod): Record<string, unknown> {
  const parameters = (method.parameters ?? []).map((parameter) => {
    const effective = parameter.type ?? parameter.docType;
    return {
      name: parameter.name,
      ...(effective ? { declaredType: effective.declared, resolvedTypes: effective.resolved, typeSource: effective.source, nullable: effective.nullable, lateStatic: effective.lateStatic } : {}),
      ...(parameter.description ? { description: parameter.description } : {}),
    };
  });
  const returned = method.returnType ?? method.docReturnType;
  return {
    signature: method.signature,
    parameters,
    ...(returned ? { returnType: { declaredType: returned.declared, resolvedTypes: returned.resolved, typeSource: returned.source, nullable: returned.nullable, lateStatic: returned.lateStatic, ...(method.returnDescription ? { description: method.returnDescription } : {}) } } : {}),
  };
}

export function crossRepositoryRelationships(symbols: IndexedSymbol[], packages: ComposerPackage[], dependencies: ComposerDependency[], _mappings: Map<string, string>, sourceRepositories?: ReadonlySet<string>): IndexedRelationship[] {
  const existing = new Set<string>();
  const result: IndexedRelationship[] = [];
  const types = symbols.filter((symbol) => symbol.kind !== "method");
  const methods = symbols.filter((symbol) => symbol.kind === "method");
  const dependenciesByRepository = new Map<string, ComposerDependency[]>();
  for (const dependency of dependencies) {
    const owned = dependenciesByRepository.get(dependency.repositoryId) ?? [];
    owned.push(dependency);
    dependenciesByRepository.set(dependency.repositoryId, owned);
  }
  const packagesByRepositoryAndName = new Map(packages.map((item) => [`${item.repositoryId}\0${item.name}`, item]));
  const allowedByRepository = new Map<string, Set<string>>();
  const allowedRepositories = (sourceRepository: string): Set<string> => {
    const cached = allowedByRepository.get(sourceRepository);
    if (cached) return cached;
    const allowed = new Set([sourceRepository]);
    for (const dependency of dependenciesByRepository.get(sourceRepository) ?? []) {
      const targetPackage = dependency.indexedRepositoryId ? packagesByRepositoryAndName.get(`${dependency.indexedRepositoryId}\0${dependency.packageName}`) : undefined;
      if (dependency.indexedRepositoryId && dependency.indexedRevision && targetPackage?.sourceCommit === dependency.indexedRevision && dependency.resolution !== "ambiguous" && dependency.resolution !== "unavailable") allowed.add(dependency.indexedRepositoryId);
    }
    allowedByRepository.set(sourceRepository, allowed);
    return allowed;
  };
  const typesByFqn = new Map<string, IndexedSymbol[]>();
  const methodsByName = new Map<string, IndexedSymbol[]>();
  const typeByRepositoryAndFqn = new Map<string, IndexedSymbol>();
  for (const type of types) {
    const key = type.fqn.toLowerCase();
    const matching = typesByFqn.get(key) ?? [];
    matching.push(type);
    typesByFqn.set(key, matching);
    typeByRepositoryAndFqn.set(`${type.repositoryId}\0${key}`, type);
  }
  for (const method of methods) {
    const key = `${method.classFqn?.toLowerCase()}::${method.memberName?.toLowerCase()}`;
    const matching = methodsByName.get(key) ?? [];
    matching.push(method);
    methodsByName.set(key, matching);
  }
  const candidates = (fqn: string, repositories: Set<string>) => (typesByFqn.get(fqn.toLowerCase()) ?? []).filter((item) => repositories.has(item.repositoryId));
  const methodCandidate = (classFqn: string, method: string, repositories: Set<string>) => (methodsByName.get(`${classFqn.toLowerCase()}::${method.toLowerCase()}`) ?? []).find((item) => repositories.has(item.repositoryId));
  const inheritedMethodCandidate = (classFqn: string, method: string, repositories: Set<string>): IndexedSymbol | undefined => {
    const direct = methodCandidate(classFqn, method, repositories);
    if (direct) return direct;
    const queue = candidates(classFqn, repositories);
    const visited = new Set<string>();
    while (queue.length) {
      const current = queue.shift();
      if (!current || visited.has(current.id)) continue;
      visited.add(current.id);
      const parent = (current.data as ParsedType).parent;
      if (!parent) continue;
      const inherited = methodCandidate(parent, method, repositories);
      if (inherited) return inherited;
      queue.push(...candidates(parent, repositories));
    }
    return undefined;
  };
  for (const type of types) {
    if (sourceRepositories && !sourceRepositories.has(type.repositoryId)) continue;
    const repositories = allowedRepositories(type.repositoryId);
    const data = type.data as any;
    if (data.parent) {
      const parent = candidates(data.parent, repositories).find((item) => item.repositoryId !== type.repositoryId);
      if (parent) {
        const key = `${type.id}|${parent.id}|extends`; existing.add(key);
        result.push({ id: `cross:${key}`, generation: type.generation, repositoryId: type.repositoryId, commit: type.commit, sourceId: type.id, targetId: parent.id, type: "extends", confidence: "confirmed", path: type.path, range: type.range, detail: `${type.fqn} extends exact indexed dependency ${parent.fqn}`, limitations: [] });
      }
    }
    for (const interfaceName of data.interfaces ?? []) {
      const target = candidates(interfaceName, repositories).find((item) => item.repositoryId !== type.repositoryId);
      if (!target) continue;
      const relationshipType = type.kind === "interface" ? "extends" : "implements";
      const key = `${type.id}|${target.id}|${relationshipType}`;
      if (existing.has(key)) continue;
      existing.add(key);
      result.push({ id: `cross:${key}`, generation: type.generation, repositoryId: type.repositoryId, commit: type.commit, sourceId: type.id, targetId: target.id, type: relationshipType, confidence: "confirmed", path: type.path, range: type.range, detail: `${type.fqn} ${relationshipType} exact indexed dependency ${target.fqn}`, limitations: [] });
    }
    for (const traitName of data.traits ?? []) {
      const target = candidates(traitName, repositories).find((item) => item.repositoryId !== type.repositoryId);
      if (!target) continue;
      const key = `${type.id}|${target.id}|uses-trait`;
      result.push({ id: `cross:${key}`, generation: type.generation, repositoryId: type.repositoryId, commit: type.commit, sourceId: type.id, targetId: target.id, type: "uses-trait", confidence: "confirmed", path: type.path, range: type.range, detail: `${type.fqn} uses exact indexed dependency trait ${target.fqn}`, limitations: ["Trait adaptations require additional review"] });
    }
  }
  for (const method of methods) {
    if (sourceRepositories && !sourceRepositories.has(method.repositoryId)) continue;
    const repositories = allowedRepositories(method.repositoryId);
    const owner = typeByRepositoryAndFqn.get(`${method.repositoryId}\0${method.classFqn?.toLowerCase()}`);
    const parentFqn = (owner?.data as any)?.parent as string | undefined;
    const parsed = method.data as ParsedMethod;
    if (parentFqn) {
      const target = inheritedMethodCandidate(parentFqn, method.memberName ?? "", repositories);
      if (target && target.repositoryId !== method.repositoryId) {
        const key = `${method.id}|${target.id}|overrides`;
        result.push({ id: `cross:${key}`, generation: method.generation, repositoryId: method.repositoryId, commit: method.commit, sourceId: method.id, targetId: target.id, type: "overrides", confidence: "confirmed", path: method.path, range: method.range, detail: "Override resolved through exact Composer source commit", limitations: [] });
        if (parsed.calls.some((call) => call.receiver === "parent" && call.methodName?.toLowerCase() === method.memberName?.toLowerCase())) result.push({ id: `cross:${method.id}|${target.id}|calls-parent`, generation: method.generation, repositoryId: method.repositoryId, commit: method.commit, sourceId: method.id, targetId: target.id, type: "calls-parent", confidence: "confirmed", path: method.path, range: method.range, detail: "Explicit parent call resolved through exact Composer source commit", limitations: [] });
      }
    }
    const ownerData = owner?.data as ParsedType | undefined;
    for (const interfaceName of ownerData?.interfaces ?? []) {
      const contract = methodCandidate(interfaceName, method.memberName ?? "", repositories);
      if (contract && contract.repositoryId !== method.repositoryId) result.push({ id: `cross:${method.id}|${contract.id}|implements-method`, generation: method.generation, repositoryId: method.repositoryId, commit: method.commit, sourceId: method.id, targetId: contract.id, type: "implements-method", confidence: "confirmed", path: method.path, range: method.range, detail: `Method contract resolved through exact Composer source commit for ${interfaceName}`, limitations: [] });
    }
    const typeReferences = [
      ...(parsed.parameters ?? []).flatMap((parameter) => parameter.type ?? parameter.docType ? [{ kind: "parameter-type" as const, reference: parameter.type ?? parameter.docType, detail: `$${parameter.name}` }] : []),
      ...(parsed.returnType ?? parsed.docReturnType ? [{ kind: "return-type" as const, reference: parsed.returnType ?? parsed.docReturnType, detail: "return type" }] : []),
    ];
    for (const item of typeReferences) {
      if (!item.reference) continue;
      for (const resolved of item.reference.resolved) {
        const target = candidates(resolved, repositories).find((candidate) => candidate.repositoryId !== method.repositoryId);
        if (!target) continue;
        const confidence = item.reference.source === "phpdoc" || item.reference.lateStatic ? "possible" : "confirmed";
        result.push({
          id: `cross:${method.id}|${target.id}|${item.kind}|${item.detail}`,
          generation: method.generation,
          repositoryId: method.repositoryId,
          commit: method.commit,
          sourceId: method.id,
          targetId: target.id,
          type: item.kind,
          confidence,
          path: method.path,
          range: method.range,
          detail: `${item.detail} ${item.reference.declared} resolves through exact Composer source commit to ${target.fqn}`,
          limitations: item.reference.source === "phpdoc" ? ["PHPDoc types are descriptive and are not enforced by the PHP runtime"] : item.reference.lateStatic ? ["The concrete late-static type depends on the runtime called class"] : [],
        });
      }
    }
    for (const call of parsed.calls) {
      if (!call.methodName || call.confidence === "unresolved" || !["variable", "class"].includes(call.receiver)) continue;
      const candidates = call.classNames?.length ? call.classNames : call.className ? [call.className] : [];
      for (const candidate of new Set(candidates)) {
        const callTarget = inheritedMethodCandidate(candidate, call.methodName, repositories);
        const analysis = parsed.receiverAnalysis?.find((item) => item.range.startLine === call.range.startLine && item.range.startColumn === call.range.startColumn && item.methodName === call.methodName);
        if (!callTarget) {
          const magic = inheritedMethodCandidate(candidate, call.receiver === "class" ? "__callStatic" : "__call", repositories);
          if (analysis && magic) { analysis.status = "unresolved"; analysis.confidence = "unresolved"; analysis.resolutionMethod = "magic-call"; analysis.limitations = [...new Set([...analysis.limitations, `Magic ${call.receiver === "class" ? "__callStatic" : "__call"} dispatch cannot prove a declared target method`])]; }
          else if (analysis && typesByFqn.get(candidate.toLowerCase())?.some((item) => repositories.has(item.repositoryId))) { analysis.status = "unresolved"; analysis.confidence = "unresolved"; analysis.resolutionMethod = "unresolved"; analysis.limitations = [...new Set([...analysis.limitations, `No declared target ${candidate}::${call.methodName} was found`])]; }
          continue;
        }
        if (callTarget.repositoryId === method.repositoryId) continue;
        const confidence = candidates.length === 1 && call.confidence === "confirmed" ? "confirmed" : "possible";
        if (analysis) { analysis.status = candidates.length > 1 ? "ambiguous" : "resolved"; analysis.confidence = confidence; }
        result.push({
          id: `cross:${method.id}|${callTarget.id}|calls|${call.resolutionMethod}`,
          generation: method.generation,
          repositoryId: method.repositoryId,
          commit: method.commit,
          sourceId: method.id,
          targetId: callTarget.id,
          type: "calls",
          confidence,
          path: method.path,
          range: call.range,
          detail: `${call.detail}; candidate ${candidate}; target resolved through exact Composer source commit`,
          limitations: confidence === "possible" ? [...call.limitations, "Static analysis cannot prove one runtime receiver candidate"] : call.limitations,
          resolutionMethod: `receiver-${call.resolutionMethod}`,
        });
      }
    }
  }
  return result;
}

function crossSourceRepositories(focusRepositoryId: string, mode: Mode, packages: ComposerPackage[], dependencies: ComposerDependency[]): Set<string> {
  const selected = new Set([focusRepositoryId]);
  if (mode === "origin" || mode === "history") return selected;
  const packagesByRepositoryAndName = new Map(packages.map((item) => [`${item.repositoryId}\0${item.name}`, item]));
  const neighbours = new Map<string, Set<string>>();
  for (const dependency of dependencies) {
    if (!dependency.indexedRepositoryId || !dependency.indexedRevision || ["ambiguous", "unavailable"].includes(dependency.resolution)) continue;
    const target = packagesByRepositoryAndName.get(`${dependency.indexedRepositoryId}\0${dependency.packageName}`);
    if (!target?.sourceCommit || target.sourceCommit !== dependency.indexedRevision) continue;
    const sourceNeighbours = neighbours.get(dependency.repositoryId) ?? new Set<string>(); sourceNeighbours.add(target.repositoryId); neighbours.set(dependency.repositoryId, sourceNeighbours);
    const targetNeighbours = neighbours.get(target.repositoryId) ?? new Set<string>(); targetNeighbours.add(dependency.repositoryId); neighbours.set(target.repositoryId, targetNeighbours);
  }
  let frontier = new Set(selected);
  const maxDepth = mode === "impact" ? 3 : 1;
  for (let depth = 0; depth < maxDepth && frontier.size; depth++) {
    const next = new Set<string>();
    for (const repositoryId of frontier) for (const neighbour of neighbours.get(repositoryId) ?? []) if (!selected.has(neighbour)) { selected.add(neighbour); next.add(neighbour); }
    frontier = next;
  }
  return selected;
}

function symbolScopeRepositories(sourceRepositories: ReadonlySet<string>, packages: ComposerPackage[], dependencies: ComposerDependency[]): Set<string> {
  const selected = new Set(sourceRepositories);
  const packagesByRepositoryAndName = new Map(packages.map((item) => [`${item.repositoryId}\0${item.name}`, item]));
  for (const dependency of dependencies) {
    if (!sourceRepositories.has(dependency.repositoryId) || !dependency.indexedRepositoryId || !dependency.indexedRevision || ["ambiguous", "unavailable"].includes(dependency.resolution)) continue;
    const target = packagesByRepositoryAndName.get(`${dependency.indexedRepositoryId}\0${dependency.packageName}`);
    if (target?.sourceCommit === dependency.indexedRevision) selected.add(target.repositoryId);
  }
  return selected;
}

function selectedSymbol(selection: Selection, symbols: IndexedSymbol[]): IndexedSymbol | undefined {
  const inPath = symbols.filter((symbol) => symbol.repositoryId === selection.revision.repositoryId && symbol.path === selection.relativePath);
  const containing = inPath.filter((symbol) => symbol.range.startLine <= selection.range.startLine && symbol.range.endLine >= selection.range.endLine)
    .sort((a, b) => (a.range.endLine - a.range.startLine) - (b.range.endLine - b.range.startLine))[0];
  if (containing || !selection.selectedText) return containing;
  const selectedText = selection.selectedText.replace(/^\\/, "").toLowerCase();
  const local = symbols.find((symbol) => symbol.repositoryId === selection.revision.repositoryId && (symbol.memberName?.toLowerCase() === selectedText || symbol.fqn.toLowerCase().endsWith(selectedText)));
  if (local) return local;
  if (!selectedText.includes("\\")) return undefined;
  return symbols.find((symbol) => symbol.fqn.toLowerCase() === selectedText);
}

function qualifiedSelectionHint(selection: Selection): string | undefined {
  const hint = selection.selectedText.replace(/^\\/, "");
  return hint.includes("\\") && !hint.includes("::") ? hint : undefined;
}

function referencedClasses(symbols: readonly IndexedSymbol[]): Set<string> {
  const references = new Set<string>();
  const add = (value?: string) => { if (value) references.add(value.toLowerCase()); };
  for (const symbol of symbols) {
    if (symbol.kind !== "method") {
      const type = symbol.data as ParsedType;
      add(type.parent);
      type.interfaces.forEach(add);
      type.traits.forEach(add);
      continue;
    }
    const method = symbol.data as ParsedMethod;
    for (const parameter of method.parameters ?? []) {
      (parameter.type?.resolved ?? []).forEach(add);
      (parameter.docType?.resolved ?? []).forEach(add);
    }
    (method.returnType?.resolved ?? []).forEach(add);
    (method.docReturnType?.resolved ?? []).forEach(add);
    for (const call of method.calls ?? []) {
      add(call.className);
      (call.classNames ?? []).forEach(add);
    }
  }
  return references;
}

function originSourceSymbols(focus: IndexedSymbol, symbols: readonly IndexedSymbol[]): IndexedSymbol[] {
  const owner = focus.kind === "method" ? focus.classFqn : focus.fqn;
  if (!owner) return [focus];
  return symbols.filter((symbol) => symbol.id === focus.id || symbol.fqn === owner || (symbol.kind === "method" && symbol.classFqn === owner));
}

export class GraphService {
  private readonly queries = new Map<string, QueryState>();
  private snapshotCache: ActiveGraphSnapshot | undefined;
  constructor(private readonly store: TraceStore) {}

  query(queryId: string): QueryState {
    const query = this.queries.get(queryId);
    if (!query) throw new Error("Graph query has expired; run the trace again");
    return query;
  }

  remember(query: QueryState): GraphResponse {
    this.queries.set(query.response.queryId, query);
    if (this.queries.size > 100) this.queries.delete(this.queries.keys().next().value ?? "");
    return query.response;
  }

  private async requestCheckpoint(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve) => setImmediate(resolve));
    signal?.throwIfAborted();
  }

  private async scopedSnapshot(selection: Selection, mode: "origin" | "impact", signal?: AbortSignal): Promise<ActiveGraphSnapshot> {
    const repositoryId = selection.revision.repositoryId;
    const mappingRows = this.store.packageMappings();
    const activeSignature = this.store.activeGenerationSignature();
    const selectionKey = `${selection.relativePath}:${selection.range.startLine}:${selection.range.startColumn}:${selection.selectedText ?? ""}`;
    const key = `${activeSignature}\n${JSON.stringify(mappingRows)}\n${mode}\n${repositoryId}\n${selectionKey}`;
    if (this.snapshotCache?.key === key) return this.snapshotCache;
    await this.requestCheckpoint(signal);
    const packages = this.store.activePackages();
    const dependencies = this.store.activeDependencies();
    linkComposerRevisions(packages, dependencies, mappingRows);
    await this.requestCheckpoint(signal);
    const packagesByRepositoryAndName = new Map(packages.map((item) => [`${item.repositoryId}\0${item.name}`, item]));
    const exactTarget = (dependency: ComposerDependency): ComposerPackage | undefined => {
      if (!dependency.indexedRepositoryId || !dependency.indexedRevision || ["ambiguous", "unavailable"].includes(dependency.resolution)) return undefined;
      const target = packagesByRepositoryAndName.get(`${dependency.indexedRepositoryId}\0${dependency.packageName}`);
      return target?.sourceCommit === dependency.indexedRevision ? target : undefined;
    };
    const sourceRepositories = new Set([repositoryId]);
    if (mode === "impact") for (const dependency of dependencies) if (exactTarget(dependency)?.repositoryId === repositoryId) sourceRepositories.add(dependency.repositoryId);
    const symbols = this.store.activeSymbolsForRepositories([...sourceRepositories]);
    await this.requestCheckpoint(signal);
    let relationships = this.store.activeRelationshipsForRepositories([...sourceRepositories]);
    await this.requestCheckpoint(signal);
    const allowedRepositories = new Set(dependencies.flatMap((dependency) => {
      if (!sourceRepositories.has(dependency.repositoryId)) return [];
      const targetPackage = exactTarget(dependency);
      return targetPackage ? [targetPackage.repositoryId] : [];
    }));
    const qualifiedHint = qualifiedSelectionHint(selection);
    if (!selectedSymbol(selection, symbols) && qualifiedHint) symbols.push(...this.store.activeSymbolsMatchingClasses([...allowedRepositories], [qualifiedHint]));
    const focus = selectedSymbol(selection, symbols);
    if (focus) {
      const loadedIds = new Set(symbols.map((symbol) => symbol.id));
      const externalRepositories = new Set<string>();
      let pending = referencedClasses(originSourceSymbols(focus, symbols));
      const inspectedReferences = new Set<string>();
      for (let depth = 0; depth < 3 && pending.size; depth++) {
        const nextReferences = [...pending].filter((item) => !inspectedReferences.has(item)).slice(0, 128);
        if (!nextReferences.length) break;
        nextReferences.forEach((item) => inspectedReferences.add(item));
        const matches = this.store.activeSymbolsMatchingClasses([...allowedRepositories], nextReferences);
        const added = matches.filter((symbol) => !loadedIds.has(symbol.id));
        for (const symbol of added) { loadedIds.add(symbol.id); externalRepositories.add(symbol.repositoryId); symbols.push(symbol); }
        pending = referencedClasses(added);
        await this.requestCheckpoint(signal);
      }
      if (externalRepositories.size) relationships = relationships.concat(this.store.activeRelationshipsForRepositories([...externalRepositories]));
    }
    await this.requestCheckpoint(signal);
    const mappings = new Map(mappingRows.map((item) => [item.packageName, item.repositoryId]));
    const repositoryCommits = new Map<string, string>();
    for (const symbol of symbols) if (!repositoryCommits.has(symbol.repositoryId)) repositoryCommits.set(symbol.repositoryId, symbol.commit);
    const snapshot: ActiveGraphSnapshot = { key, symbols, relationships, crossRepositoryRelationships: crossRepositoryRelationships(symbols, packages, dependencies, mappings, sourceRepositories), crossSourceRepositories: sourceRepositories, packages, dependencies, mappings, repositoryCommits, active: true };
    await this.requestCheckpoint(signal);
    this.snapshotCache = snapshot;
    return snapshot;
  }

  private snapshot(selection: Selection, mode: Mode): ActiveGraphSnapshot {
    const repositoryId = selection.revision.repositoryId;
    const mappingRows = this.store.packageMappings();
    const activeSignature = this.store.activeGenerationSignature();
    const selectionKey = mode === "origin" ? `${selection.relativePath}:${selection.range.startLine}:${selection.range.startColumn}:${selection.selectedText ?? ""}` : "";
    const originKey = `${activeSignature}\n${JSON.stringify(mappingRows)}\n${mode}\n${repositoryId}\n${selectionKey}`;
    if (mode === "origin" && this.snapshotCache?.key === originKey) return this.snapshotCache;
    const packages = this.store.activePackages();
    const dependencies = this.store.activeDependencies();
    linkComposerRevisions(packages, dependencies, mappingRows);
    const sourceRepositories = crossSourceRepositories(repositoryId, mode, packages, dependencies);
    const symbolRepositories = symbolScopeRepositories(sourceRepositories, packages, dependencies);
    const key = mode === "origin" ? originKey : `${activeSignature}\n${JSON.stringify(mappingRows)}\n${mode}\n${[...symbolRepositories].sort().join("|")}\n${selectionKey}`;
    if (this.snapshotCache?.key === key) return this.snapshotCache;
    let symbols: IndexedSymbol[];
    let relationships: IndexedRelationship[];
    if (mode === "origin") {
      // Origin traces only need the selected repository plus exact dependency
      // classes referenced by the selected class/method contract. Loading every
      // symbol from hundreds of installed packages made this synchronous path
      // block the HTTP event loop for tens of seconds.
      symbols = this.store.activeSymbolsForRepositories([repositoryId]);
      relationships = this.store.activeRelationshipsForRepositories([repositoryId]);
      const packagesByRepositoryAndName = new Map(packages.map((item) => [`${item.repositoryId}\0${item.name}`, item]));
      const allowedRepositories = new Set(dependencies.flatMap((dependency) => {
        if (dependency.repositoryId !== repositoryId || !dependency.indexedRepositoryId || !dependency.indexedRevision || ["ambiguous", "unavailable"].includes(dependency.resolution)) return [];
        const targetPackage = packagesByRepositoryAndName.get(`${dependency.indexedRepositoryId}\0${dependency.packageName}`);
        return targetPackage?.sourceCommit === dependency.indexedRevision ? [dependency.indexedRepositoryId] : [];
      }));
      const qualifiedHint = qualifiedSelectionHint(selection);
      if (!selectedSymbol(selection, symbols) && qualifiedHint) symbols.push(...this.store.activeSymbolsMatchingClasses([...allowedRepositories], [qualifiedHint]));
      const focus = selectedSymbol(selection, symbols);
      if (focus) {
        const loadedIds = new Set(symbols.map((symbol) => symbol.id));
        const externalRepositories = new Set<string>();
        let pending = referencedClasses(originSourceSymbols(focus, symbols));
        const inspectedReferences = new Set<string>();
        for (let depth = 0; depth < 3 && pending.size; depth++) {
          const nextReferences = [...pending].filter((item) => !inspectedReferences.has(item)).slice(0, 128);
          if (!nextReferences.length) break;
          nextReferences.forEach((item) => inspectedReferences.add(item));
          const matches = this.store.activeSymbolsMatchingClasses([...allowedRepositories], nextReferences);
          const added = matches.filter((symbol) => !loadedIds.has(symbol.id));
          for (const symbol of added) { loadedIds.add(symbol.id); externalRepositories.add(symbol.repositoryId); symbols.push(symbol); }
          pending = referencedClasses(added);
        }
        if (externalRepositories.size) relationships = relationships.concat(this.store.activeRelationshipsForRepositories([...externalRepositories]));
      }
    } else {
      symbols = this.store.activeSymbolsForRepositories([...symbolRepositories]);
      relationships = this.store.activeRelationshipsForRepositories([...symbolRepositories]);
    }
    const mappings = new Map(mappingRows.map((item) => [item.packageName, item.repositoryId]));
    const repositoryCommits = new Map<string, string>();
    for (const symbol of symbols) if (!repositoryCommits.has(symbol.repositoryId)) repositoryCommits.set(symbol.repositoryId, symbol.commit);
    this.snapshotCache = { key, symbols, relationships, crossRepositoryRelationships: mode === "history" ? [] : crossRepositoryRelationships(symbols, packages, dependencies, mappings, sourceRepositories), crossSourceRepositories: sourceRepositories, packages, dependencies, mappings, repositoryCommits, active: true };
    return this.snapshotCache;
  }

  trace(selection: Selection, mode: Mode, limit = 100): GraphResponse {
    return this.traceWithSnapshot(selection, mode, this.snapshot(selection, mode), limit, false);
  }

  overview(selection: Selection, limit = 100): GraphResponse {
    const repositoryId = selection.revision.repositoryId;
    const symbols = this.store.activeSymbolsForRepositories([repositoryId], selection.relativePath);
    const snapshot: ActiveGraphSnapshot = {
      key: "overview", symbols, relationships: [], crossRepositoryRelationships: [],
      packages: this.store.activePackages(), dependencies: this.store.activeDependencies(), mappings: new Map(),
      repositoryCommits: new Map([[repositoryId, selection.revision.commit]]), active: true,
    };
    const response = this.traceWithSnapshot(selection, "impact", snapshot, limit, false, true);
    response.freshness.partial = true;
    response.freshness.limitations.push("Overview loaded; wider impact relationships are loading in the background");
    return response;
  }

  async traceAsync(selection: Selection, mode: Mode, limit = 100, signal?: AbortSignal): Promise<GraphResponse> {
    const snapshot = mode === "origin" || mode === "impact" ? await this.scopedSnapshot(selection, mode, signal) : this.snapshot(selection, mode);
    signal?.throwIfAborted();
    return this.traceWithSnapshot(selection, mode, snapshot, limit, false);
  }

  traceSnapshot(selection: Selection, mode: Mode, data: GraphSnapshotData, limit = 100): GraphResponse {
    const mappings = data.mappings ?? new Map<string, string>();
    const snapshot: ActiveGraphSnapshot = {
      key: `temporal:${[...data.repositoryCommits].sort().map(([repositoryId, commit]) => `${repositoryId}@${commit}`).join("|")}`,
      ...data,
      mappings,
      crossRepositoryRelationships: crossRepositoryRelationships(data.symbols, data.packages, data.dependencies, mappings),
      active: false,
    };
    return this.traceWithSnapshot(selection, mode, snapshot, limit, true);
  }

  private traceWithSnapshot(selection: Selection, mode: Mode, snapshot: ActiveGraphSnapshot, limit: number, exhaustive: boolean, overview = false): GraphResponse {
    let symbols = snapshot.symbols;
    let relationships = snapshot.relationships;
    const { packages, dependencies, mappings } = snapshot;
    let overlayId: string | undefined;
    if (selection.documentText !== undefined) {
      overlayId = `${selection.revision.repositoryId}:${selection.relativePath}:${selection.documentVersion ?? 0}`;
      const generation = symbols.find((symbol) => symbol.repositoryId === selection.revision.repositoryId)?.generation ?? 0;
      const parsed = parsePhp(selection.documentText, selection.relativePath);
      const overlay = symbolsFromFiles(selection.revision.repositoryId, generation, selection.revision.commit, [parsed]).map((symbol) => ({ ...symbol, id: `${symbol.id}#overlay:${selection.documentVersion ?? 0}` }));
      symbols = symbols.filter((symbol) => !(symbol.repositoryId === selection.revision.repositoryId && symbol.path === selection.relativePath)).concat(overlay);
      relationships = relationships.filter((relation) => !relation.sourceId.includes(`${selection.revision.repositoryId}@${selection.revision.commit}`)).concat(resolveRelationships(selection.revision.repositoryId, generation, selection.revision.commit, symbols.filter((symbol) => symbol.repositoryId === selection.revision.repositoryId)));
    }
    const focus = selectedSymbol(selection, symbols);
    if (!focus) throw new Error("No indexed symbol contains this selection");
    if (snapshot.active) {
      const crossRelationships = overlayId ? crossRepositoryRelationships(symbols, packages, dependencies, mappings, snapshot.crossSourceRepositories) : snapshot.crossRepositoryRelationships;
      relationships = relationships.concat(crossRelationships);
    } else relationships = relationships.concat(snapshot.crossRepositoryRelationships);

    const focusType = focus.kind === "method" ? undefined : focus.data as ParsedType;
    const declaredParent = focusType?.parent;
    const focusDependencyPackages = new Set(dependencies.filter((item) => item.repositoryId === focus.repositoryId).map((item) => item.packageName));
    const parentCandidate = snapshot.active && declaredParent
      ? this.store.activeSymbolsMatchingClasses([...new Set(packages.map((item) => item.repositoryId))], [declaredParent], false).find((item) => {
        const candidatePackage = packages.find((pkg) => pkg.repositoryId === item.repositoryId);
        return item.kind !== "method" && item.repositoryId !== focus.repositoryId && Boolean(candidatePackage && focusDependencyPackages.has(candidatePackage.name));
      })
      : undefined;
    const parentPackage = parentCandidate ? packages.find((item) => item.repositoryId === parentCandidate.repositoryId) : undefined;
    const parentConsumers = mode === "impact" && parentPackage
      ? dependencies.filter((item) => item.packageName === parentPackage.name)
      : [];
    const narrativeReserve = parentConsumers.length ? parentConsumers.length + 2 : 0;

    const edgeAllowed = (edge: IndexedRelationship) => {
      if (mode === "origin") return ["overrides", "implements-method", "inherits", "extends", "implements", "uses-trait", "calls-parent", "declares", "parameter-type", "return-type", "late-static-binding"].includes(edge.type);
      if (mode === "inheritance") return ["declares", "overrides", "implements-method", "inherits", "extends", "implements", "uses-trait", "parameter-type", "return-type", "late-static-binding"].includes(edge.type);
      if (mode === "callers") return ["calls", "calls-parent"].includes(edge.type);
      if (mode === "consumers") return ["overrides", "calls"].includes(edge.type);
      if (mode === "history") return ["changed-in", "included-in-release"].includes(edge.type);
      return true;
    };
    const selectedEdges: IndexedRelationship[] = [];
    const selectedEdgeIds = new Set<string>();
    let frontier = new Set([focus.id]);
    const seen = new Set(frontier);
    let depth = 0;
    let edgeLimitTruncated = false;
    while (frontier.size && (exhaustive || depth < 3) && selectedEdges.length < limit) {
      const next = new Set<string>();
      for (const edge of relationships) if (edgeAllowed(edge) && (frontier.has(edge.sourceId) || frontier.has(edge.targetId))) {
        if (!selectedEdgeIds.has(edge.id)) {
          if (selectedEdges.length >= limit) { edgeLimitTruncated = true; continue; }
          selectedEdges.push(edge); selectedEdgeIds.add(edge.id);
        }
        if (!seen.has(edge.sourceId)) next.add(edge.sourceId);
        if (!seen.has(edge.targetId)) next.add(edge.targetId);
      }
      next.forEach((value) => seen.add(value)); frontier = next; depth++;
    }
    if (selectedEdges.length >= limit && relationships.some((edge) => edgeAllowed(edge) && !selectedEdgeIds.has(edge.id) && (frontier.has(edge.sourceId) || frontier.has(edge.targetId)))) edgeLimitTruncated = true;
    const depthTruncated = !exhaustive && depth >= 3 && relationships.some((edge) => edgeAllowed(edge) && !selectedEdgeIds.has(edge.id) && (frontier.has(edge.sourceId) || frontier.has(edge.targetId)));
    const visibleSymbols = [focus, ...symbols.filter((symbol) => symbol.id !== focus.id && seen.has(symbol.id))];
    let nodeLimitTruncated = visibleSymbols.length > limit;
    const symbolLimit = Math.max(1, limit - narrativeReserve);
    const nodes = visibleSymbols.slice(0, symbolLimit).map((symbol) => graphNode(symbol, symbol.id === focus?.id, symbol.id.includes("#overlay:") ? overlayId : undefined));
    for (const node of nodes) {
      const contractSources = selectedEdges.flatMap((edge) => {
        if (edge.sourceId !== node.id || !["overrides", "implements-method"].includes(edge.type)) return [];
        const target = symbols.find((symbol) => symbol.id === edge.targetId && symbol.kind === "method");
        if (!target) return [];
        return [{ relationship: edge.type, symbol: target.fqn, ...methodContractMetadata(target.data as ParsedMethod) }];
      });
      if (contractSources.length) node.metadata.contractSources = contractSources;
    }
    const edges = selectedEdges.filter((edge) => nodes.some((node) => node.id === edge.sourceId) && nodes.some((node) => node.id === edge.targetId)).map(relationEdge);

    if (declaredParent && parentCandidate && parentPackage && parentConsumers.length) {
      const parentId = `declared-parent:${focus.id}:${declaredParent.toLowerCase()}`;
      const packageId = `package-family:${parentPackage.name}`;
      const exactConsumer = parentConsumers.find((item) => item.repositoryId === focus.repositoryId);
      const expectedRevision = exactConsumer?.resolvedSourceCommit ?? exactConsumer?.indexedRevision;
      const exactRevisionAvailable = Boolean(expectedRevision && parentCandidate.commit === expectedRevision);
      nodes.push({
        id: parentId,
        kind: parentCandidate.kind,
        label: declaredParent,
        subtitle: exactRevisionAvailable ? "Parent class" : "Parent class · revision not indexed",
        metadata: {
          storyRole: "parent",
          packageName: parentPackage.name,
          declaredBy: focus.fqn,
          expectedRevision,
          indexedRevision: parentCandidate.commit,
          indexedCandidateId: parentCandidate.id,
          repositoryId: parentCandidate.repositoryId,
          symbolAnalysis: exactRevisionAvailable ? "available" : "unavailable-for-exact-revision",
        },
      });
      nodes.push({
        id: packageId,
        kind: "package-revision",
        label: parentPackage.name,
        subtitle: `${parentConsumers.length} dependent project${parentConsumers.length === 1 ? "" : "s"}`,
        metadata: { storyRole: "parent-package", packageName: parentPackage.name, consumers: parentConsumers.map((item) => ({ repositoryId: item.repositoryId, version: item.resolvedVersion, revision: item.resolvedSourceCommit, resolution: item.resolution })) },
      });
      edges.push({
        id: `declared-parent:${focus.id}:${parentId}`,
        source: focus.id,
        target: parentId,
        type: "extends",
        label: "Parent",
        confidence: exactRevisionAvailable ? "confirmed" : "unresolved",
        evidence: [{ repositoryId: focus.repositoryId, commit: focus.commit, path: focus.path, range: focus.range, resolutionMethod: exactRevisionAvailable ? "composer-package-and-symbol-index" : "php-declaration-and-composer-lock", confidence: exactRevisionAvailable ? "confirmed" : "unresolved", detail: exactRevisionAvailable ? `${focus.fqn} extends the exact indexed ${declaredParent}` : `${focus.fqn} declares ${declaredParent}, but ${parentPackage.name} is locked at ${expectedRevision ?? "an unavailable revision"} while the indexed parent symbol is ${parentCandidate.commit}`, limitations: exactRevisionAvailable ? [] : ["The declared parent is confirmed, but symbol analysis for the exact locked package revision is unavailable"] }],
      });
      edges.push({
        id: `package-parent:${packageId}:${parentId}`,
        source: packageId,
        target: parentId,
        type: "declares",
        label: "Provides parent",
        confidence: exactRevisionAvailable ? "confirmed" : "unresolved",
        evidence: [{ repositoryId: parentPackage.repositoryId, commit: parentCandidate.commit, path: parentCandidate.path, range: parentCandidate.range, resolutionMethod: "package-symbol-candidate", confidence: exactRevisionAvailable ? "confirmed" : "unresolved", detail: `${parentPackage.name} contains the indexed candidate for ${declaredParent}`, limitations: exactRevisionAvailable ? [] : ["The indexed package candidate is from a different revision than the selected project lock"] }],
      });
      for (const dependency of parentConsumers) {
        const projectId = `project:${dependency.repositoryId}`;
        const consumerPackage = packages.find((item) => item.repositoryId === dependency.repositoryId);
        const existing = nodes.find((node) => node.id === projectId);
        if (existing) {
          existing.label = consumerPackage?.name ?? dependency.repositoryId;
          existing.subtitle = `Uses ${parentPackage.name} ${dependency.resolvedVersion ?? dependency.declaredConstraint ?? ""}`.trim();
          existing.metadata = { ...existing.metadata, storyRole: "consumer-project", packageName: parentPackage.name };
        } else nodes.push({ id: projectId, kind: "project", label: consumerPackage?.name ?? dependency.repositoryId, subtitle: `Uses ${parentPackage.name} ${dependency.resolvedVersion ?? dependency.declaredConstraint ?? ""}`.trim(), metadata: { storyRole: "consumer-project", packageName: parentPackage.name, symbolUsage: "dependency-only" } });
        edges.push({
          id: `parent-package-consumer:${dependency.repositoryId}:${parentPackage.name}`,
          source: projectId,
          target: packageId,
          type: "requires",
          label: "Uses package",
          confidence: "dependency-only",
          evidence: [{ repositoryId: dependency.repositoryId, commit: symbols.find((item) => item.repositoryId === dependency.repositoryId)?.commit ?? "unknown", resolutionMethod: dependency.resolvedSourceCommit ? "composer-lock" : "composer-json", confidence: "dependency-only", detail: `${dependency.repositoryId} resolves ${parentPackage.name} ${dependency.resolvedVersion ?? dependency.declaredConstraint ?? ""}`.trim(), limitations: ["Package installation identifies potential impact; it does not prove this class executes at runtime"] }],
        });
      }
    }

    if (!overview && ["consumers", "impact"].includes(mode)) {
      // A consumer-local override can focus the query while the package-owned parent is
      // elsewhere in the selected neighbourhood. Resolve consumer packages from every
      // symbol already in that neighbourhood instead of assuming the focus is package-owned.
      const visibleSymbolIds = new Set(nodes.map((node) => node.id));
      const visibleRepositories = new Set(nodes.flatMap((node) => node.occurrence ? [node.occurrence.revision.repositoryId] : []));
      const relevantPackages = packages.filter((pkg) => visibleRepositories.has(pkg.repositoryId) && dependencies.some((dependency) => dependency.indexedRepositoryId === pkg.repositoryId && dependency.packageName === pkg.name));
      for (const targetPackage of relevantPackages) for (const dependency of dependencies.filter((item) => item.indexedRepositoryId === targetPackage.repositoryId && item.packageName === targetPackage.name)) {
        const projectId = `project:${dependency.repositoryId}`;
        const resolvedRevision = dependency.resolvedSourceCommit ?? dependency.indexedRevision ?? dependency.resolvedDistReference ?? `${dependency.packageName}:${dependency.resolvedVersion ?? dependency.declaredConstraint ?? "unresolved"}`;
        const packageId = `package:${targetPackage.repositoryId}:${targetPackage.name}:${resolvedRevision}`;
        const consumerCommit = symbols.find((symbol) => symbol.repositoryId === dependency.repositoryId)?.commit ?? "unknown";
        const exactIndexedRevision = Boolean(dependency.indexedRevision && targetPackage.sourceCommit && dependency.indexedRevision === targetPackage.sourceCommit && !["ambiguous", "unavailable"].includes(dependency.resolution));
        const usageRelations = selectedEdges.filter((relationship) => {
          const source = symbols.find((symbol) => symbol.id === relationship.sourceId);
          const target = symbols.find((symbol) => symbol.id === relationship.targetId);
          return source?.repositoryId === dependency.repositoryId && target?.repositoryId === targetPackage.repositoryId && ["calls", "calls-parent", "overrides"].includes(relationship.type);
        });
        if (!nodes.some((node) => node.id === projectId)) nodes.push({
          id: projectId,
          kind: "project",
          label: dependency.repositoryId,
          metadata: { symbolUsage: usageRelations.length ? "confirmed" : "dependency-only" },
        });
        if (!nodes.some((node) => node.id === packageId)) nodes.push({
          id: packageId,
          kind: "package-revision",
          label: targetPackage.name,
          subtitle: dependency.resolvedVersion ?? dependency.declaredConstraint ?? "unresolved",
          metadata: {
            declaredConstraint: dependency.declaredConstraint,
            declaredConstraintBase: dependency.declaredConstraintBase,
            declaredAlias: dependency.declaredAlias,
            resolvedVersion: dependency.resolvedVersion,
            resolvedSourceReference: dependency.resolvedSourceReference,
            resolvedSourceUrl: dependency.resolvedSourceUrl,
            resolvedDistReference: dependency.resolvedDistReference,
            resolvedDistUrl: dependency.resolvedDistUrl,
            resolvedPath: dependency.resolvedPath,
            branchAliases: targetPackage.branchAliases ?? {},
            repositoryCandidates: dependency.repositoryCandidates ?? [],
            resolvedSourceCommit: dependency.resolvedSourceCommit,
            indexedRepositoryId: dependency.indexedRepositoryId,
            indexedRevision: dependency.indexedRevision,
            resolution: dependency.resolution,
            resolutionMethod: dependency.resolutionMethod,
            resolutionEvidence: dependency.resolutionEvidence,
            symbolAnalysis: exactIndexedRevision ? "available" : "unavailable-for-exact-revision",
          },
        });
        edges.push({
          id: `dependency:${dependency.repositoryId}:${targetPackage.name}:${resolvedRevision}`,
          source: projectId,
          target: packageId,
          type: "requires",
          label: "Requires",
          confidence: "dependency-only",
          evidence: [{
            repositoryId: dependency.repositoryId,
            commit: consumerCommit,
            resolutionMethod: dependency.resolvedSourceCommit || dependency.resolvedDistReference ? "composer-lock" : "composer-json",
            confidence: "dependency-only",
            detail: dependency.resolvedSourceCommit ? `Lock file resolves ${targetPackage.name} source to ${dependency.resolvedSourceCommit}` : dependency.resolvedDistReference ? `Lock file resolves ${targetPackage.name} distribution to ${dependency.resolvedDistReference}` : `Manifest declares ${targetPackage.name} ${dependency.declaredConstraint ?? ""}`,
            limitations: ["Package installation is not proof that this symbol is called"],
          }],
        });
        if (exactIndexedRevision) {
          const packageSymbol = nodes.find((node) => node.occurrence?.revision.repositoryId === targetPackage.repositoryId);
          if (packageSymbol) edges.push({
            id: `package-declares:${packageId}:${packageSymbol.id}`,
            source: packageId,
            target: packageSymbol.id,
            type: "declares",
            label: "Declares",
            confidence: "confirmed",
            evidence: [{ repositoryId: targetPackage.repositoryId, commit: targetPackage.sourceCommit ?? "unknown", resolutionMethod: "composer-package-and-symbol-index", confidence: "confirmed", detail: `${targetPackage.name} at the exact indexed source revision declares this symbol`, limitations: [] }],
          });
        }
        for (const usage of usageRelations) if (visibleSymbolIds.has(usage.sourceId)) edges.push({
          id: `project-declares:${projectId}:${usage.sourceId}`,
          source: projectId,
          target: usage.sourceId,
          type: "declares",
          label: "Declares confirmed use",
          confidence: "confirmed",
          evidence: [{ repositoryId: dependency.repositoryId, commit: consumerCommit, ...(usage.path ? { path: usage.path } : {}), ...(usage.range ? { range: usage.range } : {}), resolutionMethod: "indexed-symbol-relationship", confidence: "confirmed", detail: "This project declares a symbol with a confirmed static relationship to the package symbol", limitations: ["Static analysis does not prove runtime execution"] }],
        });
      }
      for (const dependency of dependencies.filter((item) => visibleRepositories.has(item.repositoryId))) {
        const resolvedRevision = dependency.resolvedSourceCommit ?? dependency.indexedRevision ?? dependency.resolvedDistReference ?? `${dependency.packageName}:${dependency.resolvedVersion ?? dependency.declaredConstraint ?? "unresolved"}`;
        const edgeId = `dependency:${dependency.repositoryId}:${dependency.packageName}:${resolvedRevision}`;
        if (edges.some((edge) => edge.id === edgeId)) continue;
        const targetPackage = packages.find((item) => item.repositoryId === dependency.indexedRepositoryId && item.name === dependency.packageName);
        const projectId = `project:${dependency.repositoryId}`;
        const packageId = `package:${dependency.indexedRepositoryId ?? "unresolved"}:${dependency.packageName}:${resolvedRevision}`;
        const consumerCommit = symbols.find((symbol) => symbol.repositoryId === dependency.repositoryId)?.commit ?? "unknown";
        if (!nodes.some((node) => node.id === projectId)) nodes.push({ id: projectId, kind: "project", label: dependency.repositoryId, metadata: { symbolUsage: "dependency-only" } });
        if (!nodes.some((node) => node.id === packageId)) nodes.push({ id: packageId, kind: "package-revision", label: dependency.packageName, subtitle: dependency.resolvedVersion ?? dependency.declaredConstraint ?? "unresolved", metadata: {
          declaredConstraint: dependency.declaredConstraint, declaredConstraintBase: dependency.declaredConstraintBase, declaredAlias: dependency.declaredAlias,
          resolvedVersion: dependency.resolvedVersion, resolvedSourceReference: dependency.resolvedSourceReference, resolvedSourceUrl: dependency.resolvedSourceUrl,
          resolvedDistReference: dependency.resolvedDistReference, resolvedDistUrl: dependency.resolvedDistUrl, resolvedPath: dependency.resolvedPath,
          resolvedSourceCommit: dependency.resolvedSourceCommit, indexedRepositoryId: dependency.indexedRepositoryId, indexedRevision: dependency.indexedRevision,
          resolution: dependency.resolution, resolutionMethod: dependency.resolutionMethod, resolutionEvidence: dependency.resolutionEvidence ?? [], repositoryCandidates: dependency.repositoryCandidates ?? [],
          branchAliases: targetPackage?.branchAliases ?? {}, symbolAnalysis: "unavailable-for-exact-revision",
        } });
        edges.push({ id: edgeId, source: projectId, target: packageId, type: "requires", label: "Requires", confidence: "dependency-only", evidence: [{
          repositoryId: dependency.repositoryId, commit: consumerCommit, resolutionMethod: dependency.resolutionMethod ?? (dependency.resolvedSourceCommit ? "composer-lock" : "composer-json"), confidence: "dependency-only",
          detail: dependency.resolutionEvidence?.join("; ") || `Composer dependency ${dependency.packageName} could not be linked to an exact indexed package revision`, limitations: ["Symbol analysis is unavailable until repository identity and exact revision both resolve"],
        }] });
      }
    }
    if (nodes.length > limit) { nodes.splice(limit); nodeLimitTruncated = true; }
    const visibleNodeIds = new Set(nodes.map((node) => node.id));
    let edgeFilteringTruncated = edges.some((edge) => !visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target));
    let responseEdges = edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target));
    if (responseEdges.length > limit) { responseEdges = responseEdges.slice(0, limit); edgeFilteringTruncated = true; }
    const repositories = [...snapshot.repositoryCommits].map(([repositoryId, commit]) => ({ repositoryId, commit, dirty: false }));
    const history = snapshot.historyBySymbol?.get(focus.id) ?? (snapshot.active ? this.store.history(focus.id) : []);
    const limitations = [
      ...(overlayId ? ["Only the selected unsaved file is overlaid; cross-file local analysis may be partial"] : []),
      ...(depthTruncated ? ["Graph traversal reached the three-hop view limit"] : []),
      ...(edgeLimitTruncated || nodeLimitTruncated || edgeFilteringTruncated ? ["Graph traversal was truncated by the requested node or edge limit"] : []),
    ];
    const response: GraphResponse = { protocolVersion: PROTOCOL_VERSION, queryId: randomUUID(), mode, focusNodeId: focus.id, nodes, edges: responseEdges, history, freshness: { generation: focus.generation, indexedAt: snapshot.indexedAt ?? new Date().toISOString(), repositories, partial: limitations.length > 0, limitations } };
    if (selection.revision.dirty && !overlayId) for (const node of nodes) if (node.occurrence?.revision.repositoryId === focus.repositoryId && node.occurrence.path === selection.relativePath) node.metadata.unsavedEditor = true;
    this.queries.set(response.queryId, { response, symbols, relationships, anchor: focus });
    if (this.queries.size > 100) this.queries.delete(this.queries.keys().next().value ?? "");
    return response;
  }

  expand(queryId: string, nodeId: string, direction: "in" | "out" | "both"): GraphResponse {
    const query = this.queries.get(queryId);
    if (!query) throw new Error("Graph query has expired; run the trace again");
    const previous = query.response;
    const symbols = query.symbols;
    const relationships = query.relationships.filter((edge) => direction === "in" ? edge.targetId === nodeId : direction === "out" ? edge.sourceId === nodeId : edge.sourceId === nodeId || edge.targetId === nodeId);
    const nodes = [...previous.nodes];
    const edges = [...previous.edges];
    for (const relationship of relationships) {
      if (!edges.some((edge) => edge.id === relationship.id)) edges.push(relationEdge(relationship));
      for (const id of [relationship.sourceId, relationship.targetId]) {
        const symbol = symbols.find((item) => item.id === id);
        if (symbol && !nodes.some((node) => node.id === id)) nodes.push(graphNode(symbol));
      }
    }
    const expanded = { ...previous, queryId: randomUUID(), nodes, edges };
    this.queries.set(expanded.queryId, { ...query, response: expanded });
    return expanded;
  }
}
