import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { discoverComposerRepositories } from "./discovery.js";
import { IndexCoordinator } from "./indexer.js";
import { TraceStore } from "./store.js";

const exec = promisify(execFile);
const sourceFiles = 500;
const installedPackages = 300;
const root = await mkdtemp(path.join(os.tmpdir(), "trace-scanner-benchmark-"));

try {
  await mkdir(path.join(root, "src"), { recursive: true });
  const locked = Array.from({ length: installedPackages }, (_, index) => ({ name: `fixture/package-${String(index).padStart(3, "0")}`, source: { reference: `revision-${index}` } }));
  await writeFile(path.join(root, "composer.json"), JSON.stringify({ name: "fixture/scanner-benchmark", autoload: { "psr-4": { "Fixture\\": "src/" } } }));
  await writeFile(path.join(root, "composer.lock"), JSON.stringify({ packages: locked }));
  await Promise.all(Array.from({ length: sourceFiles }, async (_, index) => writeFile(path.join(root, "src", `Service${index}.php`), `<?php namespace Fixture; final class Service${index} { public function value(): int { return ${index}; } }`)));
  await mkdir(path.join(root, "vendor", "composer"), { recursive: true });
  const installed = [];
  for (let index = 0; index < installedPackages; index++) {
    const name = `fixture/package-${String(index).padStart(3, "0")}`;
    const packageRoot = path.join(root, "vendor", ...name.split("/"));
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, "composer.json"), JSON.stringify({ name }));
    installed.push({ name, "install-path": `../fixture/package-${String(index).padStart(3, "0")}` });
  }
  await writeFile(path.join(root, "vendor", "composer", "installed.json"), JSON.stringify({ packages: installed }));
  await exec("git", ["init", "-b", "main", root]);
  await exec("git", ["-C", root, "add", "composer.json", "composer.lock", "src"]);
  await exec("git", ["-C", root, "-c", "user.name=Trace Benchmark", "-c", "user.email=benchmark@example.test", "commit", "-m", "Synthetic scanner corpus"]);

  const discoveryStarted = performance.now();
  const repositories = await discoverComposerRepositories({ id: "benchmark", root });
  const packageDiscoveryMs = performance.now() - discoveryStarted;
  const store = new TraceStore(":memory:"); store.upsertRepository({ id: "benchmark", root });
  const scanner = new IndexCoordinator(store, { analysisConcurrency: 8, repositoryConcurrency: 2, watchFileSystem: false, discoverComposerPackages: false });
  const coldStarted = performance.now(); const cold = await scanner.index({ id: "benchmark", root }); const coldMs = performance.now() - coldStarted;
  const warmStarted = performance.now(); const warm = await scanner.index({ id: "benchmark", root }); const warmMs = performance.now() - warmStarted;
  await scanner.close(); store.close();
  const queueStore = new TraceStore(":memory:");
  const queueScanner = new IndexCoordinator(queueStore, { repositoryConcurrency: 1, maxQueue: installedPackages + 1, watchFileSystem: false, discoverComposerPackages: false });
  const queuedRepositories = Array.from({ length: installedPackages }, (_, index) => ({ id: `queued-${index}`, root: `/synthetic/queued-${index}` }));
  queuedRepositories.forEach((repository) => queueStore.upsertRepository(repository));
  const queueStarted = performance.now(); queuedRepositories.forEach((repository) => queueScanner.schedule(repository)); const queueScheduleMs = performance.now() - queueStarted;
  const queuedPackages = queueScanner.snapshot().queued;
  queuedRepositories.forEach((repository) => queueScanner.cancel(repository.id)); await queueScanner.close(); queueStore.close();
  console.log(JSON.stringify({ sourceFiles, installedPackages, discoveredRepositories: repositories.length, packageDiscoveryMs: Number(packageDiscoveryMs.toFixed(1)), queuedPackages, queueScheduleMs: Number(queueScheduleMs.toFixed(1)), coldMs: Number(coldMs.toFixed(1)), warmMs: Number(warmMs.toFixed(1)), coldAnalyzed: cold.analyzedFiles, warmAnalyzed: warm.analyzedFiles, warmCacheHits: warm.cacheHits, warmSpeedup: Number((coldMs / Math.max(1, warmMs)).toFixed(2)) }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
