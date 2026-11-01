import { createHash } from "node:crypto";
import path from "node:path";
import type { ComposerDependency, ComposerPackage, IndexedRelationship, IndexedSymbol, ParsedFile, ParsedMethod, ParsedTypeReference } from "./model.js";

const id = (...parts: string[]) => createHash("sha1").update(parts.join("\0")).digest("hex");

export function symbolsFromFiles(repositoryId: string, generation: number, commit: string, files: ParsedFile[]): IndexedSymbol[] {
  const symbols = new Map<string, IndexedSymbol>();
  for (const file of files) for (const type of file.types) {
    const typeId = `${repositoryId}@${commit}:${type.id}`;
    if (!symbols.has(typeId)) symbols.set(typeId, { id: typeId, generation, repositoryId, commit, path: file.path, kind: type.kind, fqn: type.fqn, range: type.range, data: { ...type, methods: [] } });
    for (const method of type.methods) {
      const methodId = `${repositoryId}@${commit}:${method.id}`;
      if (!symbols.has(methodId)) symbols.set(methodId, { id: methodId, generation, repositoryId, commit, path: file.path, kind: "method", fqn: `${type.fqn}::${method.name}`, memberName: method.name, classFqn: type.fqn, range: method.range, data: { ...method, source: "" } });
    }
  }
  return [...symbols.values()];
}

export function resolveRelationships(repositoryId: string, generation: number, commit: string, symbols: IndexedSymbol[]): IndexedRelationship[] {
  const relationships: IndexedRelationship[] = [];
  const relationshipIds = new Set<string>();
  const types = symbols.filter((symbol) => symbol.kind !== "method");
  const methods = symbols.filter((symbol) => symbol.kind === "method");
  const byType = new Map(types.map((symbol) => [symbol.fqn.toLowerCase(), symbol]));
  const byMethod = new Map(methods.map((symbol) => [`${symbol.classFqn?.toLowerCase()}::${symbol.memberName?.toLowerCase()}`, symbol]));
  const methodsByClass = new Map<string, IndexedSymbol[]>();
  for (const method of methods) {
    const key = method.classFqn?.toLowerCase() ?? "";
    const owned = methodsByClass.get(key) ?? [];
    owned.push(method);
    methodsByClass.set(key, owned);
  }
  const add = (sourceId: string, targetId: string, type: IndexedRelationship["type"], confidence: IndexedRelationship["confidence"], detail: string, owner: IndexedSymbol, range = owner.range, limitations: string[] = [], resolutionMethod?: string) => {
    const relationshipId = id(sourceId, targetId, type, detail);
    if (relationshipIds.has(relationshipId)) return;
    relationshipIds.add(relationshipId);
    relationships.push({ id: relationshipId, generation, repositoryId, commit, sourceId, targetId, type, confidence, path: owner.path, range, detail, limitations, ...(resolutionMethod ? { resolutionMethod } : {}) });
  };

  for (const typeSymbol of types) {
    const type = typeSymbol.data as any;
    for (const method of methodsByClass.get(typeSymbol.fqn.toLowerCase()) ?? []) {
      add(typeSymbol.id, method.id, "declares", "confirmed", `${typeSymbol.fqn} declares ${method.memberName}`, method);
    }
    if (type.parent) {
      const parent = byType.get(type.parent.toLowerCase());
      if (parent) add(typeSymbol.id, parent.id, "extends", "confirmed", `${type.fqn} extends ${type.parent}`, typeSymbol);
    }
    for (const interfaceName of type.interfaces ?? []) {
      const target = byType.get(interfaceName.toLowerCase());
      if (target) add(typeSymbol.id, target.id, type.kind === "interface" ? "extends" : "implements", "confirmed", type.kind === "interface" ? `${type.fqn} extends ${interfaceName}` : `${type.fqn} implements ${interfaceName}`, typeSymbol);
    }
    for (const traitName of type.traits ?? []) {
      const target = byType.get(traitName.toLowerCase());
      if (target) add(typeSymbol.id, target.id, "uses-trait", "confirmed", `${type.fqn} uses ${traitName}`, typeSymbol);
    }
  }

  const ancestorMethod = (classFqn: string, methodName: string): IndexedSymbol | undefined => {
    const seen = new Set<string>();
    let current = byType.get(classFqn.toLowerCase());
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      const parentName = (current.data as any).parent as string | undefined;
      if (!parentName) return undefined;
      const found = byMethod.get(`${parentName.toLowerCase()}::${methodName.toLowerCase()}`);
      if (found) return found;
      current = byType.get(parentName.toLowerCase());
    }
    return undefined;
  };

  const interfaceCache = new Map<string, string[]>();
  const interfaceNames = (classFqn: string): string[] => {
    const cached = interfaceCache.get(classFqn.toLowerCase());
    if (cached) return cached;
    const names = new Set<string>();
    const visited = new Set<string>();
    const collect = (typeName: string) => {
      const current = byType.get(typeName.toLowerCase());
      if (!current || visited.has(current.id)) return;
      visited.add(current.id);
      const data = current.data as any;
      for (const interfaceName of data.interfaces ?? []) {
        names.add(interfaceName);
        collect(interfaceName);
      }
      if (data.parent) collect(data.parent);
    };
    collect(classFqn);
    const result = [...names];
    interfaceCache.set(classFqn.toLowerCase(), result);
    return result;
  };

  const addTypeReference = (methodSymbol: IndexedSymbol, reference: ParsedTypeReference, relationshipType: "parameter-type" | "return-type", detail: string) => {
    for (const resolved of reference.resolved) {
      const target = byType.get(resolved.toLowerCase());
      if (!target) continue;
      const confidence = reference.source === "phpdoc" || reference.lateStatic ? "possible" : "confirmed";
      const limitations = reference.source === "phpdoc"
        ? ["PHPDoc types are descriptive and are not enforced by the PHP runtime"]
        : reference.lateStatic ? ["The concrete late-static type depends on the runtime called class"] : [];
      add(methodSymbol.id, target.id, relationshipType, confidence, detail, methodSymbol, methodSymbol.range, limitations);
    }
  };

  for (const methodSymbol of methods) {
    const method = methodSymbol.data as ParsedMethod;
    const inherited = ancestorMethod(method.classFqn, method.name);
    if (inherited && method.visibility !== "private") add(methodSymbol.id, inherited.id, "overrides", "confirmed", `${method.classFqn}::${method.name} overrides inherited implementation`, methodSymbol);
    for (const interfaceName of interfaceNames(method.classFqn)) {
      const contract = byMethod.get(`${interfaceName.toLowerCase()}::${method.name.toLowerCase()}`);
      if (contract && contract.id !== methodSymbol.id && method.visibility !== "private") add(methodSymbol.id, contract.id, "implements-method", "confirmed", `${method.classFqn}::${method.name} satisfies ${interfaceName}::${method.name}`, methodSymbol);
    }
    for (const parameter of method.parameters ?? []) {
      const reference = parameter.type ?? parameter.docType;
      if (reference) addTypeReference(methodSymbol, reference, "parameter-type", `${method.classFqn}::${method.name} declares $${parameter.name} as ${reference.declared} (${reference.source})`);
    }
    const returnReference = method.returnType ?? method.docReturnType;
    if (returnReference) addTypeReference(methodSymbol, returnReference, "return-type", `${method.classFqn}::${method.name} returns ${returnReference.declared} (${returnReference.source})`);
    const owner = byType.get(method.classFqn.toLowerCase());
    if (owner) (method.lateStaticBindings ?? []).forEach((binding, index) => add(methodSymbol.id, owner.id, "late-static-binding", "possible", `${binding.detail} [occurrence ${index + 1}] (line ${binding.range.startLine})`, methodSymbol, binding.range, ["The runtime called class can be a subclass of the declaring class"]));
    for (const call of method.calls ?? []) {
      if (!call.methodName || call.confidence === "unresolved") continue;
      const candidates = call.classNames?.length ? [...call.classNames] : call.className ? [call.className] : [];
      if (call.receiver === "this" || call.receiver === "self" || call.receiver === "static") candidates.splice(0, candidates.length, method.classFqn);
      if (call.receiver === "parent") {
        const target = ancestorMethod(method.classFqn, call.methodName);
        if (target) add(methodSymbol.id, target.id, "calls-parent", call.confidence, call.detail, methodSymbol, call.range, call.limitations, `receiver-${call.resolutionMethod}`);
        continue;
      }
      for (const candidate of new Set(candidates)) {
        const target = byMethod.get(`${candidate.toLowerCase()}::${call.methodName.toLowerCase()}`) ?? ancestorMethod(candidate, call.methodName);
        if (target) {
          const confidence = candidates.length === 1 && call.confidence === "confirmed" ? "confirmed" : "possible";
          add(methodSymbol.id, target.id, "calls", confidence, `${call.detail}; candidate ${candidate}`, methodSymbol, call.range, confidence === "possible" ? [...call.limitations, "Static analysis cannot prove one runtime receiver candidate"] : call.limitations, `receiver-${call.resolutionMethod}`);
        } else if (byMethod.has(`${candidate.toLowerCase()}::${call.receiver === "class" || call.receiver === "self" || call.receiver === "static" ? "__callstatic" : "__call"}`)) {
          const analysis = method.receiverAnalysis?.find((item) => item.range.startLine === call.range.startLine && item.range.startColumn === call.range.startColumn && item.methodName === call.methodName);
          if (analysis) { analysis.status = "unresolved"; analysis.confidence = "unresolved"; analysis.resolutionMethod = "magic-call"; analysis.limitations = [...new Set([...analysis.limitations, `Magic ${call.receiver === "class" || call.receiver === "self" || call.receiver === "static" ? "__callStatic" : "__call"} dispatch cannot prove a declared target method`])]; }
        } else if (byType.has(candidate.toLowerCase())) {
          const analysis = method.receiverAnalysis?.find((item) => item.range.startLine === call.range.startLine && item.range.startColumn === call.range.startColumn && item.methodName === call.methodName);
          if (analysis) { analysis.status = "unresolved"; analysis.confidence = "unresolved"; analysis.resolutionMethod = "unresolved"; analysis.limitations = [...new Set([...analysis.limitations, `No declared target ${candidate}::${call.methodName} was found`])]; }
        }
      }
    }
  }
  return relationships;
}

export interface ComposerPackageMapping { packageName: string; repositoryId: string; packageRoot: string }

const normalizedPath = (value: string) => path.resolve(value).replaceAll("\\", "/").replace(/\/$/, "");

export function linkComposerRevisions(packages: ComposerPackage[], dependencies: ComposerDependency[], mappings: ComposerPackageMapping[] = []): void {
  const byName = new Map<string, ComposerPackage[]>();
  const byRepository = new Map<string, ComposerPackage[]>();
  const byPath = new Map<string, ComposerPackage[]>();
  const byUrl = new Map<string, ComposerPackage[]>();
  for (const item of packages) {
    byName.set(item.name, [...byName.get(item.name) ?? [], item]);
    byRepository.set(item.repositoryId, [...byRepository.get(item.repositoryId) ?? [], item]);
    if (item.repositoryPath) {
      const key = normalizedPath(item.repositoryPath);
      byPath.set(key, [...byPath.get(key) ?? [], item]);
    }
    if (item.normalizedRepositoryUrl) byUrl.set(item.normalizedRepositoryUrl, [...byUrl.get(item.normalizedRepositoryUrl) ?? [], item]);
  }
  const mappingByName = new Map(mappings.map((item) => [item.packageName, item]));
  for (const dependency of dependencies) {
    delete dependency.indexedRepositoryId;
    delete dependency.indexedRevision;
    dependency.resolutionMethod = "unresolved";
    dependency.resolutionEvidence = [];
    const named = byName.get(dependency.packageName) ?? [];
    const mapping = mappingByName.get(dependency.packageName);
    let candidates: ComposerPackage[] = [];
    let method: NonNullable<ComposerDependency["resolutionMethod"]> = "unresolved";
    if (mapping) {
      candidates = (byRepository.get(mapping.repositoryId) ?? []).filter((item) => !mapping.packageRoot || item.rootPath === mapping.packageRoot || item.repositoryPath && normalizedPath(item.repositoryPath).endsWith(`/${mapping.packageRoot.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")}`));
      method = "explicit-mapping";
      dependency.resolutionEvidence.push(`Explicit package mapping selects ${mapping.repositoryId}${mapping.packageRoot ? `/${mapping.packageRoot}` : ""}`);
    } else if (dependency.resolvedPath) {
      candidates = byPath.get(normalizedPath(dependency.resolvedPath)) ?? [];
      method = "path";
      dependency.resolutionEvidence.push(`Canonical path ${dependency.resolvedPath} was used as repository identity`);
    } else if (dependency.normalizedSourceUrl) {
      candidates = byUrl.get(dependency.normalizedSourceUrl) ?? [];
      method = "source-url";
      dependency.resolutionEvidence.push(`Normalized source URL ${dependency.normalizedSourceUrl} was used as repository identity`);
      if (!candidates.length && named.length === 1 && !named[0]?.normalizedRepositoryUrl) {
        candidates = named;
        method = "package-name";
        dependency.resolutionEvidence.push("The sole package-name candidate has no repository URL to contradict the locked source URL");
      }
    } else if (named.length === 1) {
      candidates = named;
      method = "package-name";
      dependency.resolutionEvidence.push(`Package name ${dependency.packageName} has one indexed candidate`);
    }
    if (candidates.length !== 1) {
      dependency.resolutionMethod = "unresolved";
      dependency.resolution = candidates.length > 1 || named.length > 1 ? "ambiguous" : dependency.declaredConstraint ? "declared-only" : "unavailable";
      dependency.resolutionEvidence.push(candidates.length > 1 || named.length > 1 ? `Repository identity is ambiguous across ${Math.max(candidates.length, named.length)} indexed candidates` : "No indexed repository matched the available identity evidence");
      continue;
    }
    const target = candidates[0]!;
    dependency.indexedRepositoryId = target.repositoryId;
    if (target.sourceCommit) dependency.indexedRevision = target.sourceCommit;
    dependency.resolutionMethod = method;
    const selectedReference = dependency.resolvedSourceCommit;
    if (selectedReference && target.sourceCommit && selectedReference !== target.sourceCommit) {
      dependency.resolution = "unavailable";
      dependency.resolutionEvidence.push(`Indexed revision ${target.sourceCommit} differs from locked source reference ${selectedReference}`);
    } else if (method === "path") dependency.resolution = "path";
    else if (target.sourceCommit && selectedReference === target.sourceCommit) dependency.resolution = "exact";
    else dependency.resolution = "unavailable";
  }
}
