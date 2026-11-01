import type { ComposerDependency, ComposerPackage } from "./model.js";
import path from "node:path";

interface ComposerJson {
  name?: string;
  version?: string;
  require?: Record<string, string>;
  "require-dev"?: Record<string, string>;
  autoload?: Record<string, Record<string, string | string[]>>;
  repositories?: Array<{ type?: string; url?: string; options?: unknown; package?: { name?: string; source?: { url?: string; reference?: string }; dist?: { url?: string; reference?: string } } }> | Record<string, unknown>;
  extra?: { "branch-alias"?: Record<string, string> };
}

interface LockPackage {
  name: string;
  version?: string;
  source?: { type?: string; url?: string; reference?: string };
  dist?: { type?: string; url?: string; reference?: string };
}

interface ComposerLock {
  packages?: LockPackage[];
  "packages-dev"?: LockPackage[];
  aliases?: Array<{ package?: string; alias?: string; alias_normalized?: string; "alias-normalized"?: string }>;
}

export interface InstalledComposerPackage { name?: string; "install-path"?: string }

export interface ComposerParseOptions {
  repositoryPath?: string;
  repositoryUrl?: string;
  installedPackages?: InstalledComposerPackage[];
}

/** Normalizes equivalent Git transport forms without treating a commit as repository identity. */
export function normalizeRepositoryUrl(value: string | undefined): string | undefined {
  const input = value?.trim();
  if (!input) return undefined;
  let candidate = input.replace(/^git\+/, "");
  const scp = candidate.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (scp && !candidate.includes("://")) candidate = `ssh://${scp[1]}/${scp[2]}`;
  try {
    const parsed = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
    const host = parsed.hostname.toLowerCase();
    const rawPath = decodeURIComponent(parsed.pathname).replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    const pathname = host === "github.com" ? rawPath.toLowerCase() : rawPath;
    if (!host || !pathname) return undefined;
    return `${host}/${pathname}`;
  } catch { return undefined; }
}

export function sanitizeRepositoryUrl(value: string | undefined): string | undefined {
  const input = value?.trim(); if (!input) return undefined;
  const scp = input.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (scp && !input.includes("://")) return `${scp[1]}:${scp[2]}`.replace(/[?#].*$/, "");
  try {
    const parsed = new URL(input);
    parsed.username = ""; parsed.password = ""; parsed.search = ""; parsed.hash = "";
    return parsed.toString();
  } catch { return input.replace(/[?#].*$/, ""); }
}

function constraintParts(constraint: string | undefined, lockAlias?: string): { base?: string; alias?: string } {
  if (!constraint) return lockAlias ? { alias: lockAlias } : {};
  const match = constraint.match(/^(.+?)\s+as\s+([^\s]+)$/i);
  const alias = match?.[2] ?? lockAlias;
  return { base: match?.[1]?.trim() ?? constraint, ...(alias ? { alias } : {}) };
}

function repositoryEntries(value: ComposerJson["repositories"]): Array<{ type?: string; url?: string; packageName?: string; canonical: boolean; versionOverride?: string }> {
  const raw = Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const base = { type: typeof (entry as any).type === "string" ? (entry as any).type : undefined, url: typeof (entry as any).url === "string" ? (entry as any).url : undefined, canonical: (entry as any).canonical !== false };
    const packageName = typeof (entry as any).package?.name === "string" ? (entry as any).package.name : undefined;
    if (packageName) return [{ ...base, packageName }];
    const versions = (entry as any).options?.versions;
    if (versions && typeof versions === "object") return Object.entries(versions).flatMap(([name, version]) => typeof version === "string" ? [{ ...base, packageName: name, versionOverride: version }] : []);
    return [base];
  });
}

function autoloadMappings(value: ComposerJson["autoload"]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const section of ["psr-4", "psr-0", "classmap"]) {
    for (const [prefix, paths] of Object.entries(value?.[section] ?? {})) result[prefix] = Array.isArray(paths) ? paths : [paths];
  }
  return result;
}

export function parseComposer(repositoryId: string, generation: number, rootPath: string, manifestText: string, lockText?: string, options: ComposerParseOptions = {}): { pkg: ComposerPackage; dependencies: ComposerDependency[] } {
  const manifest = JSON.parse(manifestText) as ComposerJson;
  const lock = lockText ? JSON.parse(lockText) as ComposerLock : undefined;
  const resolved = new Map<string, { pkg: LockPackage; development: boolean }>();
  for (const pkg of lock?.packages ?? []) resolved.set(pkg.name, { pkg, development: false });
  for (const pkg of lock?.["packages-dev"] ?? []) resolved.set(pkg.name, { pkg, development: true });
  const requirements = new Map<string, { constraint: string; development: boolean }>();
  for (const [name, constraint] of Object.entries(manifest.require ?? {})) if (name !== "php" && !name.startsWith("ext-")) requirements.set(name, { constraint, development: false });
  for (const [name, constraint] of Object.entries(manifest["require-dev"] ?? {})) if (name !== "php" && !name.startsWith("ext-")) requirements.set(name, { constraint, development: true });
  const dependencies: ComposerDependency[] = [];
  const aliases = new Map((lock?.aliases ?? []).flatMap((item) => item.package && (item.alias || item.alias_normalized || item["alias-normalized"]) ? [[item.package, item.alias ?? item.alias_normalized ?? item["alias-normalized"] ?? ""] as const] : []));
  const installed = new Map((options.installedPackages ?? []).flatMap((item) => item.name && item["install-path"] ? [[item.name, item["install-path"]] as const] : []));
  const configuredRepositories = repositoryEntries(manifest.repositories);
  const pathRepositories = configuredRepositories.filter((item) => item.type === "path" && item.url);
  const names = new Set([...requirements.keys(), ...resolved.keys()]);
  for (const name of names) {
    const declared = requirements.get(name);
    const locked = resolved.get(name);
    const sourceReference = locked?.pkg.source?.reference;
    const sourceUrl = sanitizeRepositoryUrl(locked?.pkg.source?.url);
    const distReference = locked?.pkg.dist?.reference;
    const distUrl = sanitizeRepositoryUrl(locked?.pkg.dist?.url);
    const parts = constraintParts(declared?.constraint, aliases.get(name));
    const explicitPathUrl = locked?.pkg.source?.type === "path" ? sourceUrl : locked?.pkg.dist?.type === "path" ? distUrl : undefined;
    const declaredPathUrl = pathRepositories.length === 1 || pathRepositories.find((entry) => entry.packageName === name) ? (pathRepositories.find((entry) => entry.packageName === name) ?? pathRepositories[0])?.url : undefined;
    const installedPath = installed.get(name);
    const nonGlobDeclaredPath = declaredPathUrl && !/[*?{}]/.test(declaredPathUrl) ? declaredPathUrl : undefined;
    const relativePath = explicitPathUrl;
    const resolvedPath = options.repositoryPath
      ? relativePath ? path.resolve(options.repositoryPath, rootPath, relativePath)
        : installedPath ? path.resolve(options.repositoryPath, rootPath, "vendor/composer", installedPath)
          : nonGlobDeclaredPath ? path.resolve(options.repositoryPath, rootPath, nonGlobDeclaredPath) : undefined
      : undefined;
    const normalizedSourceUrl = normalizeRepositoryUrl(sourceUrl);
    const sourceCommit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sourceReference ?? "") ? sourceReference : undefined;
    const repositoryCandidates = configuredRepositories.filter((entry) => !entry.packageName || entry.packageName === name).map((entry) => {
      const pathUrl = entry.type === "path" ? entry.url : undefined;
      const sanitizedUrl = pathUrl ?? sanitizeRepositoryUrl(entry.url);
      const normalizedUrl = !pathUrl ? normalizeRepositoryUrl(sanitizedUrl) : undefined;
      return { type: entry.type ?? "unknown", ...(sanitizedUrl ? { url: sanitizedUrl } : {}), ...(normalizedUrl ? { normalizedUrl } : {}), ...(pathUrl && options.repositoryPath && !/[*?{}]/.test(pathUrl) ? { resolvedPath: path.resolve(options.repositoryPath, rootPath, pathUrl) } : {}), canonical: entry.canonical, ...(entry.packageName ? { packageName: entry.packageName } : {}), ...(entry.versionOverride ? { versionOverride: entry.versionOverride } : {}) };
    });
    dependencies.push({
      repositoryId,
      generation,
      packageName: name,
      development: declared?.development ?? locked?.development ?? false,
      direct: Boolean(declared),
      ...(declared ? { declaredConstraint: declared.constraint } : {}),
      ...(parts.base ? { declaredConstraintBase: parts.base } : {}),
      ...(parts.alias ? { declaredAlias: parts.alias } : {}),
      ...(locked?.pkg.version ? { resolvedVersion: locked.pkg.version } : {}),
      ...(sourceReference ? { resolvedSourceReference: sourceReference } : {}),
      ...(sourceCommit ? { resolvedSourceCommit: sourceCommit } : {}),
      ...(sourceUrl ? { resolvedSourceUrl: sourceUrl } : {}),
      ...(normalizedSourceUrl ? { normalizedSourceUrl } : {}),
      ...(distReference ? { resolvedDistReference: distReference } : {}),
      ...(distUrl ? { resolvedDistUrl: distUrl } : {}),
      ...(resolvedPath ? { resolvedPath } : {}),
      resolution: resolvedPath ? "path" : sourceReference ? "exact" : declared ? "declared-only" : "unavailable",
      resolutionMethod: "unresolved",
      resolutionEvidence: [],
      repositoryCandidates,
    });
  }
  const repositoryUrl = sanitizeRepositoryUrl(options.repositoryUrl);
  const normalizedRepositoryUrl = normalizeRepositoryUrl(repositoryUrl);
  return {
    pkg: {
      repositoryId,
      generation,
      rootPath,
      name: manifest.name ?? repositoryId,
      ...(manifest.version ? { version: manifest.version } : {}),
      ...(options.repositoryPath ? { repositoryPath: path.resolve(options.repositoryPath, rootPath) } : {}),
      ...(repositoryUrl ? { repositoryUrl } : {}),
      ...(normalizedRepositoryUrl ? { normalizedRepositoryUrl } : {}),
      branchAliases: { ...manifest.extra?.["branch-alias"] },
      autoload: autoloadMappings(manifest.autoload),
    },
    dependencies,
  };
}
