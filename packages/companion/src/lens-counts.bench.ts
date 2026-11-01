import { performance } from "node:perf_hooks";
import { PROTOCOL_VERSION, type CodeLensCountsRequest, type SourceRange } from "@trace/contracts";
import { GraphService } from "./graph.js";
import { LensCountService } from "./lens-counts.js";
import type { IndexedRelationship, IndexedSymbol, ParsedMethod } from "./model.js";
import { TraceStore } from "./store.js";

const symbolCount = Number(process.env.TRACE_LENS_BENCH_SYMBOLS ?? 20_000);
const relationshipCount = Number(process.env.TRACE_LENS_BENCH_RELATIONSHIPS ?? 60_000);
const skipLegacy = process.env.TRACE_LENS_BENCH_SKIP_LEGACY === "1";
const lensCount = Math.min(200, symbolCount);
const commit = "a".repeat(40);
const range: SourceRange = { startLine: 1, startColumn: 0, endLine: 3, endColumn: 1 };
const percentile = (values: number[], fraction: number): number => [...values].sort((left, right) => left - right)[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0;

const store = new TraceStore(":memory:");
store.upsertRepository({ id: "large", root: "/synthetic/large" });
const generation = store.beginGeneration("large", commit, "main", false, symbolCount);
let symbols: IndexedSymbol[] = [];
for (let index = 0; index < symbolCount; index++) {
  const classFqn = `Synthetic\\Type${index}`; const name = "run";
  const data: ParsedMethod = { id: `method:${index}`, classFqn, name, visibility: "public", static: false, abstract: false, signature: "run(): void", source: "", range, implementationFingerprint: "i", signatureFingerprint: "s", documentationFingerprint: "d", calls: [] };
  symbols.push({ id: `large@${commit}:${data.id}`, generation, repositoryId: "large", commit, path: `src/Type${index}.php`, kind: "method", fqn: `${classFqn}::${name}`, memberName: name, classFqn, range, data });
}
let relationships: IndexedRelationship[] = [];
for (let index = 0; index < relationshipCount; index++) {
  const source = symbols[index % symbolCount]!; const target = symbols[(index * 17 + 37) % symbolCount]!;
  relationships.push({ id: `relationship:${index}`, generation, repositoryId: "large", commit, sourceId: source.id, targetId: target.id, type: "calls", confidence: "confirmed", path: source.path, range, detail: "synthetic call", limitations: [] });
}
store.publishGeneration(generation, "large", "synthetic-large", symbols, relationships, [], []);

const selections = symbols.slice(0, lensCount).map((symbol) => ({ repositoryPath: "/synthetic/large", relativePath: symbol.path, revision: { repositoryId: "large", commit, dirty: false }, range, selectedText: "run" }));
const request: CodeLensCountsRequest = { protocolVersion: PROTOCOL_VERSION, repository: { repositoryId: "large", commit }, items: symbols.slice(0, lensCount).map((symbol, index) => ({ id: `lens:${index}`, path: symbol.path, range, symbol: symbol.fqn })) };
symbols = []; relationships = [];
const collectGarbage = (globalThis as typeof globalThis & { gc?: () => void }).gc;
collectGarbage?.();
const rssBeforeQueriesMiB = process.memoryUsage().rss / 1024 / 1024;

const graph = skipLegacy ? undefined : new GraphService(store);
let started = performance.now(); if (graph) graph.trace(selections[0]!, "callers", 500); const legacyColdMs = graph ? performance.now() - started : undefined;
const legacySamples: number[] = [];
if (graph) for (const selection of selections) { started = performance.now(); graph.trace(selection, "callers", 500); legacySamples.push(performance.now() - started); }
collectGarbage?.();
const rssBeforeCacheMiB = process.memoryUsage().rss / 1024 / 1024;

const service = new LensCountService(store);
started = performance.now(); const cold = await service.count(request); const cachedColdBatchMs = performance.now() - started;
const warmSamples: number[] = [];
let warmHits = 0;
for (let iteration = 0; iteration < 20; iteration++) { started = performance.now(); const response = await service.count(request); warmSamples.push(performance.now() - started); warmHits += response.cache.hits; }

const controller = new AbortController(); setImmediate(() => controller.abort());
started = performance.now(); let cancellationObserved = false;
try { await service.count(request, controller.signal); } catch (error) { cancellationObserved = error instanceof Error && error.name === "AbortError"; }
const cancellationMs = performance.now() - started;
collectGarbage?.();
const rssAfterCacheMiB = process.memoryUsage().rss / 1024 / 1024;

const report = {
  corpus: { symbols: symbolCount, relationships: relationshipCount, lenses: lensCount },
  peakRssMiB: Number((process.resourceUsage().maxRSS / 1024).toFixed(1)),
  rss: { afterCorpusGcMiB: Number(rssBeforeQueriesMiB.toFixed(1)), beforeCacheGcMiB: Number(rssBeforeCacheMiB.toFixed(1)), afterCacheGcMiB: Number(rssAfterCacheMiB.toFixed(1)), cacheDeltaMiB: Number((rssAfterCacheMiB - rssBeforeCacheMiB).toFixed(1)) },
  legacy: graph ? { coldMs: Number(legacyColdMs!.toFixed(2)), batchMs: Number(legacySamples.reduce((sum, value) => sum + value, 0).toFixed(2)), p50PerLensMs: Number(percentile(legacySamples, 0.5).toFixed(2)), p95PerLensMs: Number(percentile(legacySamples, 0.95).toFixed(2)), cancellation: "not-observable-during-synchronous-batch" } : { skipped: true },
  cached: { coldBatchMs: Number(cachedColdBatchMs.toFixed(2)), warmP50BatchMs: Number(percentile(warmSamples, 0.5).toFixed(2)), warmP95BatchMs: Number(percentile(warmSamples, 0.95).toFixed(2)), coldMisses: cold.cache.misses, warmHits, cancellationObserved, cancellationMs: Number(cancellationMs.toFixed(2)) },
  acceptance: { batchLimit: 200, coldBatchThresholdMs: symbolCount >= 200_000 ? 5_000 : 750, coldBatchPass: cachedColdBatchMs < (symbolCount >= 200_000 ? 5_000 : 750), warmP95BatchUnder20Ms: percentile(warmSamples, 0.95) < 20, cancellationUnder100Ms: cancellationObserved && cancellationMs < 100 },
};
console.log(JSON.stringify(report, null, 2));
store.close();
