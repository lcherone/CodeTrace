import type { IndexState } from "@trace/contracts";

export type ScanPhase = "idle" | "discovering" | "queued" | "indexing" | "ready" | "paused" | "degraded";

export type ScanSummary = {
  phase: ScanPhase;
  discoveredRepositories: number;
  queuedRepositories: number;
  runningRepositories: number;
  readyRepositories: number;
  failedRepositories: number;
  completedFiles: number;
  totalFiles: number;
  discoveryTruncated: boolean;
  blockedCode?: string;
};

export type DiscoveredRepositories = { roots: string[]; truncated: boolean };
export type RepositorySnapshot = { root: string; repositoryId: string; state: "ready" | "running" | "queued" | "failed" | "cancelled" };

type RepositoryWork = {
  root: string;
  force: boolean;
  phase: "pending" | "queued" | "running" | "ready" | "failed";
  repositoryId?: string;
  dirtyWhileRunning: boolean;
  job?: IndexState;
};

export type ScanCoordinatorOptions = {
  discover(signal: AbortSignal): Promise<DiscoveredRepositories>;
  snapshot(signal: AbortSignal): Promise<RepositorySnapshot[]>;
  enqueue(root: string, signal: AbortSignal): Promise<{ queued: string }>;
  jobs(signal: AbortSignal): Promise<IndexState[]>;
  errorCode(error: unknown): string | undefined;
  onSummary(summary: ScanSummary): void;
  maxConcurrentRepositories?: number;
  pollIntervalMs?: number;
  retryIntervalMs?: number;
};

export class ScanCoordinator {
  private readonly work = new Map<string, RepositoryWork>();
  private discoveryTimer: NodeJS.Timeout | undefined;
  private readonly repositoryTimers = new Map<string, NodeJS.Timeout>();
  private pollTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private controller = new AbortController();
  private discovering = false;
  private discoveryAgain = false;
  private draining = false;
  private drainAgain = false;
  private disposed = false;
  private discoveryTruncated = false;
  private blockedCode: string | undefined;
  private lastSummaryKey = "";

  constructor(private readonly options: ScanCoordinatorOptions) {}

  scheduleDiscovery(delayMs: number): void {
    if (this.disposed) return;
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    this.discoveryTimer = setTimeout(() => {
      this.discoveryTimer = undefined;
      void this.runDiscovery();
    }, Math.max(0, delayMs));
  }

  cancelScheduled(): void {
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    this.discoveryTimer = undefined;
    for (const timer of this.repositoryTimers.values()) clearTimeout(timer);
    this.repositoryTimers.clear();
  }

  requestRepository(root: string, force = false): void {
    if (this.disposed || !root) return;
    const current = this.work.get(root);
    if (!current) {
      this.work.set(root, { root, force, phase: "pending", dirtyWhileRunning: false });
    } else if (current.phase === "queued" || current.phase === "running") {
      if (force) current.dirtyWhileRunning = true;
    } else if (force || current.phase === "failed") {
      current.force ||= force;
      current.phase = "pending";
      delete current.job;
    }
    this.emitSummary();
    if (!this.blockedCode) void this.drain();
  }

  scheduleRepository(root: string, delayMs: number, force = false): void {
    if (this.disposed || !root) return;
    const existing = this.repositoryTimers.get(root);
    if (existing) clearTimeout(existing);
    this.repositoryTimers.set(root, setTimeout(() => {
      this.repositoryTimers.delete(root);
      this.requestRepository(root, force);
    }, Math.max(0, delayMs)));
  }

  resume(): void {
    if (this.disposed) return;
    this.blockedCode = undefined;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.emitSummary();
    if (this.discoveryAgain) {
      this.discoveryAgain = false;
      this.scheduleDiscovery(0);
    }
    void this.drain();
    if ([...this.work.values()].some((item) => item.phase === "queued" || item.phase === "running")) this.schedulePoll(0);
  }

  dispose(): void {
    this.disposed = true;
    this.controller.abort();
    this.cancelScheduled();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  private async runDiscovery(): Promise<void> {
    if (this.disposed) return;
    if (this.discovering) {
      this.discoveryAgain = true;
      return;
    }
    this.discovering = true;
    this.emitSummary();
    try {
      const result = await this.options.discover(this.controller.signal);
      this.discoveryTruncated = result.truncated;
      for (const root of result.roots) this.requestRepository(root, false);
    } catch (error) {
      if (!this.controller.signal.aborted) {
        this.discoveryAgain = true;
        this.pauseFor(error);
      }
    } finally {
      this.discovering = false;
      this.emitSummary();
      if (this.discoveryAgain && !this.blockedCode) {
        this.discoveryAgain = false;
        this.scheduleDiscovery(0);
      }
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    if (this.disposed || this.blockedCode) return;
    this.draining = true;
    try {
      const pending = [...this.work.values()].filter((item) => item.phase === "pending");
      if (!pending.length) return;
      const snapshot = await this.options.snapshot(this.controller.signal);
      const existingByRoot = new Map(snapshot.map((item) => [item.root, item]));
      const maximumActive = Math.max(1, this.options.maxConcurrentRepositories ?? 2);
      let active = [...this.work.values()].filter((item) => item.phase === "queued" || item.phase === "running").length;
      for (const item of pending) {
        if (this.disposed || this.blockedCode) break;
        const existing = existingByRoot.get(item.root);
        if (existing && !item.force) {
          item.repositoryId = existing.repositoryId;
          item.phase = existing.state === "running" || existing.state === "queued" ? existing.state : existing.state === "ready" ? "ready" : "pending";
          if (item.phase !== "pending") {
            if (item.phase === "running" || item.phase === "queued") active++;
            this.emitSummary();
            continue;
          }
        }
        if (existing && item.force && (existing.state === "running" || existing.state === "queued")) {
          item.repositoryId = existing.repositoryId;
          item.phase = existing.state;
          item.dirtyWhileRunning = true;
          active++;
          this.emitSummary();
          continue;
        }
        if (active >= maximumActive) continue;
        try {
          const response = await this.options.enqueue(item.root, this.controller.signal);
          item.repositoryId = response.queued;
          item.phase = "queued";
          item.force = false;
          active++;
          this.emitSummary();
        } catch (error) {
          this.pauseFor(error);
          break;
        }
      }
      if ([...this.work.values()].some((item) => item.phase === "queued" || item.phase === "running")) this.schedulePoll(0);
    } catch (error) {
      if (!this.controller.signal.aborted) this.pauseFor(error);
    } finally {
      this.draining = false;
      const rerun = this.drainAgain;
      this.drainAgain = false;
      const maximumActive = Math.max(1, this.options.maxConcurrentRepositories ?? 2);
      const active = [...this.work.values()].filter((item) => item.phase === "queued" || item.phase === "running").length;
      if (rerun && active < maximumActive && !this.disposed && !this.blockedCode) queueMicrotask(() => void this.drain());
    }
  }

  private schedulePoll(delay = this.options.pollIntervalMs ?? 1_500): void {
    if (this.disposed || this.pollTimer) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.poll();
    }, delay);
  }

  private async poll(): Promise<void> {
    if (this.disposed || this.blockedCode) return;
    try {
      const jobs = await this.options.jobs(this.controller.signal);
      const byId = new Map(jobs.map((job) => [job.repositoryId, job]));
      for (const item of this.work.values()) {
        if (!item.repositoryId || (item.phase !== "queued" && item.phase !== "running")) continue;
        const job = byId.get(item.repositoryId);
        if (!job) continue;
        item.job = job;
        if (job.state === "running" || job.state === "queued") {
          item.phase = job.state;
          continue;
        }
        if (item.dirtyWhileRunning) {
          item.dirtyWhileRunning = false;
          item.force = true;
          item.phase = "pending";
        } else {
          item.phase = job.state === "ready" ? "ready" : "failed";
        }
      }
      this.emitSummary();
      if ([...this.work.values()].some((item) => item.phase === "queued" || item.phase === "running")) this.schedulePoll();
      if ([...this.work.values()].some((item) => item.phase === "pending")) void this.drain();
    } catch (error) {
      if (!this.controller.signal.aborted) this.pauseFor(error);
    }
  }

  private pauseFor(error: unknown): void {
    const code = this.options.errorCode(error) ?? "UNKNOWN";
    this.blockedCode = code;
    this.emitSummary();
    if (code === "TOKEN_REQUIRED" || code === "UNAUTHORIZED" || this.disposed) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.resume(), this.options.retryIntervalMs ?? 5_000);
  }

  private emitSummary(): void {
    const items = [...this.work.values()];
    const activeJobs = items.map((item) => item.job).filter((job): job is IndexState => Boolean(job) && job?.state === "running");
    const completedFiles = activeJobs.reduce((sum, job) => sum + job.completedFiles, 0);
    const totalFiles = activeJobs.reduce((sum, job) => sum + job.totalFiles, 0);
    const summary: ScanSummary = {
      phase: this.phase(items),
      discoveredRepositories: items.length,
      queuedRepositories: items.filter((item) => item.phase === "pending" || item.phase === "queued").length,
      runningRepositories: items.filter((item) => item.phase === "running").length,
      readyRepositories: items.filter((item) => item.phase === "ready").length,
      failedRepositories: items.filter((item) => item.phase === "failed").length,
      completedFiles,
      totalFiles,
      discoveryTruncated: this.discoveryTruncated,
      ...(this.blockedCode ? { blockedCode: this.blockedCode } : {}),
    };
    const progressBucket = totalFiles ? Math.floor((completedFiles / totalFiles) * 20) : 0;
    const key = [summary.phase, summary.discoveredRepositories, summary.queuedRepositories, summary.runningRepositories, summary.readyRepositories, summary.failedRepositories, progressBucket, summary.discoveryTruncated, summary.blockedCode ?? ""].join(":");
    if (key === this.lastSummaryKey) return;
    this.lastSummaryKey = key;
    this.options.onSummary(summary);
  }

  private phase(items: RepositoryWork[]): ScanPhase {
    if (this.blockedCode) return "paused";
    if (this.discovering) return "discovering";
    if (items.some((item) => item.phase === "running")) return "indexing";
    if (items.some((item) => item.phase === "pending" || item.phase === "queued")) return "queued";
    if (items.some((item) => item.phase === "failed")) return "degraded";
    if (items.some((item) => item.phase === "ready")) return "ready";
    return "idle";
  }
}
