import assert from "node:assert/strict";
import test from "node:test";
import { GraphService } from "./graph.js";
import type { ComposerDependency, ComposerPackage, IndexedSymbol, ParsedMethod, ParsedType } from "./model.js";
import { TraceStore } from "./store.js";

const range = { startLine: 1, startColumn: 0, endLine: 3, endColumn: 1 };

function typeSymbol(repositoryId: string, commit: string, generation: number, id: string, fqn: string, parent?: string): IndexedSymbol {
  const typeRange = { ...range, endLine: 5 };
  const data: ParsedType = { id, fqn, shortName: fqn.split("\\").at(-1) ?? fqn, kind: "class", abstract: false, ...(parent ? { parent } : {}), interfaces: [], traits: [], methods: [], range: typeRange };
  return { id: `${repositoryId}@${commit}:${id}`, repositoryId, commit, generation, path: "src/Order.php", kind: "class", fqn, range: typeRange, data };
}

function methodSymbol(repositoryId: string, commit: string, generation: number, id: string, classFqn: string, parentCall = false): IndexedSymbol {
  const data: ParsedMethod = {
    id,
    classFqn,
    name: "calculateTotal",
    visibility: "public",
    static: false,
    abstract: false,
    signature: "calculateTotal(): int",
    source: "public function calculateTotal(): int { return 1; }",
    range,
    implementationFingerprint: "implementation",
    signatureFingerprint: "signature",
    documentationFingerprint: "documentation",
    calls: parentCall ? [{ receiver: "parent", methodName: "calculateTotal", range, confidence: "confirmed", resolutionMethod: "parent", limitations: [], expression: "parent", detail: "Explicit parent call" }] : [],
  };
  return { id: `${repositoryId}@${commit}:${id}`, repositoryId, commit, generation, path: "src/Order.php", kind: "method", fqn: `${classFqn}::calculateTotal`, memberName: "calculateTotal", classFqn, range, data };
}

test("consumer graph distinguishes exact confirmed symbol use from dependency-only installation", () => {
  const store = new TraceStore(":memory:");
  const packageCommit = "package-new";
  const consumerCommit = "consumer-head";
  const dependencyOnlyCommit = "reporting-head";
  for (const [id, root] of [["shared", "/shared"], ["store", "/store"], ["reporting", "/reporting"], ["ambiguous-a", "/ambiguous-a"], ["ambiguous-b", "/ambiguous-b"]] as const) store.upsertRepository({ id, root });

  const sharedGeneration = store.beginGeneration("shared", packageCommit, "main", false, 1);
  const sharedType = typeSymbol("shared", packageCommit, sharedGeneration, "class:base-order", "Company\\Commerce\\BaseOrder");
  const sharedMethod = methodSymbol("shared", packageCommit, sharedGeneration, "method:base-order:calculate-total", "Company\\Commerce\\BaseOrder");
  const sharedPackage: ComposerPackage = { repositoryId: "shared", generation: sharedGeneration, rootPath: "", name: "company/commerce", sourceCommit: packageCommit, autoload: {} };
  store.publishGeneration(sharedGeneration, "shared", "shared-inventory", [sharedType, sharedMethod], [], [sharedPackage], []);

  const storeGeneration = store.beginGeneration("store", consumerCommit, "main", false, 1);
  const consumerType = typeSymbol("store", consumerCommit, storeGeneration, "class:order", "Client\\Store\\Order", "Company\\Commerce\\BaseOrder");
  const consumerMethod = methodSymbol("store", consumerCommit, storeGeneration, "method:order:calculate-total", "Client\\Store\\Order", true);
  const storeDependency: ComposerDependency = { repositoryId: "store", generation: storeGeneration, packageName: "company/commerce", development: false, direct: true, declaredConstraint: "^2.0", resolvedVersion: "2.0.0", resolvedSourceCommit: packageCommit, resolution: "exact" };
  const ambiguousDependency: ComposerDependency = { repositoryId: "store", generation: storeGeneration, packageName: "vendor/ambiguous", development: false, direct: true, declaredConstraint: "^1", resolvedVersion: "1.0.0", resolvedSourceCommit: "same-commit", repositoryCandidates: [{ type: "vcs", url: "https://example.test/vendor/ambiguous.git", normalizedUrl: "example.test/vendor/ambiguous", canonical: true }], resolution: "exact" };
  store.publishGeneration(storeGeneration, "store", "store-inventory", [consumerType, consumerMethod], [], [{ repositoryId: "store", generation: storeGeneration, rootPath: "", name: "client/store", sourceCommit: consumerCommit, autoload: {} }], [storeDependency, ambiguousDependency]);

  for (const repositoryId of ["ambiguous-a", "ambiguous-b"]) {
    const generation = store.beginGeneration(repositoryId, "same-commit", "main", false, 0);
    store.publishGeneration(generation, repositoryId, `${repositoryId}-inventory`, [], [], [{ repositoryId, generation, rootPath: "", name: "vendor/ambiguous", sourceCommit: "same-commit", autoload: {} }], []);
  }

  const reportingGeneration = store.beginGeneration("reporting", dependencyOnlyCommit, "main", false, 1);
  const reportingDependency: ComposerDependency = { repositoryId: "reporting", generation: reportingGeneration, packageName: "company/commerce", development: false, direct: true, declaredConstraint: "^1.0", resolvedVersion: "1.0.0", resolvedSourceCommit: "package-old", resolution: "exact" };
  store.publishGeneration(reportingGeneration, "reporting", "reporting-inventory", [typeSymbol("reporting", dependencyOnlyCommit, reportingGeneration, "class:report", "Client\\Reporting\\Report")], [], [{ repositoryId: "reporting", generation: reportingGeneration, rootPath: "", name: "client/reporting", sourceCommit: dependencyOnlyCommit, autoload: {} }], [reportingDependency]);

  try {
    const graph = new GraphService(store).trace({
      repositoryPath: "/store",
      relativePath: "src/Order.php",
      revision: { repositoryId: "store", commit: consumerCommit, dirty: false },
      range,
      selectedText: "calculateTotal",
    }, "consumers");
    assert.equal(graph.nodes.find((node) => node.id === "project:store")?.metadata.symbolUsage, "confirmed");
    assert.equal(graph.nodes.find((node) => node.id === "project:reporting")?.metadata.symbolUsage, "dependency-only");
    assert.ok(graph.nodes.some((node) => node.kind === "package-revision" && node.metadata.resolvedSourceCommit === packageCommit && node.metadata.symbolAnalysis === "available"));
    assert.ok(graph.nodes.some((node) => node.kind === "package-revision" && node.metadata.resolvedSourceCommit === "package-old" && node.metadata.symbolAnalysis === "unavailable-for-exact-revision"));
    assert.ok(graph.nodes.some((node) => node.kind === "package-revision" && node.label === "vendor/ambiguous" && node.metadata.resolution === "ambiguous" && Array.isArray(node.metadata.repositoryCandidates)));
    assert.ok(graph.edges.some((edge) => edge.source === "project:store" && edge.type === "declares" && edge.confidence === "confirmed"));
    assert.ok(graph.edges.some((edge) => edge.source === "project:reporting" && edge.type === "requires" && edge.confidence === "dependency-only"));
    assert.ok(graph.edges.every((edge) => edge.evidence.length > 0));
  } finally {
    store.close();
  }
});

test("origin and impact traces scope cross-repository work away from unrelated exact consumers", async () => {
  const store = new TraceStore(":memory:");
  const sharedCommit = "a".repeat(40); const focusCommit = "b".repeat(40); const unrelatedCommit = "c".repeat(40);
  for (const [id, root] of [["shared", "/shared"], ["focus", "/focus"], ["unrelated", "/unrelated"]] as const) store.upsertRepository({ id, root });
  const sharedGeneration = store.beginGeneration("shared", sharedCommit, "main", false, 1);
  const base = typeSymbol("shared", sharedCommit, sharedGeneration, "class:base", "Company\\Shared\\BaseOrder");
  store.publishGeneration(sharedGeneration, "shared", "shared", [base], [], [{ repositoryId: "shared", generation: sharedGeneration, rootPath: "", name: "company/shared", sourceCommit: sharedCommit, autoload: {} }], []);

  const focusGeneration = store.beginGeneration("focus", focusCommit, "main", false, 1);
  const focused = typeSymbol("focus", focusCommit, focusGeneration, "class:focused", "Client\\FocusedOrder", "Company\\Shared\\BaseOrder");
  const focusDependency: ComposerDependency = { repositoryId: "focus", generation: focusGeneration, packageName: "company/shared", development: false, direct: true, resolvedSourceCommit: sharedCommit, resolution: "exact" };
  store.publishGeneration(focusGeneration, "focus", "focus", [focused], [], [{ repositoryId: "focus", generation: focusGeneration, rootPath: "", name: "client/focus", sourceCommit: focusCommit, autoload: {} }], [focusDependency]);

  const unrelatedGeneration = store.beginGeneration("unrelated", unrelatedCommit, "main", false, 5_000);
  const unrelated = Array.from({ length: 5_000 }, (_, index) => typeSymbol("unrelated", unrelatedCommit, unrelatedGeneration, `class:unrelated-${index}`, `Client\\UnrelatedOrder${index}`, "Company\\Shared\\BaseOrder"));
  const unrelatedDependency: ComposerDependency = { repositoryId: "unrelated", generation: unrelatedGeneration, packageName: "company/shared", development: false, direct: true, resolvedSourceCommit: sharedCommit, resolution: "exact" };
  store.publishGeneration(unrelatedGeneration, "unrelated", "unrelated", unrelated, [], [{ repositoryId: "unrelated", generation: unrelatedGeneration, rootPath: "", name: "client/unrelated", sourceCommit: unrelatedCommit, autoload: {} }], [unrelatedDependency]);

  try {
    const started = performance.now();
    const service = new GraphService(store);
    const selection = { repositoryPath: "/focus", relativePath: "src/Order.php", revision: { repositoryId: "focus", commit: focusCommit, dirty: false }, range, selectedText: "FocusedOrder" };
    const graph = service.trace(selection, "origin", 100);
    const elapsedMs = performance.now() - started;
    assert.ok(graph.nodes.some((node) => node.label === "Company\\Shared\\BaseOrder"));
    assert.equal(graph.nodes.some((node) => node.label.startsWith("Client\\UnrelatedOrder")), false);
    assert.equal(graph.freshness.partial, false);
    assert.ok(elapsedMs < 1_500, `scoped origin trace should stay below 1500ms, took ${elapsedMs.toFixed(1)}ms`);
    const impact = await service.traceAsync(selection, "impact", 100);
    assert.ok(impact.nodes.some((node) => node.label === "Company\\Shared\\BaseOrder"));
    assert.equal(impact.nodes.some((node) => node.label.startsWith("Client\\UnrelatedOrder")), false);
  } finally {
    store.close();
  }
});

test("async origin tracing observes request cancellation before expensive graph work", async () => {
  const store = new TraceStore(":memory:");
  const commit = "d".repeat(40);
  store.upsertRepository({ id: "focus", root: "/focus" });
  const generation = store.beginGeneration("focus", commit, "main", false, 1);
  store.publishGeneration(generation, "focus", "focus", [typeSymbol("focus", commit, generation, "class:focused", "Client\\FocusedOrder")], [], [], []);
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      new GraphService(store).traceAsync({ repositoryPath: "/focus", relativePath: "src/Order.php", revision: { repositoryId: "focus", commit, dirty: false }, range, selectedText: "FocusedOrder" }, "origin", 100, controller.signal),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
  } finally {
    store.close();
  }
});
