import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TraceStore } from "./store.js";

test("publishes one complete generation as the active repository view", () => {
  const store = new TraceStore(":memory:");
  store.upsertRepository({ id: "repo", root: "/repo" });
  const generation = store.beginGeneration("repo", "abc", "main", false, 1);
  store.publishGeneration(generation, "repo", "fixture-inventory", [{ id: "repo@abc:class:a", generation, repositoryId: "repo", commit: "abc", path: "A.php", kind: "class", fqn: "A", range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 }, data: { id: "class:a", fqn: "A", shortName: "A", kind: "class", abstract: false, interfaces: [], traits: [], methods: [], range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 } } }], [{ id: "receiver-call", generation, repositoryId: "repo", commit: "abc", sourceId: "repo@abc:class:a", targetId: "repo@abc:class:a", type: "calls", confidence: "confirmed", detail: "typed receiver", limitations: [], resolutionMethod: "receiver-native-parameter" }], [], []);
  assert.equal(store.repository("repo")?.activeGeneration, generation);
  assert.equal(store.activeSymbols()[0]?.fqn, "A");
  assert.equal(store.activeRelationships()[0]?.resolutionMethod, "receiver-native-parameter");
  assert.equal(store.generations()[0]?.state, "ready");
  assert.equal(store.currentGeneration("repo", "abc", "fixture-inventory"), generation);
  const replacement = store.beginGeneration("repo", "def", "main", false, 0);
  store.publishGeneration(replacement, "repo", "replacement-inventory", [], [], [], []);
  assert.equal(store.repository("repo")?.activeGeneration, replacement);
  assert.deepEqual(store.generations().map((row) => Number(row.id)), [replacement]);
  store.close();
});

test("replaces a symbol history atomically instead of retaining stale classifications", () => {
  const store = new TraceStore(":memory:");
  const base = { symbolId: "symbol", commit: "abc", summary: "Change", authorName: "Trace", authorEmail: "trace@example.test", authoredAt: "2024-01-01T09:00:00+00:00", limitations: [] };
  store.saveHistory("repo", { ...base, id: "old-implementation", category: "implementation" });
  store.replaceHistory("repo", "symbol", [{ ...base, id: "formatting", category: "formatting" }]);
  assert.deepEqual(store.history("symbol").map((event) => event.category), ["formatting"]);
  store.close();
});

test("persists Composer identity evidence without collapsing aliases, references, or indexed revisions", () => {
  const store = new TraceStore(":memory:");
  store.upsertRepository({ id: "consumer", root: "/consumer", remoteUrl: "https://token:secret@github.com/Acme/Consumer.git?access_token=hidden#fragment" });
  const generation = store.beginGeneration("consumer", "c".repeat(40), "main", false, 0);
  store.publishGeneration(generation, "consumer", "composer-evidence", [], [], [{ repositoryId: "consumer", generation, rootPath: "packages/app", name: "acme/app", sourceCommit: "c".repeat(40), repositoryPath: "/consumer/packages/app", repositoryUrl: "git@github.com:Acme/App.git", normalizedRepositoryUrl: "github.com/acme/app", branchAliases: { "dev-main": "2.x-dev" }, autoload: {} }], [{ repositoryId: "consumer", generation, packageName: "acme/shared", development: false, direct: true, declaredConstraint: "dev-next as 2.x-dev", declaredConstraintBase: "dev-next", declaredAlias: "2.x-dev", resolvedVersion: "dev-next", resolvedSourceReference: "dev-next", resolvedSourceUrl: "git@github.com:Acme/Shared.git", normalizedSourceUrl: "github.com/acme/shared", resolvedDistReference: "dist-ref", resolvedDistUrl: "https://example.test/archive.zip", resolvedPath: "/packages/shared", indexedRepositoryId: "shared", indexedRevision: "d".repeat(40), resolutionMethod: "source-url", resolutionEvidence: ["normalized URL match"], repositoryCandidates: [{ type: "vcs", url: "https://github.com/Acme/Shared.git", normalizedUrl: "github.com/acme/shared", canonical: false }], resolution: "unavailable" }]);
  const pkg = store.activePackages()[0]; const dependency = store.activeDependencies()[0];
  assert.equal(store.repository("consumer")?.remoteUrl, "https://github.com/Acme/Consumer.git");
  assert.equal(pkg?.repositoryPath, "/consumer/packages/app"); assert.equal(pkg?.normalizedRepositoryUrl, "github.com/acme/app"); assert.deepEqual(pkg?.branchAliases, { "dev-main": "2.x-dev" });
  assert.equal(dependency?.declaredAlias, "2.x-dev"); assert.equal(dependency?.resolvedSourceReference, "dev-next"); assert.equal(dependency?.resolvedSourceCommit, undefined);
  assert.equal(dependency?.resolvedDistReference, "dist-ref"); assert.equal(dependency?.indexedRevision, "d".repeat(40)); assert.deepEqual(dependency?.resolutionEvidence, ["normalized URL match"]); assert.equal(dependency?.repositoryCandidates?.[0]?.canonical, false);
  const migration = store.db.prepare("SELECT MAX(version) version FROM schema_migrations").get() as { version: number };
  assert.equal(migration.version, 8);
  store.close();
});

test("recovers interrupted generations and queued jobs without publishing partial data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trace-store-recovery-"));
  const filename = path.join(directory, "trace.sqlite");
  let store = new TraceStore(filename);
  store.upsertRepository({ id: "repo", root: "/recovery/repo" });
  store.beginGeneration("repo", "pending", "main", false, 10);
  store.saveScanJob({ id: "job", repositoryId: "repo", state: "running", requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: { state: "running", stage: "analyzing" } });
  store.close();
  store = new TraceStore(filename);
  try {
    assert.equal(store.generations()[0]?.state, "failed");
    assert.equal(store.scanJobs()[0]?.state, "failed");
    assert.match(String(store.scanJobs()[0]?.status.error), /stopped before/i);
    assert.equal(store.repository("repo")?.activeGeneration, undefined);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
