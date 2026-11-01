import { setImmediate as yieldImmediate } from "node:timers/promises";
import { PROTOCOL_VERSION, type CodeLensCount, type CodeLensCountsRequest, type CodeLensCountsResponse, type SourceRange } from "@trace/contracts";
import type { ComposerDependency, ComposerPackage } from "./model.js";
import { linkComposerRevisions } from "./relationships.js";
import { TraceStore, type ActiveCallEdge, type ActiveCountSymbol } from "./store.js";

const PAGE_SIZE = 500;
const ITEM_YIELD_INTERVAL = 25;

interface CountValue extends Omit<CodeLensCount, "id"> {}

interface CountSnapshot {
  key: string;
  bases: Map<string, { generation: number; commit: string }>;
  symbolsByPath: Map<string, ActiveCountSymbol[]>;
  callers: Map<string, number>;
  packagesByRepository: Map<string, ComposerPackage[]>;
  consumersByPackage: Map<string, { count: number; partial: boolean; limitations: string[] }>;
}

export class LensRevisionError extends Error {
  constructor(message: string, readonly details: Record<string, unknown>) { super(message); }
}

const normalizedPath = (value: string): string => value.replaceAll("\\", "/").replace(/^\.\//, "");
const pathKey = (repositoryId: string, sourcePath: string): string => `${repositoryId}\0${normalizedPath(sourcePath)}`;
const rangeSize = (range: SourceRange): number => Math.max(0, range.endLine - range.startLine) * 1_000_000 + Math.max(0, range.endColumn - range.startColumn);
const contains = (outer: SourceRange, inner: SourceRange): boolean =>
  (outer.startLine < inner.startLine || outer.startLine === inner.startLine && outer.startColumn <= inner.startColumn)
  && (outer.endLine > inner.endLine || outer.endLine === inner.endLine && outer.endColumn >= inner.endColumn);

function sourcePackage(symbol: Pick<ActiveCountSymbol, "repositoryId" | "path">, packages: ComposerPackage[]): ComposerPackage | undefined {
  return packages
    .filter((item) => item.repositoryId === symbol.repositoryId && (!item.rootPath || symbol.path === item.rootPath || symbol.path.startsWith(`${item.rootPath.replace(/\/$/, "")}/`)))
    .sort((left, right) => right.rootPath.length - left.rootPath.length)[0];
}

const packageKey = (pkg: ComposerPackage): string => `${pkg.repositoryId}\0${pkg.name}\0${pkg.rootPath}`;

function exactDependency(dependency: ComposerDependency, pkg: ComposerPackage): boolean {
  return dependency.packageName === pkg.name
    && dependency.indexedRepositoryId === pkg.repositoryId
    && Boolean(dependency.indexedRevision && pkg.sourceCommit && dependency.indexedRevision === pkg.sourceCommit)
    && !["ambiguous", "unavailable", "declared-only"].includes(dependency.resolution);
}

async function addExactCrossRepositoryCallers(
  symbols: ActiveCountSymbol[],
  packages: ComposerPackage[],
  dependencies: ComposerDependency[],
  callerSets: Map<string, Set<string>>,
  signal: AbortSignal,
): Promise<void> {
  const packagesByRepositoryAndName = new Map(packages.map((pkg) => [`${pkg.repositoryId}\0${pkg.name}`, pkg]));
  const dependenciesByRepository = new Map<string, ComposerDependency[]>();
  for (const dependency of dependencies) dependenciesByRepository.set(dependency.repositoryId, [...dependenciesByRepository.get(dependency.repositoryId) ?? [], dependency]);
  const allowedCache = new Map<string, Set<string>>();
  const allowedRepositories = (repositoryId: string): Set<string> => {
    const cached = allowedCache.get(repositoryId); if (cached) return cached;
    const allowed = new Set([repositoryId]);
    for (const dependency of dependenciesByRepository.get(repositoryId) ?? []) {
      const pkg = dependency.indexedRepositoryId ? packagesByRepositoryAndName.get(`${dependency.indexedRepositoryId}\0${dependency.packageName}`) : undefined;
      if (pkg && exactDependency(dependency, pkg)) allowed.add(pkg.repositoryId);
    }
    allowedCache.set(repositoryId, allowed); return allowed;
  };
  const typesByFqn = new Map<string, ActiveCountSymbol[]>();
  const typeByRepositoryAndFqn = new Map<string, ActiveCountSymbol>();
  const methodsByName = new Map<string, ActiveCountSymbol[]>();
  for (const symbol of symbols) {
    if (symbol.kind === "method") methodsByName.set(`${symbol.classFqn?.toLowerCase()}::${symbol.memberName?.toLowerCase()}`, [...methodsByName.get(`${symbol.classFqn?.toLowerCase()}::${symbol.memberName?.toLowerCase()}`) ?? [], symbol]);
    else {
      const key = symbol.fqn.toLowerCase();
      typesByFqn.set(key, [...typesByFqn.get(key) ?? [], symbol]);
      typeByRepositoryAndFqn.set(`${symbol.repositoryId}\0${key}`, symbol);
    }
  }
  const typeCandidates = (fqn: string, repositories: Set<string>) => (typesByFqn.get(fqn.toLowerCase()) ?? []).filter((item) => repositories.has(item.repositoryId));
  const directMethod = (classFqn: string, method: string, repositories: Set<string>) => (methodsByName.get(`${classFqn.toLowerCase()}::${method.toLowerCase()}`) ?? []).find((item) => repositories.has(item.repositoryId));
  const inheritedMethod = (classFqn: string, method: string, repositories: Set<string>): ActiveCountSymbol | undefined => {
    const direct = directMethod(classFqn, method, repositories); if (direct) return direct;
    const queue = typeCandidates(classFqn, repositories); const visited = new Set<string>();
    while (queue.length) {
      const current = queue.shift(); if (!current || visited.has(current.id)) continue; visited.add(current.id);
      if (!current.parent) continue;
      const inherited = directMethod(current.parent, method, repositories); if (inherited) return inherited;
      queue.push(...typeCandidates(current.parent, repositories));
    }
    return undefined;
  };
  const add = (sourceId: string, target: ActiveCountSymbol, sourceRepositoryId: string) => {
    if (target.repositoryId === sourceRepositoryId) return;
    const sources = callerSets.get(target.id) ?? new Set<string>(); sources.add(sourceId); callerSets.set(target.id, sources);
  };

  let processed = 0;
  for (const method of symbols) {
    if (method.kind !== "method" || !method.classFqn || !method.memberName) continue;
    signal.throwIfAborted();
    if (++processed % PAGE_SIZE === 0) await yieldImmediate(undefined, { signal });
    const allowed = allowedRepositories(method.repositoryId);
    const owner = typeByRepositoryAndFqn.get(`${method.repositoryId}\0${method.classFqn.toLowerCase()}`);
    if (owner?.parent && method.calls.some((call) => call.receiver === "parent" && call.methodName?.toLowerCase() === method.memberName?.toLowerCase())) {
      const target = inheritedMethod(owner.parent, method.memberName, allowed); if (target) add(method.id, target, method.repositoryId);
    }
    for (const call of method.calls) {
      if (!call.methodName || call.confidence === "unresolved" || !["variable", "class"].includes(call.receiver)) continue;
      const candidateTypes = call.classNames?.length ? call.classNames : call.className ? [call.className] : [];
      for (const candidate of new Set(candidateTypes)) {
        const target = inheritedMethod(candidate, call.methodName, allowed); if (target) add(method.id, target, method.repositoryId);
      }
    }
  }
}

export class LensCountService {
  private snapshot?: CountSnapshot;
  private readonly valueCache = new Map<string, CountValue>();

  constructor(private readonly store: TraceStore) {}

  private identity(): string {
    return `${this.store.activeGenerationSignature()}\n${JSON.stringify(this.store.packageMappings())}`;
  }

  private async loadSymbols(signal: AbortSignal): Promise<ActiveCountSymbol[]> {
    const result: ActiveCountSymbol[] = [];
    let cursor = 0;
    for (;;) {
      signal.throwIfAborted();
      const page = this.store.activeCountSymbolsBatch(cursor, PAGE_SIZE);
      result.push(...page.items);
      if (page.items.length < PAGE_SIZE || page.nextRowId === undefined) return result;
      cursor = page.nextRowId;
      await yieldImmediate(undefined, { signal });
    }
  }

  private async loadRelationships(signal: AbortSignal): Promise<ActiveCallEdge[]> {
    const result: ActiveCallEdge[] = [];
    let cursor = 0;
    for (;;) {
      signal.throwIfAborted();
      const page = this.store.activeCallEdgesBatch(cursor, PAGE_SIZE);
      result.push(...page.items);
      if (page.items.length < PAGE_SIZE || page.nextRowId === undefined) return result;
      cursor = page.nextRowId;
      await yieldImmediate(undefined, { signal });
    }
  }

  private async currentSnapshot(signal: AbortSignal): Promise<{ snapshot: CountSnapshot; rebuilt: boolean }> {
    const key = this.identity();
    if (this.snapshot?.key === key) return { snapshot: this.snapshot, rebuilt: false };

    const symbols = await this.loadSymbols(signal);
    const relationships = await this.loadRelationships(signal);
    signal.throwIfAborted();
    const packages = this.store.activePackages();
    const dependencies = this.store.activeDependencies();
    const mappingRows = this.store.packageMappings();
    linkComposerRevisions(packages, dependencies, mappingRows);

    const bases = new Map<string, { generation: number; commit: string }>();
    for (const repository of this.store.listRepositories()) {
      const basis = this.store.activeGenerationBasis(repository.id);
      if (basis) bases.set(repository.id, basis);
    }
    const symbolsByPath = new Map<string, ActiveCountSymbol[]>();
    for (const symbol of symbols) {
      const keyForPath = pathKey(symbol.repositoryId, symbol.path);
      symbolsByPath.set(keyForPath, [...symbolsByPath.get(keyForPath) ?? [], symbol]);
    }
    const callerSets = new Map<string, Set<string>>();
    for (const relationship of relationships) {
      const sources = callerSets.get(relationship.targetId) ?? new Set<string>();
      sources.add(relationship.sourceId);
      callerSets.set(relationship.targetId, sources);
    }
    await addExactCrossRepositoryCallers(symbols, packages, dependencies, callerSets, signal);
    const callers = new Map([...callerSets].map(([symbolId, sourceIds]) => [symbolId, sourceIds.size]));

    const packagesByRepository = new Map<string, ComposerPackage[]>();
    for (const pkg of packages) packagesByRepository.set(pkg.repositoryId, [...packagesByRepository.get(pkg.repositoryId) ?? [], pkg]);
    const dependenciesByPackageName = new Map<string, ComposerDependency[]>();
    for (const dependency of dependencies) dependenciesByPackageName.set(dependency.packageName, [...dependenciesByPackageName.get(dependency.packageName) ?? [], dependency]);
    const consumersByPackage = new Map<string, { count: number; partial: boolean; limitations: string[] }>();
    for (const pkg of packages) {
      const related = dependenciesByPackageName.get(pkg.name) ?? [];
      const exact = new Set(related.filter((item) => exactDependency(item, pkg)).map((item) => item.repositoryId));
      const excluded = related.some((item) => !exactDependency(item, pkg));
      consumersByPackage.set(packageKey(pkg), {
        count: exact.size,
        partial: excluded,
        limitations: excluded ? ["Ambiguous, unavailable, or revision-mismatched package consumers were excluded"] : [],
      });
    }

    signal.throwIfAborted();
    if (this.identity() !== key) throw new LensRevisionError("Active generations changed while CodeLens counts were being built", { expectedCacheIdentity: key });
    const snapshot = { key, bases, symbolsByPath, callers, packagesByRepository, consumersByPackage };
    this.snapshot = snapshot;
    this.valueCache.clear();
    return { snapshot, rebuilt: true };
  }

  private resolveSymbol(snapshot: CountSnapshot, repositoryId: string, item: CodeLensCountsRequest["items"][number]): { symbol?: ActiveCountSymbol; limitations: string[] } {
    const candidates = snapshot.symbolsByPath.get(pathKey(repositoryId, item.path)) ?? [];
    if (item.symbol) {
      const exact = candidates.filter((candidate) => candidate.fqn.toLowerCase() === item.symbol?.toLowerCase());
      if (exact.length === 1) return { symbol: exact[0]!, limitations: [] };
      if (exact.length > 1) return { limitations: [`Symbol identity ${item.symbol} is ambiguous at the active revision`] };
    }
    const containing = candidates.filter((candidate) => contains(candidate.range, item.range)).sort((left, right) => rangeSize(left.range) - rangeSize(right.range));
    if (!containing.length) return { limitations: ["No indexed symbol contains this CodeLens range at the requested revision"] };
    if (containing[1] && rangeSize(containing[0]!.range) === rangeSize(containing[1].range)) return { limitations: ["Multiple indexed symbols match this CodeLens range"] };
    return { symbol: containing[0]!, limitations: [] };
  }

  async count(request: CodeLensCountsRequest, signal: AbortSignal = new AbortController().signal): Promise<CodeLensCountsResponse> {
    signal.throwIfAborted();
    const requestedBasis = this.store.activeGenerationBasis(request.repository.repositoryId);
    if (!requestedBasis) throw new LensRevisionError("Repository has no published generation", { repositoryId: request.repository.repositoryId });
    if (requestedBasis.commit !== request.repository.commit) throw new LensRevisionError("CodeLens counts require the active indexed revision", { repositoryId: request.repository.repositoryId, requestedCommit: request.repository.commit, activeCommit: requestedBasis.commit, activeGeneration: requestedBasis.generation });
    const { snapshot, rebuilt } = await this.currentSnapshot(signal);
    const basis = snapshot.bases.get(request.repository.repositoryId);
    if (!basis || basis.generation !== requestedBasis.generation || basis.commit !== request.repository.commit) throw new LensRevisionError("Repository generation changed before CodeLens counts completed", { repositoryId: request.repository.repositoryId, requestedCommit: request.repository.commit });

    let hits = 0; let misses = 0;
    const counts: CodeLensCount[] = [];
    for (let index = 0; index < request.items.length; index++) {
      signal.throwIfAborted();
      if (index > 0 && index % ITEM_YIELD_INTERVAL === 0) await yieldImmediate(undefined, { signal });
      const item = request.items[index]!;
      const resolved = this.resolveSymbol(snapshot, request.repository.repositoryId, item);
      const cacheKey = resolved.symbol ? `${snapshot.key}\0${resolved.symbol.id}` : `${snapshot.key}\0${request.repository.repositoryId}\0${item.path}\0${JSON.stringify(item.range)}\0${item.symbol ?? ""}`;
      let value = this.valueCache.get(cacheKey);
      if (value) hits++;
      else {
        misses++;
        if (!resolved.symbol) value = { callers: 0, consumers: 0, partial: true, limitations: resolved.limitations };
        else {
          const pkg = sourcePackage(resolved.symbol, snapshot.packagesByRepository.get(resolved.symbol.repositoryId) ?? []);
          const consumer = pkg ? snapshot.consumersByPackage.get(packageKey(pkg)) ?? { count: 0, partial: true, limitations: ["Package consumer count is unavailable"] } : { count: 0, partial: true, limitations: ["No indexed Composer package identity covers this symbol"] };
          value = { symbolId: resolved.symbol.id, callers: snapshot.callers.get(resolved.symbol.id) ?? 0, consumers: consumer.count, partial: consumer.partial, limitations: consumer.limitations };
        }
        this.valueCache.set(cacheKey, value);
      }
      counts.push({ id: item.id, ...value });
    }
    signal.throwIfAborted();
    return { protocolVersion: PROTOCOL_VERSION, repository: request.repository, generation: basis.generation, counts, cache: { hits, misses, rebuilt } };
  }
}
