import type {
  GraphEdge,
  GraphEdgeChange,
  GraphBasisChange,
  GraphNode,
  GraphNodeChange,
  GraphResponse,
  RepositoryRevisionResolution,
  TemporalGraphComparisonRequest,
  TemporalGraphComparisonResponse,
  TemporalGraphPoint,
} from "@trace/contracts";
import { PROTOCOL_VERSION } from "@trace/contracts";
import path from "node:path";
import { parseComposer } from "./composer.js";
import { GitRepository } from "./git.js";
import { GraphService, type GraphSnapshotData } from "./graph.js";
import type { ComposerDependency, ComposerPackage, IndexedSymbol, ParsedFile, RepositoryRecord } from "./model.js";
import { parsePhp, PHP_ANALYZER_VERSION, phpCacheKey } from "./php.js";
import { linkComposerRevisions, resolveRelationships, symbolsFromFiles } from "./relationships.js";
import { TraceStore } from "./store.js";

type Side = "before" | "after";

interface TemporalSnapshot extends GraphSnapshotData {
  resolutions: RepositoryRevisionResolution[];
}

export class TemporalRevisionError extends Error {
  readonly code = "TEMPORAL_REVISION_NOT_FOUND";
  constructor(readonly details: { side: Side; repositoryId: string; requestedCommit: string; reason: string }) {
    super(`Cannot reconstruct ${details.side} graph for ${details.repositoryId} at ${details.requestedCommit}: ${details.reason}`);
  }
}

function matches(pathName: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const regex = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return regex.test(pathName) || pathName.startsWith(pattern.replace(/\*+$/, ""));
  });
}

async function mapLimit<T, U>(items: T[], concurrency: number, signal: AbortSignal, task: (item: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      signal.throwIfAborted();
      const index = cursor++;
      const item = items[index];
      if (item !== undefined) results[index] = await task(item);
    }
  }));
  return results;
}

function nodeIdentity(node: GraphNode): string {
  const occurrence = node.occurrence;
  if (occurrence) {
    const logical = occurrence.logical;
    return `symbol|${occurrence.revision.repositoryId}|${logical.kind}|${logical.fullyQualifiedName}${logical.memberName ? `::${logical.memberName}` : ""}`;
  }
  if (node.kind === "project") return `project|${node.id.replace(/^project:/, "")}`;
  return `${node.kind}|${node.id}`;
}

function edgeEndpointIdentity(node: GraphNode | undefined, id: string): string {
  if (!node) return id;
  if (node.kind === "package-revision") return `package|${node.label}`;
  return nodeIdentity(node);
}

export function temporalEdgeIdentity(edge: GraphEdge, graph: GraphResponse): string {
  const source = graph.nodes.find((node) => node.id === edge.source);
  const target = graph.nodes.find((node) => node.id === edge.target);
  const semantic = ["parameter-type", "late-static-binding"].includes(edge.type)
    ? edge.evidence.map((evidence) => evidence.detail.replace(/ \(line \d+\)$/u, "")).sort().join("\u001f")
    : "";
  return `edge|${edge.type}|${edgeEndpointIdentity(source, edge.source)}|${edgeEndpointIdentity(target, edge.target)}${semantic ? `|${semantic}` : ""}`;
}

function stable(value: unknown): string { return JSON.stringify(value); }

function symbolChangedFields(before: IndexedSymbol | undefined, after: IndexedSymbol | undefined, beforeNode: GraphNode, afterNode: GraphNode): string[] {
  const fields: string[] = [];
  if (before && after && before.kind === "method" && after.kind === "method") {
    const left = before.data as any; const right = after.data as any;
    if (left.signatureFingerprint !== right.signatureFingerprint) fields.push("signature");
    if (left.implementationFingerprint !== right.implementationFingerprint) fields.push("implementation");
    if (left.documentationFingerprint !== right.documentationFingerprint) fields.push("documentation");
    if (stable(left.calls) !== stable(right.calls)) fields.push("relationships");
  } else if (before && after) {
    const left = before.data as any; const right = after.data as any;
    if (left.parent !== right.parent) fields.push("parent");
    if (stable(left.interfaces) !== stable(right.interfaces)) fields.push("interfaces");
    if (stable(left.traits) !== stable(right.traits)) fields.push("traits");
    if (left.description !== right.description || left.documentationDetails !== right.documentationDetails) fields.push("documentation");
  }
  if (before?.path !== after?.path) fields.push("path");
  if (beforeNode.kind !== afterNode.kind) fields.push("kind");
  if (beforeNode.label !== afterNode.label) fields.push("label");
  if (stable(beforeNode.metadata) !== stable(afterNode.metadata) && fields.length === 0) fields.push("metadata");
  return [...new Set(fields)];
}

function evidenceWithoutBasis(edge: GraphEdge): unknown {
  return edge.evidence.map(({ commit: _commit, ...evidence }) => evidence);
}

function diffGraphs(before: GraphResponse, after: GraphResponse, beforeSnapshot: TemporalSnapshot, afterSnapshot: TemporalSnapshot): TemporalGraphComparisonResponse["changes"] {
  const beforeNodes = new Map(before.nodes.map((node) => [nodeIdentity(node), node]));
  const afterNodes = new Map(after.nodes.map((node) => [nodeIdentity(node), node]));
  const beforeSymbols = new Map<string, IndexedSymbol>(beforeSnapshot.symbols.map((symbol) => {
    const logical = symbol.kind === "method" ? `${symbol.classFqn}::${symbol.memberName}` : symbol.fqn;
    return [`symbol|${symbol.repositoryId}|${symbol.kind}|${logical}`, symbol] as const;
  }));
  const afterSymbols = new Map<string, IndexedSymbol>(afterSnapshot.symbols.map((symbol) => {
    const logical = symbol.kind === "method" ? `${symbol.classFqn}::${symbol.memberName}` : symbol.fqn;
    return [`symbol|${symbol.repositoryId}|${symbol.kind}|${logical}`, symbol] as const;
  }));
  const addedNodes: GraphNode[] = [];
  const removedNodes: GraphNode[] = [];
  const changedNodes: GraphNodeChange[] = [];
  for (const [identity, node] of afterNodes) if (!beforeNodes.has(identity)) addedNodes.push(node);
  for (const [identity, node] of beforeNodes) if (!afterNodes.has(identity)) removedNodes.push(node);
  for (const [identity, beforeNode] of beforeNodes) {
    const afterNode = afterNodes.get(identity); if (!afterNode) continue;
    const changedFields = symbolChangedFields(beforeSymbols.get(identity), afterSymbols.get(identity), beforeNode, afterNode);
    if (changedFields.length) changedNodes.push({ identity, before: beforeNode, after: afterNode, changedFields });
  }

  const beforeEdges = new Map(before.edges.map((edge) => [temporalEdgeIdentity(edge, before), edge]));
  const afterEdges = new Map(after.edges.map((edge) => [temporalEdgeIdentity(edge, after), edge]));
  const addedEdges: GraphEdge[] = [];
  const removedEdges: GraphEdge[] = [];
  const changedEdges: GraphEdgeChange[] = [];
  for (const [identity, edge] of afterEdges) if (!beforeEdges.has(identity)) addedEdges.push(edge);
  for (const [identity, edge] of beforeEdges) if (!afterEdges.has(identity)) removedEdges.push(edge);
  for (const [identity, beforeEdge] of beforeEdges) {
    const afterEdge = afterEdges.get(identity); if (!afterEdge) continue;
    const changedFields: string[] = [];
    if (beforeEdge.confidence !== afterEdge.confidence) changedFields.push("confidence");
    if (stable(evidenceWithoutBasis(beforeEdge)) !== stable(evidenceWithoutBasis(afterEdge))) changedFields.push("evidence");
    if (beforeEdge.type === "requires") {
      const beforeTarget = before.nodes.find((node) => node.id === beforeEdge.target)?.metadata.resolvedSourceCommit;
      const afterTarget = after.nodes.find((node) => node.id === afterEdge.target)?.metadata.resolvedSourceCommit;
      if (beforeTarget !== afterTarget) changedFields.push("resolvedSourceCommit");
    }
    if (changedFields.length) changedEdges.push({ identity, before: beforeEdge, after: afterEdge, changedFields: [...new Set(changedFields)] });
  }
  return { nodes: { added: addedNodes, removed: removedNodes, changed: changedNodes }, edges: { added: addedEdges, removed: removedEdges, changed: changedEdges } };
}

export class TemporalGraphService {
  private readonly snapshots = new Map<string, Promise<TemporalSnapshot>>();
  constructor(private readonly store: TraceStore, private readonly graphs: GraphService, private readonly cacheLimit = 12) {}

  async compare(request: TemporalGraphComparisonRequest, signal = AbortSignal.timeout(120_000)): Promise<TemporalGraphComparisonResponse> {
    const beforeSnapshot = await this.snapshot(request.before.revisions, "before", signal);
    const afterSnapshot = await this.snapshot(request.after.revisions, "after", signal);
    const beforeSelection = this.selection(request.before, beforeSnapshot);
    const afterSelection = this.selection(request.after, afterSnapshot);
    const before = this.graphs.traceSnapshot(beforeSelection, request.mode, beforeSnapshot, request.limit);
    const after = this.graphs.traceSnapshot(afterSelection, request.mode, afterSnapshot, request.limit);
    const allRepositories = new Set([...Object.keys(request.before.revisions), ...Object.keys(request.after.revisions)]);
    const basisChanges: GraphBasisChange[] = [];
    for (const repositoryId of [...allRepositories].sort()) {
      const beforeCommit = beforeSnapshot.repositoryCommits.get(repositoryId);
      const afterCommit = afterSnapshot.repositoryCommits.get(repositoryId);
      if (beforeCommit === afterCommit) continue;
      if (!beforeCommit && afterCommit) basisChanges.push({ repositoryId, kind: "added", afterCommit });
      else if (beforeCommit && !afterCommit) basisChanges.push({ repositoryId, kind: "removed", beforeCommit });
      else basisChanges.push({ repositoryId, kind: "changed", beforeCommit: beforeCommit!, afterCommit: afterCommit! });
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      basis: { policy: "explicit-revisions-only", complete: true, before: beforeSnapshot.resolutions, after: afterSnapshot.resolutions },
      before,
      after,
      basisChanges,
      changes: diffGraphs(before, after, beforeSnapshot, afterSnapshot),
    };
  }

  private selection(point: TemporalGraphPoint, snapshot: TemporalSnapshot): TemporalGraphPoint["selection"] {
    const commit = snapshot.repositoryCommits.get(point.selection.revision.repositoryId);
    if (!commit) throw new Error("Selected repository is absent from the explicit temporal basis");
    return { ...point.selection, revision: { repositoryId: point.selection.revision.repositoryId, commit, dirty: false } };
  }

  private snapshot(revisions: Record<string, string>, side: Side, signal: AbortSignal): Promise<TemporalSnapshot> {
    const revisionEntries = Object.entries(revisions).sort(([left], [right]) => left.localeCompare(right));
    const configuration = revisionEntries.map(([repositoryId]) => {
      const repository = this.store.repository(repositoryId);
      return [repositoryId, repository?.root, repository?.include ?? [], repository?.exclude ?? []];
    });
    const mappings = this.store.packageMappings().map((mapping) => [mapping.packageName, mapping.repositoryId, mapping.packageRoot]);
    const key = JSON.stringify({ revisions: revisionEntries.map(([repositoryId, commit]) => [repositoryId, commit.toLowerCase()]), configuration, mappings });
    const cached = this.snapshots.get(key); if (cached) return cached;
    const pending = this.buildSnapshot(revisions, side, signal).catch((error) => { this.snapshots.delete(key); throw error; });
    this.snapshots.set(key, pending);
    while (this.snapshots.size > this.cacheLimit) this.snapshots.delete(this.snapshots.keys().next().value ?? "");
    return pending;
  }

  private async buildSnapshot(revisions: Record<string, string>, side: Side, signal: AbortSignal): Promise<TemporalSnapshot> {
    const entries = Object.entries(revisions).sort(([left], [right]) => left.localeCompare(right));
    const reconstructed = await Promise.all(entries.map(async ([repositoryId, requestedCommit]) => {
      signal.throwIfAborted();
      const repository = this.store.repository(repositoryId);
      if (!repository) throw new TemporalRevisionError({ side, repositoryId, requestedCommit, reason: "Repository is not configured" });
      return this.reconstructRepository(repository, requestedCommit, side, signal);
    }));
    const symbols = reconstructed.flatMap((item) => item.symbols);
    const relationships = reconstructed.flatMap((item) => item.relationships);
    const packages = reconstructed.flatMap((item) => item.packages);
    const dependencies = reconstructed.flatMap((item) => item.dependencies);
    linkComposerRevisions(packages, dependencies, this.store.packageMappings());
    return {
      symbols,
      relationships,
      packages,
      dependencies,
      mappings: new Map(this.store.packageMappings().map((item) => [item.packageName, item.repositoryId])),
      repositoryCommits: new Map(reconstructed.map((item) => [item.repositoryId, item.resolution.resolvedCommit])),
      resolutions: reconstructed.map((item) => item.resolution),
      indexedAt: new Date().toISOString(),
    };
  }

  private async reconstructRepository(repository: RepositoryRecord, requestedCommit: string, side: Side, signal: AbortSignal): Promise<{
    repositoryId: string;
    resolution: RepositoryRevisionResolution;
    symbols: IndexedSymbol[];
    relationships: ReturnType<typeof resolveRelationships>;
    packages: ComposerPackage[];
    dependencies: ComposerDependency[];
  }> {
    const git = new GitRepository(repository.root);
    const resolvedCommit = await git.resolveCommit(requestedCommit);
    if (!resolvedCommit) throw new TemporalRevisionError({ side, repositoryId: repository.id, requestedCommit, reason: "Commit object is unavailable" });
    const files = await git.treeFiles(resolvedCommit);
    const include = repository.include?.length ? repository.include : ["*.php", "**/*.php", "composer.json", "**/composer.json", "composer.lock", "**/composer.lock"];
    const exclude = repository.exclude ?? ["vendor/*", "vendor/**", "node_modules/*", "node_modules/**", "tmp/*", "tmp/**", "cache/*", "cache/**", ".git/*", ".git/**"];
    const scoped = files.filter((file) => matches(file.path, include) && !matches(file.path, exclude)).sort((left, right) => left.path.localeCompare(right.path));
    const phpFiles = scoped.filter((file) => file.path.endsWith(".php"));
    const analyses = await mapLimit(phpFiles, 8, signal, async (file): Promise<ParsedFile> => {
      const fingerprint = `temporal:php:${PHP_ANALYZER_VERSION}:git:${file.objectId}`;
      const cached = this.store.cachedFileByFingerprint(repository.id, file.path, fingerprint);
      if (cached) return cached;
      const source = await git.show(resolvedCommit, file.path);
      if (source === undefined) throw new TemporalRevisionError({ side, repositoryId: repository.id, requestedCommit, reason: `Git object for ${file.path} is unavailable` });
      let analysis: ParsedFile;
      try { analysis = parsePhp(source, file.path); }
      catch (error) {
        analysis = { path: file.path, contentHash: phpCacheKey(source), namespace: "", imports: {}, types: [], limitations: [`Static analysis skipped this file: ${error instanceof Error ? error.message : "unsupported PHP syntax"}`] };
      }
      this.store.cacheFile(repository.id, analysis, fingerprint);
      return analysis;
    });
    const packages: ComposerPackage[] = []; const dependencies: ComposerDependency[] = [];
    for (const manifest of scoped.filter((file) => path.basename(file.path) === "composer.json")) {
      signal.throwIfAborted();
      const rootPath = path.dirname(manifest.path) === "." ? "" : path.dirname(manifest.path);
      const lockPath = path.posix.join(rootPath, "composer.lock");
      const manifestText = await git.show(resolvedCommit, manifest.path);
      if (manifestText === undefined) throw new TemporalRevisionError({ side, repositoryId: repository.id, requestedCommit, reason: `Git object for ${manifest.path} is unavailable` });
      const lockText = scoped.some((file) => file.path === lockPath) ? await git.show(resolvedCommit, lockPath) : undefined;
      const parsed = parseComposer(repository.id, 0, rootPath, manifestText, lockText, { repositoryPath: repository.root, ...(repository.remoteUrl ? { repositoryUrl: repository.remoteUrl } : {}) });
      parsed.pkg.sourceCommit = resolvedCommit; packages.push(parsed.pkg); dependencies.push(...parsed.dependencies);
    }
    const symbols = symbolsFromFiles(repository.id, 0, resolvedCommit, analyses);
    return {
      repositoryId: repository.id,
      resolution: { repositoryId: repository.id, requestedCommit, resolvedCommit, status: "resolved" },
      symbols,
      relationships: resolveRelationships(repository.id, 0, resolvedCommit, symbols),
      packages,
      dependencies,
    };
  }
}
