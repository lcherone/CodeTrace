import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { discoverComposerRepositories } from "./discovery.js";
import { GitRepository } from "./git.js";
import { GraphService } from "./graph.js";
import { IndexCoordinator, ScannerBackpressureError } from "./indexer.js";
import { TraceStore } from "./store.js";

const exec = promisify(execFile);

test("indexes a repository and traces an override to its parent implementation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-index-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "composer.json"), JSON.stringify({ name: "acme/orders", autoload: { "psr-4": { "Acme\\": "src/" } } }));
  await writeFile(path.join(root, "src", "BaseOrder.php"), "<?php namespace Acme; class BaseOrder { public function total(): int { return 1; } }");
  await writeFile(path.join(root, "src", "Order.php"), "<?php\nnamespace Acme;\nclass Order extends BaseOrder {\n public function total(): int { return parent::total() + 1; }\n}\n");
  await exec("git", ["init", "-b", "main", root]);
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "-c", "user.name=Trace Test", "-c", "user.email=trace@example.test", "commit", "-m", "Initial symbols"]);
  const revision = await new GitRepository(root).revision();
  const store = new TraceStore(":memory:");
  store.upsertRepository({ id: "orders", root });
  try {
    const state = await new IndexCoordinator(store, 2).index({ id: "orders", root });
    assert.equal(state.state, "ready");
    const graph = new GraphService(store).trace({ repositoryPath: root, relativePath: "src/Order.php", revision: { repositoryId: "orders", commit: revision.commit, dirty: false }, range: { startLine: 4, startColumn: 20, endLine: 4, endColumn: 25 }, selectedText: "total" }, "origin");
    assert.ok(graph.edges.some((edge) => edge.type === "overrides"));
    assert.ok(graph.edges.some((edge) => edge.type === "calls-parent"));
    assert.ok(graph.edges.every((edge) => edge.evidence.length > 0));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("uses Composer autoload discovery when the root Git inventory is incomplete", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-fallback-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, ".tracked"), "release marker\n");
  await writeFile(path.join(root, "composer.json"), JSON.stringify({ name: "example/release", autoload: { "psr-4": { "Example\\": "src/" } } }));
  await writeFile(path.join(root, "src", "Service.php"), "<?php namespace Example; final class Service { public function run(): void {} }");
  await exec("git", ["init", "-b", "main", root]);
  await exec("git", ["-C", root, "add", ".tracked"]);
  await exec("git", ["-C", root, "-c", "user.name=Trace Test", "-c", "user.email=trace@example.test", "commit", "-m", "Track release marker only"]);
  const store = new TraceStore(":memory:"); store.upsertRepository({ id: "release", root });
  const scanner = new IndexCoordinator(store, { watchFileSystem: false, discoverComposerPackages: false });
  try {
    const result = await scanner.index({ id: "release", root });
    assert.equal(result.state, "ready");
    assert.equal(result.filesystemFallback, true);
    assert.ok(store.activeSymbols().some((symbol) => symbol.fqn === "Example\\Service"));
  } finally { await scanner.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("discovers only locked and installed Composer package repositories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-composer-discovery-"));
  const shared = path.join(root, "vendor", "example", "shared");
  const ignored = path.join(root, "vendor", "example", "ignored");
  await mkdir(path.join(root, "vendor", "composer"), { recursive: true });
  await mkdir(path.join(shared, "src"), { recursive: true });
  await mkdir(ignored, { recursive: true });
  const sharedRevision = "a".repeat(40);
  await writeFile(path.join(root, "composer.lock"), JSON.stringify({ packages: [{ name: "example/shared", source: { reference: sharedRevision, url: "https://example.test/shared.git" } }] }));
  await writeFile(path.join(root, "vendor", "composer", "installed.json"), JSON.stringify({ packages: [{ name: "example/shared", "install-path": "../example/shared" }, { name: "example/ignored", "install-path": "../example/ignored" }] }));
  await writeFile(path.join(shared, "composer.json"), JSON.stringify({ name: "example/shared", autoload: { "psr-4": { "Example\\Shared\\": "src/" } } }));
  await writeFile(path.join(shared, "src", "SharedService.php"), "<?php namespace Example\\Shared; class SharedService {}");
  await writeFile(path.join(ignored, "composer.json"), JSON.stringify({ name: "example/ignored" }));
  await exec("git", ["init", "-b", "main", shared]); await exec("git", ["-C", shared, "add", "."]);
  await exec("git", ["-C", shared, "-c", "user.name=Trace Test", "-c", "user.email=trace@example.test", "commit", "-m", "Shared package"]);
  try {
    const discovered = await discoverComposerRepositories({ id: "root", root });
    assert.equal(discovered.length, 1);
    assert.match(discovered[0]?.id ?? "", /^composer:example-shared:/);
    assert.equal(discovered[0]?.sourceRevision, sharedRevision);
    assert.equal(discovered.some((repository) => repository.id.includes("ignored")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("warm scans reuse Git object fingerprints without reanalysis", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-incremental-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "composer.json"), JSON.stringify({ name: "example/incremental", autoload: { "psr-4": { "Example\\": "src/" } } }));
  for (let index = 0; index < 12; index++) await writeFile(path.join(root, "src", `Service${index}.php`), `<?php namespace Example; final class Service${index} { public function id(): int { return ${index}; } }`);
  await exec("git", ["init", "-b", "main", root]); await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "-c", "user.name=Trace Test", "-c", "user.email=trace@example.test", "commit", "-m", "Services"]);
  const store = new TraceStore(":memory:"); store.upsertRepository({ id: "incremental", root });
  const scanner = new IndexCoordinator(store, { watchFileSystem: false, discoverComposerPackages: false, analysisConcurrency: 4 });
  try {
    const cold = await scanner.index({ id: "incremental", root });
    const warm = await scanner.index({ id: "incremental", root });
    assert.equal(cold.cacheMisses, 12);
    assert.equal(warm.cacheHits, 12);
    assert.equal(warm.cacheMisses, 0);
    assert.equal(warm.analyzedFiles, 0);
    assert.equal(warm.generation, cold.generation);
    assert.equal(store.generations().length, 1);
  } finally { await scanner.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("coalesces duplicate jobs, applies backpressure, and cancels queued work", async () => {
  const store = new TraceStore(":memory:");
  const first = { id: "first", root: "/virtual/first" }; const second = { id: "second", root: "/virtual/second" };
  store.upsertRepository(first); store.upsertRepository(second);
  const scanner = new IndexCoordinator(store, { repositoryConcurrency: 1, maxQueue: 1, watchFileSystem: false, discoverComposerPackages: false });
  try {
    const scheduled = scanner.schedule(first);
    const duplicate = scanner.schedule(first);
    assert.equal(duplicate.coalesced, true);
    assert.equal(duplicate.jobId, scheduled.jobId);
    assert.throws(() => scanner.schedule(second), ScannerBackpressureError);
    assert.equal(scanner.cancel(first.id), true);
    assert.equal((await scheduled.promise).state, "cancelled");
  } finally { await scanner.close(); store.close(); }
});

test("a failed refresh leaves the previously published generation active", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-atomic-")); await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "composer.json"), JSON.stringify({ name: "example/atomic", autoload: { "psr-4": { "Example\\": "src/" } } }));
  const sourcePath = path.join(root, "src", "Stable.php"); await writeFile(sourcePath, "<?php namespace Example; class Stable {}");
  await exec("git", ["init", "-b", "main", root]); await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "-c", "user.name=Trace Test", "-c", "user.email=trace@example.test", "commit", "-m", "Stable source"]);
  const store = new TraceStore(":memory:"); store.upsertRepository({ id: "atomic", root });
  const scanner = new IndexCoordinator(store, { watchFileSystem: false, discoverComposerPackages: false });
  try {
    const first = await scanner.index({ id: "atomic", root }); const active = store.repository("atomic")?.activeGeneration;
    assert.equal(first.state, "ready");
    await writeFile(path.join(root, "composer.json"), "{ invalid composer metadata");
    const failed = await scanner.index({ id: "atomic", root });
    assert.equal(failed.state, "failed");
    assert.equal(store.repository("atomic")?.activeGeneration, active);
    assert.ok(store.activeSymbols().some((symbol) => symbol.fqn === "Example\\Stable"));
  } finally { await scanner.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("unsupported PHP syntax is isolated without failing the repository generation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-partial-")); await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "composer.json"), JSON.stringify({ name: "example/partial", autoload: { "psr-4": { "Example\\": "src/" } } }));
  await writeFile(path.join(root, "src", "Valid.php"), "<?php namespace Example; class Valid {}");
  await writeFile(path.join(root, "src", "Unsupported.php"), "<?php class Unsupported { public function broken( }");
  await exec("git", ["init", "-b", "main", root]); await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "-c", "user.name=Trace Test", "-c", "user.email=trace@example.test", "commit", "-m", "Mixed syntax"]);
  const store = new TraceStore(":memory:"); store.upsertRepository({ id: "partial", root });
  const scanner = new IndexCoordinator(store, { watchFileSystem: false, discoverComposerPackages: false });
  try {
    const result = await scanner.index({ id: "partial", root });
    assert.equal(result.state, "ready");
    assert.equal(result.analysisFailures, 1);
    assert.ok(store.activeSymbols().some((symbol) => symbol.fqn === "Example\\Valid"));
  } finally { await scanner.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("filesystem updates are filtered and debounced into one safe refresh", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-watch-")); await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "composer.json"), JSON.stringify({ name: "example/watch", autoload: { "psr-4": { "Example\\": "src/" } } }));
  await writeFile(path.join(root, "src", "Watched.php"), "<?php namespace Example; class Watched {}");
  await exec("git", ["init", "-b", "main", root]); await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "-c", "user.name=Trace Test", "-c", "user.email=trace@example.test", "commit", "-m", "Watched source"]);
  const store = new TraceStore(":memory:"); const repository = { id: "watch", root }; store.upsertRepository(repository);
  const scanner = new IndexCoordinator(store, { watchFileSystem: false, discoverComposerPackages: false, watchDebounceMs: 25 }); scanner.addRepository(repository);
  try {
    assert.equal(scanner.notifyFilesystemChange("watch", "vendor/example/Dependency.php"), false);
    assert.equal(scanner.notifyFilesystemChange("watch", "README.md"), false);
    assert.equal(scanner.notifyFilesystemChange("watch", "src/Watched.php"), true);
    assert.equal(scanner.notifyFilesystemChange("watch", "src/Watched.php"), true);
    for (let attempt = 0; attempt < 100 && scanner.state("watch")?.state !== "ready"; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(scanner.state("watch")?.state, "ready");
    assert.equal(scanner.state("watch")?.reason, "filesystem");
    assert.equal(store.scanJobs().length, 1);
  } finally { await scanner.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
