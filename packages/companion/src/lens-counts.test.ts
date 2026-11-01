import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_VERSION, type CodeLensCountsRequest } from "@trace/contracts";
import { LensCountService, LensRevisionError } from "./lens-counts.js";
import type { ComposerDependency, ComposerPackage, IndexedRelationship, IndexedSymbol, ParsedMethod, ParsedType } from "./model.js";
import { TraceStore } from "./store.js";

const range = { startLine: 3, startColumn: 0, endLine: 5, endColumn: 1 };
const sharedCommit = "a".repeat(40);
const consumerCommit = "b".repeat(40);

function typeSymbol(repositoryId: string, generation: number, commit: string, fqn: string, sourcePath: string): IndexedSymbol {
  const data: ParsedType = { id: `class:${fqn.toLowerCase()}`, fqn, shortName: fqn.split("\\").at(-1)!, kind: "class", abstract: false, interfaces: [], traits: [], methods: [], range };
  return { id: `${repositoryId}@${commit}:${data.id}`, generation, repositoryId, commit, path: sourcePath, kind: "class", fqn, range, data };
}

function methodSymbol(repositoryId: string, generation: number, commit: string, classFqn: string, name: string, sourcePath: string, calls: ParsedMethod["calls"] = []): IndexedSymbol {
  const data: ParsedMethod = { id: `method:${classFqn.toLowerCase()}::${name.toLowerCase()}`, classFqn, name, visibility: "public", static: false, abstract: false, signature: `${name}(): void`, source: "", range, implementationFingerprint: "i", signatureFingerprint: "s", documentationFingerprint: "d", calls };
  return { id: `${repositoryId}@${commit}:${data.id}`, generation, repositoryId, commit, path: sourcePath, kind: "method", fqn: `${classFqn}::${name}`, memberName: name, classFqn, range, data };
}

function packageRecord(repositoryId: string, generation: number, commit: string, name: string): ComposerPackage {
  return { repositoryId, generation, rootPath: "", name, sourceCommit: commit, autoload: {} };
}

test("batches generation-scoped CodeLens counts and keeps callers separate from exact package consumers", async () => {
  const store = new TraceStore(":memory:");
  for (const [id, root] of [["shared", "/shared"], ["consumer", "/consumer"], ["stale", "/stale"]] as const) store.upsertRepository({ id, root });
  const sharedGeneration = store.beginGeneration("shared", sharedCommit, "main", false, 2);
  const sharedType = typeSymbol("shared", sharedGeneration, sharedCommit, "Company\\Shared\\Order", "src/Order.php");
  const price = methodSymbol("shared", sharedGeneration, sharedCommit, "Company\\Shared\\Order", "price", "src/Order.php");
  const localCaller = methodSymbol("shared", sharedGeneration, sharedCommit, "Company\\Shared\\Order", "quote", "src/Order.php");
  const localCall: IndexedRelationship = { id: "local-call", generation: sharedGeneration, repositoryId: "shared", commit: sharedCommit, sourceId: localCaller.id, targetId: price.id, type: "calls", confidence: "confirmed", path: localCaller.path, range, detail: "local caller", limitations: [] };
  store.publishGeneration(sharedGeneration, "shared", "shared", [sharedType, price, localCaller], [localCall], [packageRecord("shared", sharedGeneration, sharedCommit, "company/shared")], []);

  const consumerGeneration = store.beginGeneration("consumer", consumerCommit, "main", false, 1);
  const checkout = methodSymbol("consumer", consumerGeneration, consumerCommit, "Client\\Checkout", "total", "src/Checkout.php", [{ receiver: "variable", className: "Company\\Shared\\Order", classNames: ["Company\\Shared\\Order"], methodName: "price", range, confidence: "confirmed", resolutionMethod: "native-parameter", limitations: [], expression: "$order", detail: "$order->price()" }]);
  const dependency: ComposerDependency = { repositoryId: "consumer", generation: consumerGeneration, packageName: "company/shared", development: false, direct: true, resolvedSourceCommit: sharedCommit, resolutionMethod: "unresolved", resolutionEvidence: [], repositoryCandidates: [], resolution: "exact" };
  store.publishGeneration(consumerGeneration, "consumer", "consumer", [checkout], [], [packageRecord("consumer", consumerGeneration, consumerCommit, "client/consumer")], [dependency]);

  const staleCommit = "c".repeat(40); const staleGeneration = store.beginGeneration("stale", staleCommit, "main", false, 1);
  const staleCaller = methodSymbol("stale", staleGeneration, staleCommit, "Client\\StaleCheckout", "total", "src/StaleCheckout.php", [{ receiver: "variable", className: "Company\\Shared\\Order", classNames: ["Company\\Shared\\Order"], methodName: "price", range, confidence: "confirmed", resolutionMethod: "native-parameter", limitations: [], expression: "$order", detail: "$order->price()" }]);
  const staleDependency: ComposerDependency = { repositoryId: "stale", generation: staleGeneration, packageName: "company/shared", development: false, direct: true, resolvedSourceCommit: "d".repeat(40), resolutionMethod: "unresolved", resolutionEvidence: [], repositoryCandidates: [], resolution: "unavailable" };
  store.publishGeneration(staleGeneration, "stale", "stale", [staleCaller], [], [packageRecord("stale", staleGeneration, staleCommit, "client/stale")], [staleDependency]);

  try {
    const service = new LensCountService(store);
    const request: CodeLensCountsRequest = { protocolVersion: PROTOCOL_VERSION, repository: { repositoryId: "shared", commit: sharedCommit }, items: [{ id: "price", path: "src/Order.php", range, symbol: "Company\\Shared\\Order::price" }] };
    const cold = await service.count(request);
    assert.deepEqual(cold.cache, { hits: 0, misses: 1, rebuilt: true });
    assert.equal(cold.generation, sharedGeneration);
    assert.equal(cold.counts[0]?.callers, 2);
    assert.equal(cold.counts[0]?.consumers, 1);
    assert.equal(cold.counts[0]?.partial, true);
    assert.ok(cold.counts[0]?.limitations.some((limitation) => limitation.includes("revision-mismatched")));

    const warm = await service.count(request);
    assert.deepEqual(warm.cache, { hits: 1, misses: 0, rebuilt: false });

    const many = { ...request, items: Array.from({ length: 100 }, (_, index) => ({ ...request.items[0]!, id: `price-${index}` })) };
    const controller = new AbortController();
    setImmediate(() => controller.abort());
    await assert.rejects(service.count(many, controller.signal), (error: unknown) => error instanceof Error && error.name === "AbortError");

    const nextGeneration = store.beginGeneration("shared", "e".repeat(40), "main", false, 1);
    store.publishGeneration(nextGeneration, "shared", "next", [], [], [packageRecord("shared", nextGeneration, "e".repeat(40), "company/shared")], []);
    await assert.rejects(service.count(request), (error: unknown) => error instanceof LensRevisionError && error.message.includes("active indexed revision"));
  } finally {
    store.close();
  }
});
