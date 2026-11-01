import type { CodeLensCount, CodeLensCountsResponse } from "@trace/contracts";

export type LensCacheEntry<T> = {
  documentVersion: number;
  repositoryId: string;
  commit: string;
  generation: number;
  value: T;
};

export class LensResultCache<T> {
  private readonly entries = new Map<string, LensCacheEntry<T>>();
  private readonly generations = new Map<string, number>();
  private readonly blockedDocuments = new Set<string>();

  get(documentKey: string, documentVersion: number, repositoryId: string, commit: string): T | undefined {
    if (this.blockedDocuments.has(documentKey)) return undefined;
    const entry = this.entries.get(documentKey);
    return entry?.documentVersion === documentVersion && entry.repositoryId === repositoryId && entry.commit === commit ? entry.value : undefined;
  }

  set(documentKey: string, documentVersion: number, response: CodeLensCountsResponse, value: T): boolean {
    if (this.blockedDocuments.has(documentKey)) return false;
    const previousGeneration = this.generations.get(response.repository.repositoryId);
    const generationChanged = previousGeneration !== undefined && previousGeneration !== response.generation;
    if (generationChanged) this.invalidateRepository(response.repository.repositoryId);
    this.generations.set(response.repository.repositoryId, response.generation);
    this.entries.set(documentKey, {
      documentVersion,
      repositoryId: response.repository.repositoryId,
      commit: response.repository.commit,
      generation: response.generation,
      value,
    });
    return generationChanged;
  }

  blockDocument(documentKey: string): void {
    this.blockedDocuments.add(documentKey);
    this.entries.delete(documentKey);
  }

  forgetDocument(documentKey: string): void {
    this.entries.delete(documentKey);
    this.blockedDocuments.delete(documentKey);
  }

  invalidateRepository(repositoryId: string): void {
    for (const [key, entry] of this.entries) if (entry.repositoryId === repositoryId) this.entries.delete(key);
  }

  releaseAfterGenerationChange(): void {
    this.entries.clear();
    this.generations.clear();
    this.blockedDocuments.clear();
  }

  clearValues(): void {
    this.entries.clear();
    this.generations.clear();
  }

  clear(): void {
    this.releaseAfterGenerationChange();
  }

  isBlocked(documentKey: string): boolean {
    return this.blockedDocuments.has(documentKey);
  }
}

export class RepositoryIdentityCache {
  private readonly ids = new Map<string, string>();
  private readonly lookups = new Map<string, Promise<string | undefined>>();
  private epoch = 0;

  async resolve(root: string, load: () => Promise<string | undefined>): Promise<string | undefined> {
    const cached = this.ids.get(root);
    if (cached) return cached;
    const existing = this.lookups.get(root);
    if (existing) return existing;
    const epoch = this.epoch;
    let lookup: Promise<string | undefined>;
    lookup = load().then((id) => {
      if (epoch !== this.epoch) return undefined;
      if (id) this.ids.set(root, id);
      return id;
    }).finally(() => {
      if (this.lookups.get(root) === lookup) this.lookups.delete(root);
    });
    this.lookups.set(root, lookup);
    return lookup;
  }

  clear(): void {
    this.epoch++;
    this.ids.clear();
    this.lookups.clear();
  }
}

type Scheduled = { controller: AbortController; reject(error: Error): void; timer: NodeJS.Timeout };

export class DebouncedLensRequests {
  private readonly pending = new Map<string, Scheduled>();

  schedule<T>(key: string, delayMs: number, outerSignal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.cancel(key);
    const controller = new AbortController();
    const abort = () => {
      const current = this.pending.get(key);
      if (current?.controller === controller) this.cancel(key);
      else controller.abort();
    };
    outerSignal.addEventListener("abort", abort, { once: true });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (controller.signal.aborted) {
          this.pending.delete(key);
          outerSignal.removeEventListener("abort", abort);
          reject(abortError());
          return;
        }
        void run(controller.signal).then(resolve, reject).finally(() => {
          if (this.pending.get(key)?.controller === controller) this.pending.delete(key);
          outerSignal.removeEventListener("abort", abort);
        });
      }, Math.max(0, delayMs));
      this.pending.set(key, { controller, reject, timer });
      if (outerSignal.aborted) this.cancel(key);
    });
  }

  cancel(key: string): void {
    const current = this.pending.get(key);
    if (!current) return;
    this.pending.delete(key);
    clearTimeout(current.timer);
    current.controller.abort();
    current.reject(abortError());
  }

  cancelAll(): void {
    for (const key of [...this.pending.keys()]) this.cancel(key);
  }
}

export function lensLabels(count: CodeLensCount): Array<{ mode: "callers" | "consumers"; title: string }> {
  const suffix = count.partial ? " · partial" : "";
  return [
    ...(count.callers > 0 ? [{ mode: "callers" as const, title: `$(references) ${count.callers} caller${count.callers === 1 ? "" : "s"}${suffix}` }] : []),
    ...(count.consumers > 0 ? [{ mode: "consumers" as const, title: `$(package) ${count.consumers} package consumer${count.consumers === 1 ? "" : "s"}${suffix}` }] : []),
  ];
}

export function configuredRepositoryId(repositories: Array<{ id: string; root: string }>, canonicalRoot: string): string | undefined {
  return repositories.find((repository) => repository.root === canonicalRoot)?.id;
}

function abortError(): Error {
  const error = new Error("CodeLens request cancelled");
  error.name = "AbortError";
  return error;
}
