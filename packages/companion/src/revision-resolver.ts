import path from "node:path";
import type { IndexedSymbol, ParsedFile, ParsedMethod, ParsedType, ComposerDependency, ComposerPackage } from "./model.js";
import { normalizeRepositoryUrl, parseComposer } from "./composer.js";
import { GitRepository } from "./git.js";
import { parsePhp } from "./php.js";
import { symbolsFromFiles } from "./relationships.js";
import { TraceStore } from "./store.js";

export interface RevisionScope { repositoryId: string; commit: string; rootRepositoryId: string; rootCommit: string; targets?: Map<string, { repositoryId: string; commit: string }> }
export interface TypeAt { symbol: IndexedSymbol; type: ParsedType; file: ParsedFile; scope: RevisionScope }
export interface MethodAt { symbol: IndexedSymbol; method: ParsedMethod; owner: TypeAt }
export interface MethodResolution { chain: TypeAt[]; declarations: MethodAt[]; contracts: MethodAt[]; effective?: MethodAt; problems: string[] }
interface ManifestAt { pkg: ComposerPackage; dependencies: ComposerDependency[]; phpVersion?: string; phpBasis: string }

/** Resolves names using each consumer's own lock, including transitive packages. */
export class RevisionResolver {
  readonly packages: ComposerPackage[];
  readonly indexedTypes: IndexedSymbol[];
  private readonly files = new Map<string, Promise<ParsedFile | undefined>>();
  private readonly manifests = new Map<string, Promise<ManifestAt | undefined>>();
  private readonly types = new Map<string, Promise<TypeAt | undefined>>();
  private readonly resolutions = new Map<string, Promise<MethodResolution>>();
  private readonly indexedNames = new Map<string, IndexedSymbol[]>();
  private inventoryComplete = false;
  constructor(readonly store: TraceStore) {
    this.packages = store.activePackages();
    this.indexedTypes = [];
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    for (const repository of this.store.listRepositories()) {
      signal?.throwIfAborted(); await new Promise<void>((resolve) => setImmediate(resolve));
      const inventory = this.store.typeInventory(repository.id);
      this.indexedTypes.push(...inventory);
      for (const type of inventory) this.indexedNames.set(`${repository.id}\0${type.fqn.toLowerCase()}`, [type]);
    }
    this.inventoryComplete = true;
  }

  private indexedMatches(repositoryId: string, fqn: string): IndexedSymbol[] {
    const key = `${repositoryId}\0${fqn.toLowerCase()}`;
    const cached = this.indexedNames.get(key); if (cached) return cached;
    const matches = this.inventoryComplete ? [] : this.store.activeSymbolsMatchingClasses([repositoryId], [fqn], false);
    this.indexedNames.set(key, matches); return matches;
  }

  scope(repositoryId: string, commit: string): RevisionScope { return { repositoryId, commit, rootRepositoryId: repositoryId, rootCommit: commit }; }
  package(repositoryId: string): ComposerPackage | undefined { return this.packages.find((pkg) => pkg.repositoryId === repositoryId); }

  async manifest(repositoryId: string, commit: string): Promise<ManifestAt | undefined> {
    const key = `${repositoryId}@${commit}`;
    let pending = this.manifests.get(key);
    if (!pending) {
      pending = (async () => {
        const repository = this.store.repository(repositoryId); if (!repository) return undefined;
        const active = this.package(repositoryId); const root = active?.rootPath ?? "";
        const file = root ? `${root}/composer.json` : "composer.json";
        const git = new GitRepository(repository.root);
        const [source, lock] = await Promise.all([git.show(commit, file), git.show(commit, root ? `${root}/composer.lock` : "composer.lock")]);
        if (!source) return undefined;
        try {
          const parsed = parseComposer(repositoryId, 0, root, source, lock, { repositoryPath: repository.root, ...(repository.remoteUrl ? { repositoryUrl: repository.remoteUrl } : {}) });
          const raw = JSON.parse(source) as { config?: { platform?: { php?: string } }; require?: { php?: string } };
          const platform = raw.config?.platform?.php;
          const required = raw.require?.php;
          const version = platform?.match(/^\d+\.\d+(?:\.\d+)?$/)?.[0] ?? required?.match(/\d+\.\d+(?:\.\d+)?/)?.[0];
          return { ...parsed, ...(version ? { phpVersion: version } : {}), phpBasis: platform ? "Composer config.platform.php" : required ? `Composer PHP constraint ${required} (minimum basis)` : "PHP version not configured" };
        } catch { return undefined; }
      })(); this.manifests.set(key, pending);
    }
    return pending;
  }

  private async file(scope: RevisionScope, file: string): Promise<ParsedFile | undefined> {
    const key = `${scope.repositoryId}@${scope.commit}:${file}`;
    let pending = this.files.get(key);
    if (!pending) {
      pending = (async () => {
        const repository = this.store.repository(scope.repositoryId); if (!repository) return undefined;
        const source = await new GitRepository(repository.root).show(scope.commit, file); if (!source) return undefined;
        try { return parsePhp(source, file); } catch { return undefined; }
      })(); this.files.set(key, pending);
    }
    return pending;
  }

  async localType(scope: RevisionScope, fqn: string): Promise<TypeAt | undefined> {
    const manifest = await this.manifest(scope.repositoryId, scope.commit);
    const paths = new Set(this.indexedMatches(scope.repositoryId, fqn).map((type) => type.path));
    for (const [prefix, roots] of Object.entries(manifest?.pkg.autoload ?? {})) {
      if (!fqn.toLowerCase().startsWith(prefix.toLowerCase())) continue;
      for (const root of roots) paths.add(path.posix.join(manifest?.pkg.rootPath ?? "", root, `${fqn.slice(prefix.length).replaceAll("\\", "/")}.php`));
    }
    for (const file of paths) {
      const parsed = await this.file(scope, file);
      const type = parsed?.types.find((item) => item.fqn.toLowerCase() === fqn.toLowerCase());
      if (!type || !parsed) continue;
      const symbol = symbolsFromFiles(scope.repositoryId, 0, scope.commit, [parsed]).find((item) => item.kind !== "method" && item.fqn === type.fqn)!;
      return { symbol: { ...symbol, data: type }, type, file: parsed, scope };
    }
    return undefined;
  }

  async type(scope: RevisionScope, fqn: string): Promise<TypeAt | undefined> {
    const key = JSON.stringify([scope.repositoryId, scope.commit, scope.rootRepositoryId, scope.rootCommit, [...scope.targets ?? []], fqn.toLowerCase()]);
    let pending = this.types.get(key);
    if (!pending) {
      pending = (async () => {
        const local = await this.localType(scope, fqn); if (local) return local;
        const root = await this.manifest(scope.rootRepositoryId, scope.rootCommit);
        if (!root) return undefined;
        const candidates: Array<{ repositoryId: string; commit: string }> = [];
        for (const dependency of root.dependencies) {
          const target = scope.targets?.get(dependency.packageName);
          const packages = this.packages.filter((pkg) => pkg.name === dependency.packageName);
          const sourceUrl = normalizeRepositoryUrl(dependency.resolvedSourceUrl);
          const identified = sourceUrl ? packages.filter((pkg) => (pkg.normalizedRepositoryUrl ?? normalizeRepositoryUrl(this.store.repository(pkg.repositoryId)?.remoteUrl)) === sourceUrl) : packages;
          if (!target && identified.length !== 1) continue;
          const pkg = target ? this.packages.find((pkg) => pkg.repositoryId === target.repositoryId && pkg.name === dependency.packageName) : identified[0];
          const commit = target?.commit ?? dependency.resolvedSourceCommit;
          if (!pkg || !commit || pkg.repositoryId === scope.repositoryId && commit === scope.commit) continue;
          const autoloadMatch = Object.keys(pkg.autoload).some((prefix) => fqn.toLowerCase().startsWith(prefix.toLowerCase()));
          const indexedMatch = !autoloadMatch && this.indexedMatches(pkg.repositoryId, fqn).length > 0;
          if (indexedMatch || autoloadMatch) candidates.push({ repositoryId: pkg.repositoryId, commit });
        }
        const matches: TypeAt[] = [];
        for (const candidate of candidates) {
          const resolved = await this.localType({ ...scope, ...candidate }, fqn);
          if (resolved) matches.push(resolved);
        }
        return matches.length === 1 ? matches[0] : undefined;
      })(); this.types.set(key, pending);
    }
    return pending;
  }

  method(owner: TypeAt, method: ParsedMethod): MethodAt {
    const symbol = symbolsFromFiles(owner.scope.repositoryId, 0, owner.scope.commit, [owner.file]).find((item) => item.kind === "method" && item.classFqn === owner.type.fqn && item.memberName?.toLowerCase() === method.name.toLowerCase());
    return { owner, method, symbol: { ...(symbol ?? owner.symbol), id: symbol?.id ?? `${owner.symbol.id}::${method.name}`, kind: "method", fqn: `${owner.type.fqn}::${method.name}`, classFqn: owner.type.fqn, memberName: method.name, range: method.range, data: method } };
  }

  /** Resolve the parent-class story first; unrelated contracts enrich consumer checks later. */
  async lineage(scope: RevisionScope, fqn: string, member: string, visited = new Set<string>()): Promise<MethodResolution> {
    const key = `${scope.repositoryId}@${scope.commit}:${fqn.toLowerCase()}`;
    if (visited.has(key) || visited.size > 64) return { chain: [], declarations: [], contracts: [], problems: [`Cyclic or excessively deep inheritance at ${fqn}`] };
    const owner = await this.type(scope, fqn);
    if (!owner) return { chain: [], declarations: [], contracts: [], problems: [`Exact parent declaration ${fqn} is unavailable at ${scope.commit}`] };
    const method = owner.type.methods.find((item) => item.name.toLowerCase() === member.toLowerCase());
    const own = method ? this.method(owner, method) : undefined;
    const parent = owner.type.parent ? await this.lineage(owner.scope, owner.type.parent, member, new Set(visited).add(key)) : undefined;
    const effective = own ?? (parent?.effective?.method.visibility !== "private" ? parent?.effective : undefined);
    return { chain: [owner, ...parent?.chain ?? []], declarations: [...(own ? [own] : []), ...(parent?.declarations ?? []).filter((item) => item.method.visibility !== "private")], contracts: [], ...(effective ? { effective } : {}), problems: parent?.problems ?? [] };
  }

  async resolve(scope: RevisionScope, fqn: string, member: string, visited = new Set<string>()): Promise<MethodResolution> {
    const key = `${scope.repositoryId}@${scope.commit}:${fqn.toLowerCase()}::${member.toLowerCase()}`;
    if (visited.has(key) || visited.size > 64) return { chain: [], declarations: [], contracts: [], problems: [`Cyclic or excessively deep method resolution at ${fqn}`] };
    const cacheKey = JSON.stringify([key, scope.rootRepositoryId, scope.rootCommit, [...scope.targets ?? []]]);
    const cached = this.resolutions.get(cacheKey); if (cached) return cached;
    const pending = (async (): Promise<MethodResolution> => {
    const seen = new Set(visited).add(key);
    const owner = await this.type(scope, fqn);
    if (!owner) return { chain: [], declarations: [], contracts: [], problems: [`Exact declaration ${fqn} is unavailable or ambiguous at ${scope.commit}`] };
    const ownMethod = owner.type.methods.find((method) => method.name.toLowerCase() === member.toLowerCase());
    const own = ownMethod ? this.method(owner, ownMethod) : undefined;
    const parent = owner.type.parent ? await this.resolve(owner.scope, owner.type.parent, member, seen) : undefined;
    const contracts: MethodAt[] = [...parent?.contracts ?? []];
    const problems = [...parent?.problems ?? []];
    for (const contract of owner.type.interfaces) {
      const resolution = await this.resolve(owner.scope, contract, member, seen);
      contracts.push(...resolution.declarations, ...resolution.contracts); problems.push(...resolution.problems);
    }
    const traitCandidates: MethodAt[] = [];
    const alias = owner.type.traitAdaptations?.find((adaptation) => adaptation.alias?.toLowerCase() === member.toLowerCase());
    const traitMember = alias?.method ?? member;
    for (const traitName of owner.type.traits) {
      const resolution = await this.resolve(owner.scope, traitName, traitMember, seen);
      if (resolution.effective) traitCandidates.push(resolution.effective);
      problems.push(...resolution.problems);
    }
    const precedence = owner.type.traitAdaptations?.find((adaptation) => adaptation.method.toLowerCase() === traitMember.toLowerCase() && adaptation.instead);
    const effectiveTraits = traitCandidates.filter((candidate) => alias?.trait ? candidate.owner.type.fqn.toLowerCase() === alias.trait.toLowerCase() : precedence?.trait ? candidate.owner.type.fqn.toLowerCase() === precedence.trait.toLowerCase() : true);
    let trait = effectiveTraits.length === 1 ? effectiveTraits[0] : undefined;
    if (trait) {
      const adaptation = alias ?? owner.type.traitAdaptations?.find((adaptation) => adaptation.method.toLowerCase() === member.toLowerCase() && adaptation.visibility && (!adaptation.trait || adaptation.trait.toLowerCase() === trait!.owner.type.fqn.toLowerCase()));
      if (adaptation) trait = { ...trait, method: { ...trait.method, name: alias?.alias ?? trait.method.name, ...(adaptation.visibility ? { visibility: adaptation.visibility } : {}) } };
    }
    if (!own && effectiveTraits.length > 1) problems.push(`Trait conflict for ${owner.type.fqn}::${member}; no unique effective implementation`);
    const inherited = parent?.effective?.method.visibility === "private" ? undefined : parent?.effective;
    const effective = own ?? trait ?? (effectiveTraits.length > 1 ? undefined : inherited);
    contracts.push(...traitCandidates.filter((candidate) => candidate.method.abstract));
    const declarations = [...(own ? [own] : trait ? [trait] : []), ...(parent?.declarations ?? []).filter((declaration) => declaration.method.visibility !== "private")];
    if (!declarations.length && contracts.length) declarations.push(...contracts);
    return { chain: [owner, ...parent?.chain ?? []], declarations, contracts: [...new Map(contracts.map((contract) => [contract.symbol.id, contract])).values()], ...(effective ? { effective } : {}), problems: [...new Set(problems)] };
    })();
    this.resolutions.set(cacheKey, pending); return pending;
  }

  async hierarchy(scope: RevisionScope, names: string[]): Promise<(left: string, right: string) => boolean | undefined> {
    const parents = new Map<string, string[]>(); const complete = new Set<string>();
    const queue = [...new Set(names.map((name) => name.replace(/^static:/, "")))];
    for (let index = 0; index < queue.length && index < 100; index++) {
      const name = queue[index]!; if (parents.has(name.toLowerCase())) continue;
      const type = await this.type(scope, name); if (!type) continue;
      const bases = [type.type.parent, ...type.type.interfaces].filter((item): item is string => Boolean(item));
      parents.set(name.toLowerCase(), bases.map((base) => base.toLowerCase()));
      complete.add(name.toLowerCase()); queue.push(...bases);
    }
    return (left, right) => {
      if (left.toLowerCase() === right.toLowerCase()) return true;
      const seen = new Set<string>(); const pending = [left.toLowerCase()]; let missing = false;
      while (pending.length) { const name = pending.pop()!; if (seen.has(name)) continue; seen.add(name); if (name === right.toLowerCase()) return true; if (!complete.has(name)) missing = true; pending.push(...parents.get(name) ?? []); }
      return missing ? undefined : false;
    };
  }
}
