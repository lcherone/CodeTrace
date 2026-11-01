import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { HistoryService } from "./history.js";
import { GitRepository } from "./git.js";
import { parsePhp } from "./php.js";
import { symbolsFromFiles } from "./relationships.js";
import { TraceStore } from "./store.js";

const exec = promisify(execFile);

async function initialise(root: string): Promise<void> {
  await mkdir(root, { recursive: true }); await exec("git", ["init", "-b", "main", root]);
  await exec("git", ["-C", root, "config", "user.name", "Trace Test"]); await exec("git", ["-C", root, "config", "user.email", "trace@example.test"]);
}
async function commit(root: string, message: string): Promise<string> {
  await exec("git", ["-C", root, "add", "--all"]); await exec("git", ["-C", root, "commit", "-m", message]);
  return (await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
}

test("method history follows a Git file move and only links a unique structural method rename", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-lineage-")); const store = new TraceStore(":memory:");
  try {
    await initialise(root); await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "LegacyPrice.php"), "<?php\nnamespace Example;\nclass PriceService {\n public function legacyPrice(int $value): int {\n  return $value + 10;\n }\n}\n");
    await commit(root, "Introduce pricing method");
    await exec("git", ["-C", root, "mv", "src/LegacyPrice.php", "src/PriceService.php"]);
    await writeFile(path.join(root, "src", "PriceService.php"), "<?php\nnamespace Example;\nclass PriceService {\n public function calculatePrice(int $value): int {\n  return $value + 10;\n }\n}\n");
    const moved = await commit(root, "Move pricing service and rename method");
    const source = await readFile(path.join(root, "src", "PriceService.php"), "utf8");
    const symbol = symbolsFromFiles("repo", 0, moved, [parsePhp(source, "src/PriceService.php")]).find((item) => item.fqn === "Example\\PriceService::calculatePrice");
    assert.ok(symbol);
    const events = await new HistoryService(store).analyze(root, symbol);
    const move = events.find((event) => event.category === "move"); const rename = events.find((event) => event.category === "rename");
    assert.deepEqual(move?.lineage && { fromPath: move.lineage.fromPath, toPath: move.lineage.toPath, fromSymbol: move.lineage.fromSymbol, toSymbol: move.lineage.toSymbol, confidence: move.lineage.confidence }, { fromPath: "src/LegacyPrice.php", toPath: "src/PriceService.php", fromSymbol: "Example\\PriceService::legacyPrice", toSymbol: "Example\\PriceService::calculatePrice", confidence: "possible" });
    assert.deepEqual(move?.lineage?.evidence.map((evidence) => evidence.resolutionMethod), ["git-rename-diff", "syntax-fingerprint-and-git-change"]);
    assert.deepEqual(rename?.lineage && { fromPath: rename.lineage.fromPath, toPath: rename.lineage.toPath, fromSymbol: rename.lineage.fromSymbol, toSymbol: rename.lineage.toSymbol, confidence: rename.lineage.confidence }, { fromPath: "src/LegacyPrice.php", toPath: "src/PriceService.php", fromSymbol: "Example\\PriceService::legacyPrice", toSymbol: "Example\\PriceService::calculatePrice", confidence: "possible" });
    assert.ok(move?.beforeSource?.includes("legacyPrice"));
    assert.equal(rename?.lineage?.evidence[0]?.resolutionMethod, "syntax-fingerprint-and-git-change");
    const controller = new AbortController(); controller.abort();
    await assert.rejects(new HistoryService(store).analyze(root, symbol, controller.signal), (error: unknown) => error instanceof DOMException && error.name === "AbortError");
    const bounded = await new HistoryService(store).analyze(root, symbol, undefined, 1);
    assert.ok(bounded.some((event) => event.limitations.some((limitation) => limitation.includes("bounded to 1"))));
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("method history refuses ambiguous rename continuity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-lineage-ambiguous-")); const store = new TraceStore(":memory:");
  try {
    await initialise(root); await mkdir(path.join(root, "src")); const file = path.join(root, "src", "Service.php");
    await writeFile(file, "<?php namespace Example; class Service { public function first(int $value): int { return $value + 1; } public function second(int $value): int { return $value + 1; } }"); await commit(root, "Two possible predecessors");
    await writeFile(file, "<?php namespace Example; class Service { public function current(int $value): int { return $value + 1; } }"); const head = await commit(root, "Replace methods");
    const source = await readFile(file, "utf8"); const symbol = symbolsFromFiles("repo", 0, head, [parsePhp(source, "src/Service.php")]).find((item) => item.fqn === "Example\\Service::current"); assert.ok(symbol);
    const events = await new HistoryService(store).analyze(root, symbol);
    assert.equal(events.some((event) => event.category === "rename"), false);
    assert.equal(events.filter((event) => event.category === "introduction").length, 1);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("inclusion separates ancestry and patch equivalence from revert-aware active behaviour", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-inclusion-")); const store = new TraceStore(":memory:");
  try {
    await initialise(root); const file = path.join(root, "feature.txt"); await writeFile(file, "base\n"); const base = await commit(root, "Base");
    await writeFile(file, "base\nfeature\n"); const original = await commit(root, "Apply feature");
    await exec("git", ["-C", root, "revert", "--no-edit", original]); const reverted = (await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    await exec("git", ["-C", root, "cherry-pick", original]); const reapplied = (await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    await exec("git", ["-C", root, "switch", "-c", "equivalent", base]); await writeFile(file, "base\nfeature\n"); const equivalent = await commit(root, "Independent equivalent change");
    await exec("git", ["-C", root, "revert", "--no-edit", equivalent]); const equivalentRevert = (await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    const history = new HistoryService(store);
    const git = new GitRepository(root);
    assert.equal((await git.patchShape(reverted)).forward, (await git.patchShape(original)).reverse);
    const atOriginal = await history.assessInclusion(root, original, original, { repositoryId: "repo" });
    assert.equal(atOriginal.state, "contains-original"); assert.equal(atOriginal.activeBehaviour, "likely-active");
    const atRevert = await history.assessInclusion(root, original, reverted, { repositoryId: "repo" });
    assert.equal(atRevert.state, "contains-original"); assert.equal(atRevert.activeBehaviour, "reverted"); assert.equal(atRevert.revertCommit, reverted);
    const atReapply = await history.assessInclusion(root, original, reapplied, { repositoryId: "repo" });
    assert.equal(atReapply.activeBehaviour, "likely-active"); assert.equal(atReapply.lastMatchingCommit, reapplied);
    const atEquivalent = await history.assessInclusion(root, original, equivalent, { repositoryId: "repo" });
    assert.equal(atEquivalent.state, "likely-equivalent"); assert.equal(atEquivalent.equivalentCommit, equivalent); assert.equal(atEquivalent.activeBehaviour, "likely-active");
    assert.ok(atEquivalent.evidence.some((evidence) => evidence.resolutionMethod === "git-patch-id-stable"));
    const atEquivalentRevert = await history.assessInclusion(root, original, equivalentRevert, { repositoryId: "repo" });
    assert.equal(atEquivalentRevert.state, "likely-equivalent"); assert.equal(atEquivalentRevert.activeBehaviour, "reverted");
    const bounded = await history.assessInclusion(root, original, reapplied, { repositoryId: "repo", maxCommits: 1 });
    assert.equal(bounded.activeBehaviour, "unknown"); assert.ok(bounded.limitations.some((limitation) => limitation.includes("bounded to 1")));
    await exec("git", ["-C", root, "commit", "--allow-empty", "-m", "Metadata only"]); const patchlessCommit = (await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    const patchless = await history.assessInclusion(root, patchlessCommit, patchlessCommit, { repositoryId: "repo" }); assert.equal(patchless.state, "contains-original"); assert.equal(patchless.activeBehaviour, "unknown"); assert.ok(patchless.limitations.some((limitation) => limitation.includes("no stable textual patch-id")));
    const unavailable = await history.assessInclusion(root, "f".repeat(40), reapplied, { repositoryId: "repo" }); assert.equal(unavailable.state, "unknown"); assert.equal(unavailable.activeBehaviour, "unknown"); assert.ok(unavailable.limitations.some((limitation) => limitation.includes("unavailable")));
    const controller = new AbortController(); controller.abort(); await assert.rejects(history.assessInclusion(root, original, reapplied, { repositoryId: "repo", signal: controller.signal }), (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
