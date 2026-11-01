import { performance } from "node:perf_hooks";

export interface CodeLensBenchmarkItem {
  id: string;
  path: string;
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  symbol?: string;
}

export interface CodeLensBenchmarkRequest {
  repository: { repositoryId: string; commit: string };
  items: CodeLensBenchmarkItem[];
}

export interface CodeLensBenchmarkWorkload {
  requests: CodeLensBenchmarkRequest[];
}

export interface CodeLensBenchmarkResponse {
  counts: Array<{ id: string; callers: number; consumers: number; partial: boolean; limitations?: string[] }>;
  cache: { hits: number; misses: number; rebuilt: boolean };
}

export interface CodeLensBenchmarkTransport {
  query(request: CodeLensBenchmarkRequest, signal: AbortSignal): Promise<CodeLensBenchmarkResponse>;
}

export interface CodeLensBenchmarkOptions {
  iterations?: number;
  warmup?: number;
  cancellationAttempts?: number;
  cancelAfterMs?: number;
  thresholds?: Partial<CodeLensBenchmarkThresholds>;
}

export interface CodeLensBenchmarkThresholds {
  coldP95Ms: number;
  warmP95Ms: number;
  cancellationP95Ms: number;
}

export interface BenchmarkDistribution {
  observed: number;
  min: number;
  median: number;
  p95: number;
  max: number;
  mean: number;
}

type Assessment = "passed" | "failed" | "not-observed";
type ErrorCategory = "cancelled" | "client" | "server" | "protocol" | "other";

export interface CodeLensBenchmarkReport {
  schemaVersion: 1;
  tool: "trace-codelens-query-benchmark";
  privacy: {
    pathDisclosure: "suppressed";
    repositoryDisclosure: "suppressed";
    symbolDisclosure: "suppressed";
    revisionDisclosure: "suppressed";
    contentDisclosure: "suppressed";
    rawErrors: "suppressed";
  };
  configuration: {
    requestSets: number;
    items: { total: number; minPerRequest: number; maxPerRequest: number };
    iterations: number;
    warmup: number;
    cancellationAttempts: number;
    cancelAfterMs: number;
  };
  samples: {
    total: number;
    cold: BenchmarkDistribution;
    warm: BenchmarkDistribution;
    mixed: BenchmarkDistribution;
    returnedItems: number;
    partialItems: number;
  };
  cache: { hits: number; misses: number; rebuilds: number };
  cancellation: {
    attempts: number;
    clientAborted: number;
    serverCancelled: number;
    completedBeforeAbort: number;
    failed: number;
    latencyMs: BenchmarkDistribution;
  };
  thresholds: CodeLensBenchmarkThresholds;
  assessment: {
    coldP95: Assessment;
    warmP95: Assessment;
    cancellationP95: Assessment;
    overall: Assessment;
  };
  errors: { count: number; categories: Record<ErrorCategory, number> };
}

export class CodeLensBenchmarkError extends Error {
  constructor(readonly code: "invalid-options" | "invalid-workload" | "query-failed") {
    super(code);
    this.name = "CodeLensBenchmarkError";
  }
}

export class CodeLensTransportError extends Error {
  constructor(readonly category: ErrorCategory, readonly status?: number) {
    super(category);
    this.name = "CodeLensTransportError";
  }
}

const DEFAULT_THRESHOLDS: CodeLensBenchmarkThresholds = { coldP95Ms: 5_000, warmP95Ms: 20, cancellationP95Ms: 100 };
const emptyErrors = (): CodeLensBenchmarkReport["errors"] => ({ count: 0, categories: { cancelled: 0, client: 0, server: 0, protocol: 0, other: 0 } });
const round = (value: number): number => Number(value.toFixed(3));

function percentile(sorted: number[], fraction: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function distribution(values: number[]): BenchmarkDistribution {
  if (!values.length) return { observed: 0, min: 0, median: 0, p95: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle]! : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return {
    observed: values.length,
    min: round(sorted[0]!),
    median: round(median),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted.at(-1)!),
    mean: round(values.reduce((total, value) => total + value, 0) / values.length),
  };
}

function positiveInteger(value: number, allowZero = false): boolean {
  return Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0);
}

function validRange(range: CodeLensBenchmarkItem["range"]): boolean {
  return positiveInteger(range.startLine) && positiveInteger(range.endLine)
    && positiveInteger(range.startColumn, true) && positiveInteger(range.endColumn, true)
    && (range.endLine > range.startLine || range.endLine === range.startLine && range.endColumn >= range.startColumn);
}

function safeRelativePath(value: string): boolean {
  return Boolean(value) && !value.startsWith("/") && !value.startsWith("\\") && !value.split(/[\\/]/).includes("..");
}

export function validateCodeLensWorkload(value: unknown): CodeLensBenchmarkWorkload {
  if (!value || typeof value !== "object" || !("requests" in value) || !Array.isArray(value.requests) || !value.requests.length) throw new CodeLensBenchmarkError("invalid-workload");
  for (const request of value.requests as CodeLensBenchmarkRequest[]) {
    if (!request || typeof request !== "object" || !request.repository || typeof request.repository.repositoryId !== "string" || !request.repository.repositoryId || request.repository.repositoryId.length > 200 || typeof request.repository.commit !== "string" || !request.repository.commit || request.repository.commit.length > 128 || !Array.isArray(request.items) || !request.items.length || request.items.length > 200) throw new CodeLensBenchmarkError("invalid-workload");
    for (const item of request.items) {
      if (!item || typeof item.id !== "string" || !item.id || item.id.length > 200 || typeof item.path !== "string" || !safeRelativePath(item.path) || !item.range || !validRange(item.range) || item.symbol !== undefined && (typeof item.symbol !== "string" || !item.symbol || item.symbol.length > 1_000)) throw new CodeLensBenchmarkError("invalid-workload");
    }
  }
  return value as CodeLensBenchmarkWorkload;
}

function categoryFor(error: unknown): ErrorCategory {
  return error instanceof CodeLensTransportError ? error.category : error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "other";
}

function recordError(errors: CodeLensBenchmarkReport["errors"], error: unknown): ErrorCategory {
  const category = categoryFor(error);
  errors.count += 1;
  errors.categories[category] += 1;
  return category;
}

function assessment(distributionValue: BenchmarkDistribution, threshold: number): Assessment {
  return distributionValue.observed ? distributionValue.p95 <= threshold ? "passed" : "failed" : "not-observed";
}

export async function runCodeLensBenchmark(workloadValue: unknown, transport: CodeLensBenchmarkTransport, options: CodeLensBenchmarkOptions = {}): Promise<CodeLensBenchmarkReport> {
  const workload = validateCodeLensWorkload(workloadValue);
  const iterations = options.iterations ?? 10;
  const warmup = options.warmup ?? 1;
  const cancellationAttempts = options.cancellationAttempts ?? 3;
  const cancelAfterMs = options.cancelAfterMs ?? 1;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  if (!positiveInteger(iterations) || !positiveInteger(warmup, true) || !positiveInteger(cancellationAttempts, true) || !positiveInteger(cancelAfterMs, true) || Object.values(thresholds).some((value) => !Number.isFinite(value) || value <= 0)) throw new CodeLensBenchmarkError("invalid-options");

  const errors = emptyErrors();
  const cancellationDurations: number[] = [];
  let clientAborted = 0; let serverCancelled = 0; let completedBeforeAbort = 0; let cancellationFailed = 0;
  for (let attempt = 0; attempt < cancellationAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cancelAfterMs);
    const started = performance.now();
    try {
      await transport.query(workload.requests[attempt % workload.requests.length]!, controller.signal);
      completedBeforeAbort += 1;
    } catch (error) {
      const category = categoryFor(error);
      if (error instanceof CodeLensTransportError && error.status === 499) serverCancelled += 1;
      else if (category === "cancelled") clientAborted += 1;
      else { recordError(errors, error); cancellationFailed += 1; }
    } finally {
      clearTimeout(timer);
      cancellationDurations.push(performance.now() - started);
    }
  }

  const coldDurations: number[] = []; const warmDurations: number[] = []; const mixedDurations: number[] = [];
  let hits = 0; let misses = 0; let rebuilds = 0; let returnedItems = 0; let partialItems = 0; let totalSamples = 0;
  const measure = async (request: CodeLensBenchmarkRequest): Promise<void> => {
    const started = performance.now();
    try {
      const response = await transport.query(request, new AbortController().signal);
      const elapsed = performance.now() - started;
      totalSamples += 1;
      hits += response.cache.hits; misses += response.cache.misses; rebuilds += response.cache.rebuilt ? 1 : 0;
      returnedItems += response.counts.length;
      partialItems += response.counts.filter((item) => item.partial).length;
      if (response.cache.rebuilt || response.cache.misses > 0 && response.cache.hits === 0) coldDurations.push(elapsed);
      else if (!response.cache.rebuilt && response.cache.hits > 0 && response.cache.misses === 0) warmDurations.push(elapsed);
      else mixedDurations.push(elapsed);
    } catch (error) {
      recordError(errors, error);
    }
  };

  for (const request of workload.requests) await measure(request);
  for (let pass = 0; pass < warmup; pass++) {
    for (const request of workload.requests) {
      try { await transport.query(request, new AbortController().signal); } catch (error) { recordError(errors, error); }
    }
  }
  for (let iteration = 1; iteration < iterations; iteration++) {
    for (const request of workload.requests) await measure(request);
  }

  if (!totalSamples) throw new CodeLensBenchmarkError("query-failed");
  const cold = distribution(coldDurations); const warm = distribution(warmDurations); const mixed = distribution(mixedDurations); const cancellation = distribution(cancellationDurations);
  const coldP95 = assessment(cold, thresholds.coldP95Ms);
  const warmP95 = assessment(warm, thresholds.warmP95Ms);
  const cancellationObserved = clientAborted + serverCancelled > 0;
  const cancellationP95: Assessment = cancellationObserved ? assessment(cancellation, thresholds.cancellationP95Ms) : "not-observed";
  const observed = [coldP95, warmP95, cancellationP95].filter((item) => item !== "not-observed");
  const overall: Assessment = observed.includes("failed") ? "failed" : observed.length === 3 ? "passed" : "not-observed";
  const itemCounts = workload.requests.map((request) => request.items.length);
  return {
    schemaVersion: 1,
    tool: "trace-codelens-query-benchmark",
    privacy: { pathDisclosure: "suppressed", repositoryDisclosure: "suppressed", symbolDisclosure: "suppressed", revisionDisclosure: "suppressed", contentDisclosure: "suppressed", rawErrors: "suppressed" },
    configuration: {
      requestSets: workload.requests.length,
      items: { total: itemCounts.reduce((total, value) => total + value, 0), minPerRequest: Math.min(...itemCounts), maxPerRequest: Math.max(...itemCounts) },
      iterations, warmup, cancellationAttempts, cancelAfterMs,
    },
    samples: { total: totalSamples, cold, warm, mixed, returnedItems, partialItems },
    cache: { hits, misses, rebuilds },
    cancellation: { attempts: cancellationAttempts, clientAborted, serverCancelled, completedBeforeAbort, failed: cancellationFailed, latencyMs: cancellation },
    thresholds,
    assessment: { coldP95, warmP95, cancellationP95, overall },
    errors,
  };
}
