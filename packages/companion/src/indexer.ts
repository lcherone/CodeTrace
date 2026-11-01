import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { IndexState } from "@trace/contracts";
import { parseComposer } from "./composer.js";
import { discoverComposerRepositories, discoverSourceInventory, discoverWatchTargets } from "./discovery.js";
import type { ComposerDependency, ComposerPackage, ParsedFile, RepositoryRecord } from "./model.js";
import { parsePhp, PHP_ANALYZER_VERSION, phpCacheKey } from "./php.js";
import { resolveRelationships, symbolsFromFiles } from "./relationships.js";
import { TraceStore } from "./store.js";

export type ScanStage = "queued" | "discovering" | "fingerprinting" | "analyzing" | "resolving" | "publishing" | "ready" | "failed" | "cancelled";
export type ScanReason = "initial" | "manual" | "filesystem" | "retry";

export interface ScannerState extends IndexState {
  jobId: string;
  stage: ScanStage;
  reason: ScanReason;
  requestedAt: string;
  startedAt?: string;
  completedAt?: string;
  queuePosition?: number;
  discoveredFiles: number;
  discoveredPackages: number;
  cacheHits: number;
  cacheMisses: number;
  analysisFailures: number;
  analyzedFiles: number;
  coalescedRequests: number;
  filesystemFallback: boolean;
  discoveryError?: string;
  durationMs?: number;
  filesPerSecond?: number;
}

export interface ScannerOptions {
  repositoryConcurrency?: number;
  analysisConcurrency?: number;
  maxQueue?: number;
  watchDebounceMs?: number;
  persistIntervalMs?: number;
  watchFileSystem?: boolean;
  discoverComposerPackages?: boolean;
}

export interface ScheduledScan { jobId: string; coalesced: boolean; promise: Promise<ScannerState> }

interface ScanJob {
  id: string;
  repository: RepositoryRecord;
  controller: AbortController;
  state: ScannerState;
  promise: Promise<ScannerState>;
  resolve: (state: ScannerState) => void;
  lastPersistedAt: number;
}

export class ScannerBackpressureError extends Error {
  readonly code = "SCANNER_BACKPRESSURE";
  constructor(readonly capacity: number) { super(`Scanner queue is at its bounded capacity of ${capacity}`); }
}

class AsyncSemaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly capacity: number) {}
  async use<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    await this.acquire(signal);
    try { return await task(); } finally { this.release(); }
  }
  private async acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.active < this.capacity) { this.active++; return; }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { const index = this.waiting.indexOf(grant); if (index >= 0) this.waiting.splice(index, 1); reject(signal.reason); };
      const grant = () => { signal.removeEventListener("abort", onAbort); this.active++; resolve(); };
      signal.addEventListener("abort", onAbort, { once: true }); this.waiting.push(grant);
    });
  }
  private release(): void { this.active--; this.waiting.shift()?.(); }
}

function matches(pathName: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const regex = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return regex.test(pathName) || pathName.startsWith(pattern.replace(/\*+$/, ""));
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const cancelledError = (message = "Indexing cancelled") => new DOMException(message, "AbortError");
const INDEX_FORMAT_VERSION = 1;

export class IndexCoordinator {
  private readonly repositoryConcurrency: number;
  private readonly maxQueue: number;
  private readonly debounceMs: number;
  private readonly persistIntervalMs: number;
  private readonly watchEnabled: boolean;
  private readonly discoveryEnabled: boolean;
  private readonly analysisSlots: AsyncSemaphore;
  private readonly queue: ScanJob[] = [];
  private readonly queuedByRepository = new Map<string, ScanJob>();
  private readonly activeByRepository = new Map<string, ScanJob>();
  private readonly states = new Map<string, ScannerState>();
  private readonly repositories = new Map<string, RepositoryRecord>();
  private readonly watchers = new Map<string, FSWatcher[]>();
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly capacityWaiters: Array<() => void> = [];
  private readonly discoveryTasks = new Set<Promise<void>>();
  private pumping = false;
  private closed = false;

  constructor(private readonly store: TraceStore, options: number | ScannerOptions = {}) {
    const normalized = typeof options === "number" ? { analysisConcurrency: options } : options;
    this.repositoryConcurrency = Math.max(1, normalized.repositoryConcurrency ?? 2);
    this.analysisSlots = new AsyncSemaphore(Math.max(this.repositoryConcurrency, normalized.analysisConcurrency ?? 8));
    this.maxQueue = Math.max(1, normalized.maxQueue ?? 512);
    this.debounceMs = Math.max(25, normalized.watchDebounceMs ?? 400);
    this.persistIntervalMs = Math.max(25, normalized.persistIntervalMs ?? 150);
    this.watchEnabled = normalized.watchFileSystem ?? true;
    this.discoveryEnabled = normalized.discoverComposerPackages ?? true;
  }

  state(repositoryId: string): ScannerState | undefined { return this.activeByRepository.get(repositoryId)?.state ?? this.queuedByRepository.get(repositoryId)?.state ?? this.states.get(repositoryId); }
  statesList(): ScannerState[] {
    const live = [...this.activeByRepository.values(), ...this.queue];
    const liveRepositories = new Set(live.map((job) => job.repository.id));
    return [...live.map((job) => job.state), ...[...this.states.entries()].filter(([repositoryId]) => !liveRepositories.has(repositoryId)).map(([, state]) => state)]
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
  }
  snapshot(): { queued: number; active: number; capacity: number; repositoryConcurrency: number; watched: number; repositories: number; closed: boolean } {
    return { queued: this.queue.length, active: this.activeByRepository.size, capacity: this.maxQueue, repositoryConcurrency: this.repositoryConcurrency, watched: this.watchers.size, repositories: this.repositories.size, closed: this.closed };
  }

  start(repositories: RepositoryRecord[]): void { for (const repository of repositories) this.addRepository(repository, true); }

  addRepository(repository: RepositoryRecord, initialScan = false): void {
    const existingByRoot = [...this.repositories.values()].find((candidate) => candidate.root === repository.root);
    if (existingByRoot && existingByRoot.id !== repository.id) return;
    this.repositories.set(repository.id, repository);
    if (this.watchEnabled) this.watchRepository(repository);
    if (initialScan) void this.enqueueWhenCapacity(repository, "initial");
    if (this.discoveryEnabled && !repository.automatic) this.discoverNestedRepositories(repository);
  }

  removeRepository(repositoryId: string): void {
    this.repositories.delete(repositoryId);
    this.watchers.get(repositoryId)?.forEach((watcher) => watcher.close()); this.watchers.delete(repositoryId);
    const timer = this.debounceTimers.get(repositoryId); if (timer) clearTimeout(timer);
    this.debounceTimers.delete(repositoryId); this.cancel(repositoryId);
  }

  async index(repository: RepositoryRecord): Promise<ScannerState> { return this.schedule(repository, "manual").promise; }

  schedule(repository: RepositoryRecord, reason: ScanReason = "manual"): ScheduledScan {
    if (this.closed) throw new Error("Scanner is closed");
    this.repositories.set(repository.id, repository);
    const queued = this.queuedByRepository.get(repository.id);
    if (queued) {
      queued.state.coalescedRequests++;
      if (reason === "manual" || reason === "retry") queued.state.reason = reason;
      this.persist(queued, true);
      return { jobId: queued.id, coalesced: true, promise: queued.promise };
    }
    const active = this.activeByRepository.get(repository.id);
    if (active && reason !== "filesystem") {
      active.state.coalescedRequests++; this.persist(active, true);
      return { jobId: active.id, coalesced: true, promise: active.promise };
    }
    if (this.queue.length >= this.maxQueue) throw new ScannerBackpressureError(this.maxQueue);
    const completion = deferred<ScannerState>(); const requestedAt = new Date().toISOString(); const id = randomUUID();
    const job: ScanJob = {
      id, repository, controller: new AbortController(), promise: completion.promise, resolve: completion.resolve, lastPersistedAt: 0,
      state: { repositoryId: repository.id, state: "queued", generation: 0, completedFiles: 0, totalFiles: 0, jobId: id, stage: "queued", reason, requestedAt, queuePosition: this.queue.length + 1, discoveredFiles: 0, discoveredPackages: 0, cacheHits: 0, cacheMisses: 0, analysisFailures: 0, analyzedFiles: 0, coalescedRequests: 0, filesystemFallback: false },
    };
    this.queue.push(job); this.queuedByRepository.set(repository.id, job); this.states.set(repository.id, job.state);
    this.repositionQueue(); this.persist(job, true); queueMicrotask(() => this.pump());
    return { jobId: job.id, coalesced: false, promise: job.promise };
  }

  cancel(repositoryId: string): boolean {
    const active = this.activeByRepository.get(repositoryId);
    if (active) active.controller.abort(cancelledError());
    const queued = this.queuedByRepository.get(repositoryId);
    if (queued) {
      const index = this.queue.indexOf(queued); if (index >= 0) this.queue.splice(index, 1);
      this.queuedByRepository.delete(repositoryId);
      const state: ScannerState = { ...queued.state, state: "cancelled", stage: "cancelled", completedAt: new Date().toISOString(), error: "Indexing cancelled before it started" };
      queued.state = state; if (!active) this.states.set(repositoryId, state); this.persist(queued, true); queued.resolve(state);
      this.repositionQueue(); this.signalCapacity();
    }
    return Boolean(active || queued);
  }

  notifyFilesystemChange(repositoryId: string, changedPath: string): boolean {
    const normalized = changedPath.replaceAll("\\", "/");
    if (!(normalized.endsWith(".php") || ["composer.json", "composer.lock"].includes(path.basename(normalized)) || [".git/index", ".git/HEAD"].includes(normalized))) return false;
    if (["vendor", "node_modules", "tmp", "cache"].some((segment) => normalized.startsWith(`${segment}/`) || normalized.includes(`/${segment}/`))) return false;
    const repository = this.repositories.get(repositoryId); if (!repository) return false;
    const previous = this.debounceTimers.get(repositoryId); if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(repositoryId);
      try { this.schedule(repository, "filesystem"); }
      catch (error) { if (error instanceof ScannerBackpressureError) void this.enqueueWhenCapacity(repository, "filesystem"); }
    }, this.debounceMs);
    timer.unref(); this.debounceTimers.set(repositoryId, timer); return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.capacityWaiters.length) this.capacityWaiters.shift()?.();
    for (const watchers of this.watchers.values()) watchers.forEach((watcher) => watcher.close()); this.watchers.clear();
    for (const timer of this.debounceTimers.values()) clearTimeout(timer); this.debounceTimers.clear();
    for (const job of [...this.queue]) this.cancel(job.repository.id);
    const active = [...this.activeByRepository.values()]; active.forEach((job) => job.controller.abort(cancelledError("Companion is shutting down")));
    await Promise.allSettled([...active.map((job) => job.promise), ...this.discoveryTasks]);
  }

  private discoverNestedRepositories(repository: RepositoryRecord): void {
    const task = discoverComposerRepositories(repository).then((discovered) => {
      if (this.closed) return;
      const unique = discovered.filter((candidate) => ![...this.repositories.values()].some((known) => known.root === candidate.root));
      const state = this.states.get(repository.id); if (state) state.discoveredPackages += unique.length;
      for (const candidate of unique) { this.store.upsertRepository(candidate); this.addRepository(candidate, true); }
    }).catch((error) => {
      const state = this.states.get(repository.id);
      if (state) state.discoveryError = error instanceof Error ? error.message : String(error);
    }).finally(() => this.discoveryTasks.delete(task));
    this.discoveryTasks.add(task);
  }

  private watchRepository(repository: RepositoryRecord): void {
    this.watchers.get(repository.id)?.forEach((watcher) => watcher.close());
    const task = discoverWatchTargets(repository).then(async (targets) => {
      if (this.closed) return;
      const watchers: FSWatcher[] = [];
      for (const target of targets) {
        try {
          const info = await stat(target);
          const watcher = watch(target, { recursive: info.isDirectory(), persistent: false }, (_event, filename) => {
            const changed = info.isDirectory() && filename ? path.relative(repository.root, path.join(target, filename.toString())) : path.relative(repository.root, target);
            this.notifyFilesystemChange(repository.id, changed);
          });
          watcher.on("error", () => watcher.close()); watchers.push(watcher);
        } catch { /* Manual refresh remains available when a target cannot be watched. */ }
      }
      if (watchers.length) this.watchers.set(repository.id, watchers);
    }).finally(() => this.discoveryTasks.delete(task));
    this.discoveryTasks.add(task);
  }

  private async enqueueWhenCapacity(repository: RepositoryRecord, reason: ScanReason): Promise<void> {
    while (!this.closed) {
      try { this.schedule(repository, reason); return; }
      catch (error) { if (!(error instanceof ScannerBackpressureError)) throw error; await new Promise<void>((resolve) => this.capacityWaiters.push(resolve)); }
    }
  }

  private pump(): void {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      while (this.activeByRepository.size < this.repositoryConcurrency) {
        const index = this.queue.findIndex((job) => !this.activeByRepository.has(job.repository.id)); if (index < 0) break;
        const [job] = this.queue.splice(index, 1); if (!job) break;
        this.queuedByRepository.delete(job.repository.id); this.activeByRepository.set(job.repository.id, job);
        this.repositionQueue(); this.signalCapacity();
        void this.run(job).then((state) => {
          this.activeByRepository.delete(job.repository.id);
          job.resolve(state);
          this.pump();
        });
      }
    } finally { this.pumping = false; }
  }

  private async run(job: ScanJob): Promise<ScannerState> {
    const started = Date.now(); let generation = 0;
    try {
      delete job.state.queuePosition;
      this.update(job, { state: "running", stage: "discovering", startedAt: new Date(started).toISOString() }, true);
      const inventory = await discoverSourceInventory(job.repository); job.controller.signal.throwIfAborted();
      const include = job.repository.include?.length ? job.repository.include : ["*.php", "**/*.php", "composer.json", "**/composer.json", "composer.lock", "**/composer.lock"];
      const exclude = job.repository.exclude ?? ["vendor/*", "vendor/**", "node_modules/*", "node_modules/**", "tmp/*", "tmp/**", "cache/*", "cache/**", ".git/*", ".git/**"];
      const files = inventory.files.filter((file) => matches(file.path, include) && !matches(file.path, exclude)).sort((left, right) => left.path.localeCompare(right.path));
      const phpFiles = files.filter((file) => file.path.endsWith(".php"));
      const inventoryHash = createHash("sha256").update(`trace-index:${INDEX_FORMAT_VERSION}:php:${PHP_ANALYZER_VERSION}\0`);
      for (const file of files) inventoryHash.update(file.path).update("\0").update(file.fingerprint).update("\0");
      const inventoryFingerprint = inventoryHash.digest("hex");
      const currentGeneration = this.store.currentGeneration(job.repository.id, inventory.revision.commit, inventoryFingerprint);
      if (currentGeneration) {
        const durationMs = Math.max(1, Date.now() - started);
        this.update(job, {
          state: "ready", stage: "ready", generation: currentGeneration, totalFiles: files.length, completedFiles: files.length,
          discoveredFiles: files.length, indexedCommit: inventory.revision.commit, filesystemFallback: inventory.usedFilesystemFallback,
          cacheHits: phpFiles.length, completedAt: new Date().toISOString(), durationMs,
          filesPerSecond: Number((files.length / (durationMs / 1000)).toFixed(1)),
        }, true);
        return job.state;
      }
      generation = this.store.beginGeneration(job.repository.id, inventory.revision.commit, inventory.revision.branch, inventory.revision.dirty, files.length);
      this.update(job, { generation, totalFiles: files.length, discoveredFiles: files.length, indexedCommit: inventory.revision.commit, stage: "fingerprinting", filesystemFallback: inventory.usedFilesystemFallback }, true);

      const analyses: ParsedFile[] = new Array(phpFiles.length);
      await Promise.all(phpFiles.map((file, index) => this.analysisSlots.use(job.controller.signal, async () => {
        job.controller.signal.throwIfAborted(); let source: string | undefined; let fingerprint = `php:${PHP_ANALYZER_VERSION}:${file.fingerprint}`;
        if (file.changed) { source = await readFile(path.join(job.repository.root, file.path), "utf8"); fingerprint = `php:${PHP_ANALYZER_VERSION}:worktree:${phpCacheKey(source)}`; }
        let analysis = this.store.cachedFileByFingerprint(job.repository.id, file.path, fingerprint);
        if (analysis) {
          job.state.cacheHits++;
          if (analysis.limitations.some((limitation) => limitation.startsWith("Static analysis skipped this file:"))) job.state.analysisFailures++;
        }
        else {
          source ??= await readFile(path.join(job.repository.root, file.path), "utf8");
          try {
            analysis = parsePhp(source, file.path);
          } catch (error) {
            job.state.analysisFailures++;
            analysis = {
              path: file.path,
              contentHash: phpCacheKey(source),
              namespace: "",
              imports: {},
              types: [],
              limitations: [`Static analysis skipped this file: ${error instanceof Error ? error.message : "unsupported PHP syntax"}`],
            };
          }
          this.store.cacheFile(job.repository.id, analysis, fingerprint); job.state.cacheMisses++; job.state.analyzedFiles++;
        }
        analyses[index] = analysis; job.state.completedFiles++; this.update(job, { stage: "analyzing" });
      })));

      const packages: ComposerPackage[] = []; const dependencies: ComposerDependency[] = [];
      const canonicalRepositoryRoot = await realpath(job.repository.root);
      for (const manifest of files.filter((file) => path.basename(file.path) === "composer.json")) {
        job.controller.signal.throwIfAborted(); const rootPath = path.dirname(manifest.path) === "." ? "" : path.dirname(manifest.path); const lockPath = path.join(rootPath, "composer.lock");
        const manifestText = await readFile(path.join(job.repository.root, manifest.path), "utf8"); let lockText: string | undefined;
        if (files.some((file) => file.path === lockPath)) lockText = await readFile(path.join(job.repository.root, lockPath), "utf8");
        let installedPackages: Array<{ name?: string; "install-path"?: string }> = [];
        try {
          const raw = JSON.parse(await readFile(path.join(job.repository.root, rootPath, "vendor/composer/installed.json"), "utf8")) as { packages?: typeof installedPackages } | typeof installedPackages;
          installedPackages = Array.isArray(raw) ? raw : raw.packages ?? [];
        } catch { /* Installed metadata is optional and is never recursively crawled. */ }
        const result = parseComposer(job.repository.id, generation, rootPath, manifestText, lockText, { repositoryPath: canonicalRepositoryRoot, ...(job.repository.remoteUrl ? { repositoryUrl: job.repository.remoteUrl } : {}), installedPackages }); result.pkg.sourceCommit = inventory.revision.commit;
        for (const dependency of result.dependencies) if (dependency.resolvedPath) {
          try { dependency.resolvedPath = await realpath(dependency.resolvedPath); } catch { /* Preserve lexical path evidence when the install is absent. */ }
        }
        for (const dependency of result.dependencies) for (const candidate of dependency.repositoryCandidates ?? []) if (candidate.resolvedPath) {
          try { candidate.resolvedPath = await realpath(candidate.resolvedPath); } catch { /* Preserve configured path evidence when absent. */ }
        }
        packages.push(result.pkg); dependencies.push(...result.dependencies); job.state.completedFiles += 1 + (lockText ? 1 : 0); this.update(job, { stage: "analyzing" });
      }

      job.controller.signal.throwIfAborted(); this.update(job, { stage: "resolving", completedFiles: Math.min(files.length, job.state.completedFiles) }, true);
      const symbols = symbolsFromFiles(job.repository.id, generation, inventory.revision.commit, analyses); const relationships = resolveRelationships(job.repository.id, generation, inventory.revision.commit, symbols);
      job.controller.signal.throwIfAborted(); this.update(job, { stage: "publishing" }, true);
      this.store.publishGeneration(generation, job.repository.id, inventoryFingerprint, symbols, relationships, packages, dependencies);
      const durationMs = Math.max(1, Date.now() - started);
      this.update(job, { state: "ready", stage: "ready", completedFiles: files.length, completedAt: new Date().toISOString(), durationMs, filesPerSecond: Number((files.length / (durationMs / 1000)).toFixed(1)) }, true);
      return job.state;
    } catch (error) {
      const cancelled = job.controller.signal.aborted || error instanceof DOMException && error.name === "AbortError"; const message = cancelled ? "Indexing cancelled" : error instanceof Error ? error.message : String(error);
      if (generation) this.store.failGeneration(generation, cancelled ? "cancelled" : "failed", message);
      this.update(job, { state: cancelled ? "cancelled" : "failed", stage: cancelled ? "cancelled" : "failed", completedAt: new Date().toISOString(), durationMs: Math.max(1, Date.now() - started), error: message }, true);
      return job.state;
    }
  }

  private update(job: ScanJob, patch: Partial<ScannerState>, force = false): void {
    job.state = { ...job.state, ...patch };
    this.states.set(job.repository.id, job.state);
    if (job.state.generation && job.state.state === "running" && (force || Date.now() - job.lastPersistedAt >= this.persistIntervalMs)) this.store.updateProgress(job.state.generation, job.state.completedFiles);
    this.persist(job, force);
  }
  private persist(job: ScanJob, force = false): void {
    const now = Date.now(); if (!force && now - job.lastPersistedAt < this.persistIntervalMs) return; job.lastPersistedAt = now;
    this.store.saveScanJob({ id: job.id, repositoryId: job.repository.id, state: job.state.state, requestedAt: job.state.requestedAt, updatedAt: new Date(now).toISOString(), status: { ...job.state } });
  }
  private repositionQueue(): void { this.queue.forEach((job, index) => { job.state.queuePosition = index + 1; this.states.set(job.repository.id, job.state); this.persist(job); }); }
  private signalCapacity(): void { while (this.queue.length < this.maxQueue && this.capacityWaiters.length) this.capacityWaiters.shift()?.(); }
}
