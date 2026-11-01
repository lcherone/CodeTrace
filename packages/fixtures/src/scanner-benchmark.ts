import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_INCLUDE = ["*.php", "**/*.php", "composer.json", "**/composer.json", "composer.lock", "**/composer.lock"];
export const DEFAULT_EXCLUDE = ["vendor/*", "vendor/**", "node_modules/*", "node_modules/**", ".git/*", ".git/**"];

type ErrorCategory = "not-found" | "permission" | "io" | "other";
type SizeBucket = "under-4-kib" | "4-to-64-kib" | "64-kib-to-1-mib" | "1-to-16-mib" | "over-16-mib";

export interface ScannerBenchmarkOptions {
  root: string;
  source?: "auto" | "git-tracked" | "composer-installed";
  concurrency?: number[];
  iterations?: number;
  warmup?: number;
  include?: string[];
  exclude?: string[];
  maxFileBytes?: number;
}

export interface Distribution {
  min: number;
  median: number;
  p95: number;
  max: number;
  mean: number;
}

export interface ScannerBenchmarkReport {
  schemaVersion: 1;
  tool: "trace-scanner-benchmark";
  privacy: {
    pathDisclosure: "suppressed";
    contentDisclosure: "suppressed";
    rawErrors: "suppressed";
  };
  configuration: {
    source: "auto" | "git-tracked" | "composer-installed";
    concurrency: number[];
    iterations: number;
    warmup: number;
    includePatternCount: number;
    excludePatternCount: number;
    maxFileBytes: number;
  };
  inventory: {
    discoveredFiles: number;
    discovery: {
      rootGitFiles: number;
      composerPackages: number;
      nestedGitRepositories: number;
      filesystemPackageRoots: number;
      errors: number;
    };
    selectedFiles: number;
    readableFiles: number;
    bytes: number;
    categories: {
      php: number;
      composerManifest: number;
      composerLock: number;
      other: number;
    };
    sizeBuckets: Record<SizeBucket, number>;
    skipped: {
      unsafePath: number;
      symbolicLink: number;
      nonFile: number;
      oversized: number;
      metadataError: number;
    };
  };
  loads: Array<{
    concurrency: number;
    samples: number;
    durationMs: Distribution;
    filesPerSecond: Distribution;
    mebibytesPerSecond: Distribution;
  }>;
  errors: {
    count: number;
    categories: Record<ErrorCategory, number>;
  };
}

interface Candidate {
  absolutePath: string;
  bytes: number;
}

interface DiscoveredFile {
  absolutePath: string;
  matchPath: string;
}

interface DiscoveryResult {
  files: DiscoveredFile[];
  aggregate: ScannerBenchmarkReport["inventory"]["discovery"];
}

interface ErrorAggregate {
  count: number;
  categories: Record<ErrorCategory, number>;
}

export class ScannerBenchmarkError extends Error {
  constructor(readonly code: "invalid-options" | "git-inventory-failed" | "no-selected-files") {
    super(code);
    this.name = "ScannerBenchmarkError";
  }
}

function matches(pathName: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const regex = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return regex.test(pathName) || pathName.startsWith(pattern.replace(/\*+$/, ""));
  });
}

function validatePositiveInteger(value: number, allowZero = false): boolean {
  return Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0);
}

function classifyError(error: unknown): ErrorCategory {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code === "ENOENT") return "not-found";
  if (code === "EACCES" || code === "EPERM") return "permission";
  if (code.startsWith("E")) return "io";
  return "other";
}

function recordError(aggregate: ErrorAggregate, error: unknown): void {
  aggregate.count += 1;
  aggregate.categories[classifyError(error)] += 1;
}

function sizeBucket(bytes: number): SizeBucket {
  if (bytes < 4 * 1024) return "under-4-kib";
  if (bytes < 64 * 1024) return "4-to-64-kib";
  if (bytes < 1024 * 1024) return "64-kib-to-1-mib";
  if (bytes < 16 * 1024 * 1024) return "1-to-16-mib";
  return "over-16-mib";
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function distribution(values: number[]): Distribution {
  if (values.length === 0) return { min: 0, median: 0, p95: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: round(sorted[0] ?? 0),
    median: round(median(sorted)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted.at(-1) ?? 0),
    mean: round(values.reduce((total, value) => total + value, 0) / values.length),
  };
}

async function gitFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
    return stdout.split("\0").filter(Boolean);
  } catch {
    throw new ScannerBenchmarkError("git-inventory-failed");
  }
}

async function exists(pathName: string): Promise<boolean> {
  try { await lstat(pathName); return true; } catch { return false; }
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function walkFiles(root: string, current = root): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "vendor" || entry.name === "node_modules") continue;
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) results.push(...await walkFiles(root, absolutePath));
    else results.push(path.relative(root, absolutePath).split(path.sep).join("/"));
  }
  return results;
}

interface ComposerInstalledPackage {
  name?: unknown;
  "install-path"?: unknown;
  install_path?: unknown;
}

async function composerPackageRoots(root: string): Promise<string[]> {
  const installedPath = path.join(root, "vendor", "composer", "installed.json");
  const roots: string[] = [];
  if (await exists(installedPath)) {
    const parsed = JSON.parse(await readFile(installedPath, "utf8")) as unknown;
    const packages: ComposerInstalledPackage[] = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && "packages" in parsed && Array.isArray(parsed.packages)
        ? parsed.packages as ComposerInstalledPackage[]
        : [];
    for (const pkg of packages) {
      const name = typeof pkg.name === "string" ? pkg.name : undefined;
      const installPath = typeof pkg["install-path"] === "string" ? pkg["install-path"] : typeof pkg.install_path === "string" ? pkg.install_path : undefined;
      const packageRoot = installPath ? path.resolve(path.dirname(installedPath), installPath) : name ? path.resolve(root, "vendor", name) : undefined;
      if (packageRoot && within(root, packageRoot) && await exists(packageRoot)) {
        const canonicalPackageRoot = await realpath(packageRoot);
        if (within(root, canonicalPackageRoot)) roots.push(canonicalPackageRoot);
      }
    }
  } else {
    const lockPath = path.join(root, "composer.lock");
    if (await exists(lockPath)) {
      const parsed = JSON.parse(await readFile(lockPath, "utf8")) as { packages?: Array<{ name?: unknown }>; "packages-dev"?: Array<{ name?: unknown }> };
      for (const pkg of [...(parsed.packages ?? []), ...(parsed["packages-dev"] ?? [])]) {
        if (typeof pkg.name !== "string") continue;
        const packageRoot = path.resolve(root, "vendor", pkg.name);
        if (within(root, packageRoot) && await exists(packageRoot)) {
          const canonicalPackageRoot = await realpath(packageRoot);
          if (within(root, canonicalPackageRoot)) roots.push(canonicalPackageRoot);
        }
      }
    }
  }
  return [...new Set(roots)];
}

async function discover(root: string, source: NonNullable<ScannerBenchmarkOptions["source"]>): Promise<DiscoveryResult> {
  const files = new Map<string, DiscoveredFile>();
  const aggregate = { rootGitFiles: 0, composerPackages: 0, nestedGitRepositories: 0, filesystemPackageRoots: 0, errors: 0 };
  const add = (absoluteRoot: string, relativePaths: string[]): void => {
    for (const matchPath of relativePaths) {
      const absolutePath = path.resolve(absoluteRoot, matchPath);
      if (within(absoluteRoot, absolutePath)) files.set(absolutePath, { absolutePath, matchPath: matchPath.split(path.sep).join("/") });
    }
  };

  if (source !== "composer-installed") {
    try {
      const rootFiles = await gitFiles(root);
      aggregate.rootGitFiles = rootFiles.length;
      add(root, rootFiles);
    } catch (error) {
      if (source === "git-tracked") throw error;
      aggregate.errors += 1;
    }
  }

  if (source !== "git-tracked") {
    for (const rootFile of ["composer.json", "composer.lock"]) if (await exists(path.join(root, rootFile))) add(root, [rootFile]);
    let packageRoots: string[] = [];
    try { packageRoots = await composerPackageRoots(root); } catch { aggregate.errors += 1; }
    aggregate.composerPackages = packageRoots.length;
    for (const packageRoot of packageRoots) {
      try {
        if (await exists(path.join(packageRoot, ".git"))) {
          const packageFiles = await gitFiles(packageRoot);
          aggregate.nestedGitRepositories += 1;
          add(packageRoot, packageFiles);
        } else {
          aggregate.filesystemPackageRoots += 1;
          add(packageRoot, await walkFiles(packageRoot));
        }
      } catch {
        aggregate.errors += 1;
      }
    }
  }
  return { files: [...files.values()], aggregate };
}

async function streamAndHash(candidate: Candidate): Promise<void> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(candidate.absolutePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  hash.digest();
}

async function runLoad(candidates: Candidate[], concurrency: number, errors: ErrorAggregate): Promise<number> {
  let cursor = 0;
  const started = performance.now();
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, candidates.length)) }, async () => {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++];
      if (!candidate) continue;
      try {
        await streamAndHash(candidate);
      } catch (error) {
        recordError(errors, error);
      }
    }
  });
  await Promise.all(workers);
  return performance.now() - started;
}

export async function runScannerBenchmark(options: ScannerBenchmarkOptions): Promise<ScannerBenchmarkReport> {
  const concurrency = [...new Set(options.concurrency ?? [1, 2, 4])].sort((left, right) => left - right);
  const iterations = options.iterations ?? 3;
  const warmup = options.warmup ?? 1;
  const include = options.include?.length ? options.include : DEFAULT_INCLUDE;
  const exclude = options.exclude ?? DEFAULT_EXCLUDE;
  const maxFileBytes = options.maxFileBytes ?? 64 * 1024 * 1024;
  const source = options.source ?? "auto";
  if (!options.root || !concurrency.length || concurrency.some((value) => !validatePositiveInteger(value)) || !validatePositiveInteger(iterations) || !validatePositiveInteger(warmup, true) || !validatePositiveInteger(maxFileBytes)) {
    throw new ScannerBenchmarkError("invalid-options");
  }

  let root: string;
  try { root = await realpath(path.resolve(options.root)); } catch { throw new ScannerBenchmarkError("git-inventory-failed"); }
  const discovery = await discover(root, source);
  const files = discovery.files;
  const selected = files.filter((file) => matches(file.matchPath, include) && !matches(file.matchPath, exclude));
  if (!selected.length) throw new ScannerBenchmarkError("no-selected-files");

  const errors: ErrorAggregate = { count: 0, categories: { "not-found": 0, permission: 0, io: 0, other: 0 } };
  const sizeBuckets: Record<SizeBucket, number> = { "under-4-kib": 0, "4-to-64-kib": 0, "64-kib-to-1-mib": 0, "1-to-16-mib": 0, "over-16-mib": 0 };
  const skipped = { unsafePath: 0, symbolicLink: 0, nonFile: 0, oversized: 0, metadataError: 0 };
  const categories = { php: 0, composerManifest: 0, composerLock: 0, other: 0 };
  const candidates: Candidate[] = [];

  for (const discovered of selected) {
    const { absolutePath, matchPath } = discovered;
    if (!within(root, absolutePath)) { skipped.unsafePath += 1; continue; }
    try {
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) { skipped.symbolicLink += 1; continue; }
      if (!info.isFile()) { skipped.nonFile += 1; continue; }
      sizeBuckets[sizeBucket(info.size)] += 1;
      const basename = path.basename(matchPath);
      if (matchPath.endsWith(".php")) categories.php += 1;
      else if (basename === "composer.json") categories.composerManifest += 1;
      else if (basename === "composer.lock") categories.composerLock += 1;
      else categories.other += 1;
      if (info.size > maxFileBytes) { skipped.oversized += 1; continue; }
      candidates.push({ absolutePath, bytes: info.size });
    } catch (error) {
      skipped.metadataError += 1;
      recordError(errors, error);
    }
  }

  if (!candidates.length) throw new ScannerBenchmarkError("no-selected-files");
  const bytes = candidates.reduce((total, candidate) => total + candidate.bytes, 0);
  const loads: ScannerBenchmarkReport["loads"] = [];
  for (const workerCount of concurrency) {
    for (let index = 0; index < warmup; index += 1) await runLoad(candidates, workerCount, errors);
    const durations: number[] = [];
    for (let index = 0; index < iterations; index += 1) durations.push(await runLoad(candidates, workerCount, errors));
    const seconds = durations.map((duration) => Math.max(duration / 1000, Number.EPSILON));
    loads.push({
      concurrency: workerCount,
      samples: durations.length,
      durationMs: distribution(durations),
      filesPerSecond: distribution(seconds.map((duration) => candidates.length / duration)),
      mebibytesPerSecond: distribution(seconds.map((duration) => bytes / 1024 / 1024 / duration)),
    });
  }

  return {
    schemaVersion: 1,
    tool: "trace-scanner-benchmark",
    privacy: { pathDisclosure: "suppressed", contentDisclosure: "suppressed", rawErrors: "suppressed" },
    configuration: { source, concurrency, iterations, warmup, includePatternCount: include.length, excludePatternCount: exclude.length, maxFileBytes },
    inventory: { discoveredFiles: files.length, discovery: discovery.aggregate, selectedFiles: selected.length, readableFiles: candidates.length, bytes, categories, sizeBuckets, skipped },
    loads,
    errors,
  };
}
