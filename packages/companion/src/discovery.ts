import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { RepositoryRecord } from "./model.js";
import { GitRepository } from "./git.js";

const execFileAsync = promisify(execFile);
const EXCLUDED_SEGMENTS = new Set([".git", "vendor", "node_modules", "tmp", "temp", "cache", "caches"]);

export interface InventoryFile { path: string; fingerprint: string; changed: boolean }
export interface SourceInventory {
  revision: { commit: string; branch?: string; dirty: boolean };
  files: InventoryFile[];
  usedFilesystemFallback: boolean;
}

interface ComposerManifest {
  name?: string;
  autoload?: Record<string, unknown>;
  "autoload-dev"?: Record<string, unknown>;
}
interface LockedPackage { name?: string; source?: { reference?: string; url?: string }; dist?: { reference?: string } }
interface InstalledPackage { name?: string; "install-path"?: string }

const shortHash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);
const normalize = (value: string) => value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
const isWithin = (root: string, candidate: string) => candidate === root || candidate.startsWith(`${root}${path.sep}`);

async function jsonFile<T>(filename: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(filename, "utf8")) as T; } catch { return undefined; }
}

function autoloadPaths(manifest: ComposerManifest | undefined): string[] {
  const result = new Set<string>();
  for (const section of [manifest?.autoload, manifest?.["autoload-dev"]]) {
    if (!section) continue;
    for (const [kind, mapping] of Object.entries(section)) {
      if (!["psr-4", "psr-0", "classmap", "files"].includes(kind)) continue;
      const collect = (value: unknown) => {
        if (typeof value === "string") result.add(normalize(kind === "files" ? path.dirname(value) : value) || ".");
        else if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === "object") Object.values(value).forEach(collect);
      };
      collect(mapping);
    }
  }
  return [...result];
}

export async function discoverWatchTargets(repository: RepositoryRecord): Promise<string[]> {
  const manifest = await jsonFile<ComposerManifest>(path.join(repository.root, "composer.json"));
  const relativeTargets = new Set(autoloadPaths(manifest));
  if (!relativeTargets.size) ["src", "app", "lib"].forEach((value) => relativeTargets.add(value));
  for (const pattern of repository.include ?? []) {
    const prefix = normalize(pattern.split("*")[0] ?? "");
    if (prefix) relativeTargets.add(path.extname(prefix) ? path.dirname(prefix) : prefix);
  }
  ["composer.json", "composer.lock", ".git/HEAD", ".git/index"].forEach((value) => relativeTargets.add(value));
  const canonicalRoot = await realpath(repository.root);
  const targets: string[] = [];
  for (const relative of relativeTargets) {
    const candidate = path.resolve(canonicalRoot, relative || ".");
    if (!isWithin(canonicalRoot, candidate) || candidate.includes(`${path.sep}vendor${path.sep}`) || candidate.includes(`${path.sep}node_modules${path.sep}`)) continue;
    try { await stat(candidate); targets.push(candidate); } catch { /* Watch only existing inputs. */ }
  }
  return [...new Set(targets)];
}

async function filesystemSources(root: string, maximumFiles = 100_000): Promise<InventoryFile[]> {
  const manifest = await jsonFile<ComposerManifest>(path.join(root, "composer.json"));
  const roots = autoloadPaths(manifest);
  if (!roots.length) roots.push("src", "app", "lib");
  const files = new Map<string, InventoryFile>();
  for (const metadata of ["composer.json", "composer.lock"]) {
    try {
      const info = await stat(path.join(root, metadata), { bigint: true });
      files.set(metadata, { path: metadata, fingerprint: `fs:${info.size}:${info.mtimeNs}`, changed: false });
    } catch { /* optional metadata */ }
  }
  const visited = new Set<string>();
  const walk = async (relativeRoot: string, depth: number): Promise<void> => {
    if (files.size >= maximumFiles || depth > 32) return;
    const absolute = path.resolve(root, relativeRoot);
    let canonical: string;
    try { canonical = await realpath(absolute); } catch { return; }
    const canonicalRoot = await realpath(root);
    if (!isWithin(canonicalRoot, canonical) || visited.has(canonical)) return;
    visited.add(canonical);
    let entries;
    try { entries = await readdir(canonical, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.size >= maximumFiles) break;
      if (entry.isDirectory() && EXCLUDED_SEGMENTS.has(entry.name.toLowerCase())) continue;
      const absoluteEntry = path.join(canonical, entry.name);
      const relative = normalize(path.relative(canonicalRoot, absoluteEntry));
      if (entry.isDirectory()) await walk(relative, depth + 1);
      else if (entry.isFile() && (relative.endsWith(".php") || path.basename(relative) === "composer.json" || path.basename(relative) === "composer.lock")) {
        const info = await stat(absoluteEntry, { bigint: true });
        files.set(relative, { path: relative, fingerprint: `fs:${info.size}:${info.mtimeNs}`, changed: false });
      }
    }
  };
  for (const sourceRoot of roots) await walk(sourceRoot, 0);
  return [...files.values()];
}

export async function discoverSourceInventory(repository: RepositoryRecord): Promise<SourceInventory> {
  const fallback = await filesystemSources(repository.root);
  try {
    const ownsGitCheckout = await stat(path.join(repository.root, ".git")).then(() => true).catch(() => false);
    if (repository.automatic && repository.sourceRevision && !ownsGitCheckout) throw new Error("Installed archive has no owning Git checkout");
    const git = new GitRepository(repository.root);
    const [revision, tracked, changed, deleted] = await Promise.all([git.revision(), git.trackedFileFingerprints(), git.changedTrackedFiles(), git.deletedTrackedFiles()]);
    const byPath = new Map<string, InventoryFile>();
    const trackedPaths = new Set<string>();
    for (const file of tracked) { if (deleted.has(file.path)) continue; const normalized = normalize(file.path); trackedPaths.add(normalized); byPath.set(normalized, { path: normalized, fingerprint: file.fingerprint, changed: changed.has(file.path) }); }
    let untrackedSource = false;
    for (const file of fallback) {
      const trackedFile = byPath.get(file.path);
      if (trackedFile) {
        if (trackedFile.changed) trackedFile.fingerprint = file.fingerprint;
      } else {
        untrackedSource = true;
        byPath.set(file.path, { ...file, changed: true });
      }
    }
    return { revision: { ...revision, dirty: revision.dirty || untrackedSource }, files: [...byPath.values()], usedFilesystemFallback: fallback.some((file) => !trackedPaths.has(file.path)) };
  } catch {
    const manifestFingerprint = fallback.find((file) => file.path === "composer.json")?.fingerprint ?? shortHash(repository.root);
    return { revision: { commit: repository.sourceRevision ?? `filesystem:${shortHash(manifestFingerprint)}`, dirty: false }, files: fallback, usedFilesystemFallback: true };
  }
}

async function gitRoot(directory: string): Promise<string | undefined> {
  try { return await realpath((await execFileAsync("git", ["-C", directory, "rev-parse", "--show-toplevel"], { encoding: "utf8", maxBuffer: 1024 * 1024 })).stdout.trim()); }
  catch { return undefined; }
}

async function gitRemote(directory: string): Promise<string | undefined> {
  try { return (await execFileAsync("git", ["-C", directory, "config", "--get", "remote.origin.url"], { encoding: "utf8", maxBuffer: 1024 * 1024 })).stdout.trim() || undefined; }
  catch { return undefined; }
}

/**
 * Discovers only packages that Composer both locked and installed. It never
 * enumerates arbitrary accessible repositories or recursively crawls vendor.
 */
export async function discoverComposerRepositories(parent: RepositoryRecord): Promise<RepositoryRecord[]> {
  const lock = await jsonFile<{ packages?: LockedPackage[]; "packages-dev"?: LockedPackage[] }>(path.join(parent.root, "composer.lock"));
  if (!lock) return [];
  const locked = new Map<string, LockedPackage>();
  for (const item of [...lock.packages ?? [], ...lock["packages-dev"] ?? []]) if (item.name) locked.set(item.name, item);
  const installedRaw = await jsonFile<{ packages?: InstalledPackage[] } | InstalledPackage[]>(path.join(parent.root, "vendor", "composer", "installed.json"));
  const installed = Array.isArray(installedRaw) ? installedRaw : installedRaw?.packages ?? [];
  const installedByName = new Map(installed.flatMap((item) => item.name ? [[item.name, item] as const] : []));
  const groups = new Map<string, { names: string[]; roots: string[]; revisions: string[]; remoteUrls: string[] }>();
  const parentRoot = await realpath(parent.root);
  for (const [name, lockedPackage] of locked) {
    const installedPackage = installedByName.get(name);
    const candidate = installedPackage?.["install-path"]
      ? path.resolve(parent.root, "vendor", "composer", installedPackage["install-path"])
      : path.resolve(parent.root, "vendor", ...name.split("/"));
    let packageRoot: string;
    try { packageRoot = await realpath(candidate); } catch { continue; }
    const manifest = await jsonFile<ComposerManifest>(path.join(packageRoot, "composer.json"));
    if (manifest?.name !== name) continue;
    const [linkedInstall, ownsGitCheckout] = await Promise.all([
      lstat(candidate).then((info) => info.isSymbolicLink()).catch(() => false),
      stat(path.join(packageRoot, ".git")).then(() => true).catch(() => false),
    ]);
    const detectedGitRoot = linkedInstall || ownsGitCheckout ? await gitRoot(packageRoot) : undefined;
    // Installed archives live beneath the consumer's Git root but are excluded
    // from the root scan. Treat them as revision-qualified filesystem packages;
    // only a nested/worktree Git root owns the installed checkout itself.
    const repositoryRoot = !detectedGitRoot || detectedGitRoot === parentRoot ? packageRoot : detectedGitRoot;
    const group = groups.get(repositoryRoot) ?? { names: [], roots: [], revisions: [], remoteUrls: [] };
    group.names.push(name); group.roots.push(packageRoot);
    const revision = lockedPackage.source?.reference; if (revision && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(revision)) group.revisions.push(revision);
    const actualRemote = detectedGitRoot ? await gitRemote(detectedGitRoot) : undefined;
    if (actualRemote) group.remoteUrls.push(actualRemote);
    else if (lockedPackage.source?.url) group.remoteUrls.push(lockedPackage.source.url);
    groups.set(repositoryRoot, group);
  }
  const discovered: RepositoryRecord[] = [];
  for (const [repositoryRoot, group] of groups) {
    const primaryName = group.names.sort()[0] ?? "package";
    const prefixes = group.roots.map((root) => normalize(path.relative(repositoryRoot, root))).filter(Boolean);
    const include = prefixes.length
      ? prefixes.flatMap((prefix) => [`${prefix}/*.php`, `${prefix}/**/*.php`, `${prefix}/composer.json`, `${prefix}/composer.lock`])
      : undefined;
    const revisions = [...new Set(group.revisions)];
    discovered.push({
      id: `composer:${primaryName.replace(/[^a-z0-9_.-]+/gi, "-")}:${shortHash(repositoryRoot)}`,
      root: repositoryRoot,
      ...(group.remoteUrls[0] ? { remoteUrl: group.remoteUrls[0] } : {}),
      ...(include ? { include } : {}),
      exclude: ["vendor/*", "vendor/**", "node_modules/*", "node_modules/**", "tmp/*", "tmp/**", "cache/*", "cache/**", ".git/*", ".git/**"],
      ...(revisions.length === 1 ? { sourceRevision: revisions[0] } : {}),
      discoveredFrom: parent.id,
      automatic: true,
    });
  }
  return discovered;
}
