import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runScannerBenchmark, ScannerBenchmarkError } from "./scanner-benchmark.js";

function git(repository: string, args: string[]): void {
  execFileSync("git", ["-C", repository, ...args], { stdio: "ignore" });
}

test("reports only anonymized scanner aggregates", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "trace-private-benchmark-"));
  const repository = path.join(parent, "customer-name-must-not-leak");
  try {
    await mkdir(path.join(repository, "src", "PrivateModule"), { recursive: true });
    await mkdir(path.join(repository, "vendor", "Ignored"), { recursive: true });
    await writeFile(path.join(repository, "src", "PrivateModule", "SecretSymbol.php"), "<?php final class SecretSymbol {}\n");
    await writeFile(path.join(repository, "composer.json"), '{"name":"private/customer-package"}\n');
    await writeFile(path.join(repository, "composer.lock"), '{"packages":[]}\n');
    await writeFile(path.join(repository, "vendor", "Ignored", "Dependency.php"), "<?php\n");
    await symlink(path.join(repository, "composer.json"), path.join(repository, "src", "linked.php"));
    git(repository, ["init", "-b", "main"]);
    git(repository, ["add", "--all"]);

    const report = await runScannerBenchmark({ root: repository, concurrency: [1, 2], iterations: 2, warmup: 0 });
    assert.equal(report.inventory.discoveredFiles, 5);
    assert.equal(report.inventory.discovery.rootGitFiles, 5);
    assert.equal(report.inventory.selectedFiles, 4);
    assert.equal(report.inventory.readableFiles, 3);
    assert.equal(report.inventory.categories.php, 1);
    assert.equal(report.inventory.categories.composerManifest, 1);
    assert.equal(report.inventory.categories.composerLock, 1);
    assert.equal(report.inventory.skipped.symbolicLink, 1);
    assert.deepEqual(report.loads.map((load) => load.samples), [2, 2]);

    const output = JSON.stringify(report);
    for (const privateValue of [repository, path.basename(repository), "PrivateModule", "SecretSymbol", "private/customer-package"]) {
      assert.doesNotMatch(output, new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("auto discovery follows Composer-installed package roots when the root Git inventory is sparse", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "trace-composer-benchmark-"));
  const repository = path.join(parent, "anonymous-workspace");
  try {
    await mkdir(path.join(repository, "vendor", "composer"), { recursive: true });
    await mkdir(path.join(repository, "vendor", "example", "library", "src"), { recursive: true });
    await writeFile(path.join(repository, "README.md"), "tracked root file\n");
    await writeFile(path.join(repository, "composer.json"), '{"require":{"example/library":"1.0.0"}}\n');
    await writeFile(path.join(repository, "composer.lock"), '{"packages":[{"name":"example/library"}]}\n');
    await writeFile(path.join(repository, "vendor", "composer", "installed.json"), '{"packages":[{"name":"example/library","install-path":"../example/library"}]}\n');
    await writeFile(path.join(repository, "vendor", "example", "library", "composer.json"), '{"name":"example/library"}\n');
    await writeFile(path.join(repository, "vendor", "example", "library", "src", "Library.php"), "<?php final class Library {}\n");
    git(repository, ["init", "-b", "main"]);
    git(repository, ["add", "README.md"]);

    const report = await runScannerBenchmark({ root: repository, concurrency: [1], iterations: 1, warmup: 0 });
    assert.equal(report.inventory.discovery.rootGitFiles, 1);
    assert.equal(report.inventory.discovery.composerPackages, 1);
    assert.equal(report.inventory.discovery.filesystemPackageRoots, 1);
    assert.equal(report.inventory.categories.php, 1);
    assert.equal(report.inventory.categories.composerManifest, 2);
    assert.equal(report.inventory.categories.composerLock, 1);
    assert.equal(report.inventory.readableFiles, 4);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("returns a stable error code instead of a raw repository error", async () => {
  await assert.rejects(
    runScannerBenchmark({ root: path.join(os.tmpdir(), "trace-benchmark-repository-that-does-not-exist"), source: "git-tracked" }),
    (error: unknown) => error instanceof ScannerBenchmarkError && error.code === "git-inventory-failed",
  );
});
