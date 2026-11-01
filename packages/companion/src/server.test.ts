import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { ChangeInclusionResponseSchema, CodeLensCountsResponseSchema, PROTOCOL_VERSION } from "@trace/contracts";
import { parsePhp } from "./php.js";
import { resolveRelationships, symbolsFromFiles } from "./relationships.js";
import { startServer } from "./server.js";

const exec = promisify(execFile);

test("loopback server exposes a CSP-safe dashboard and health but protects repository data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trace-server-"));
  const companion = await startServer({ host: "127.0.0.1", port: 0, dataDirectory: directory, fixtureMode: true, token: "test-token-that-is-long-enough" });
  try {
    const dashboard = await fetch(`${companion.url}/`);
    assert.equal(dashboard.status, 200);
    const dashboardBody = await dashboard.text();
    assert.match(dashboardBody, /Content-Security-Policy/);
    assert.doesNotMatch(dashboardBody, /\sstyle=/);
    const health = await fetch(`${companion.url}/health`);
    assert.equal(health.status, 200);
    const unauthorized = await fetch(`${companion.url}/v1/repositories`, { headers: { "X-Trace-Protocol": "1.0" } });
    assert.equal(unauthorized.status, 401);
    const mismatch = await fetch(`${companion.url}/v1/repositories`, { headers: { "X-Trace-Protocol": "0.9", Authorization: "Bearer test-token-that-is-long-enough" } });
    assert.equal(mismatch.status, 409);
  } finally {
    await companion.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CodeLens count route is authenticated, batched, cached, and revision-qualified", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trace-server-lenses-"));
  const token = "test-token-that-is-long-enough"; const commit = "a".repeat(40);
  const companion = await startServer({ host: "127.0.0.1", port: 0, dataDirectory: directory, fixtureMode: true, token, automaticScan: false });
  try {
    companion.store.upsertRepository({ id: "app", root: "/synthetic/app" });
    const generation = companion.store.beginGeneration("app", commit, "main", false, 1);
    const parsed = parsePhp("<?php namespace App; final class Service { public function target(): void {} public function caller(): void { $this->target(); } }", "src/Service.php");
    const symbols = symbolsFromFiles("app", generation, commit, [parsed]);
    const relationships = resolveRelationships("app", generation, commit, symbols);
    companion.store.publishGeneration(generation, "app", "lens-route", symbols, relationships, [{ repositoryId: "app", generation, rootPath: "", name: "example/app", sourceCommit: commit, autoload: {} }], []);
    const target = symbols.find((item) => item.fqn === "App\\Service::target"); assert.ok(target);
    const request = { protocolVersion: PROTOCOL_VERSION, repository: { repositoryId: "app", commit }, items: [{ id: "target", path: target.path, range: target.range, symbol: target.fqn }] };
    const headers = { "Content-Type": "application/json", "X-Trace-Protocol": PROTOCOL_VERSION, Authorization: `Bearer ${token}` };
    const unauthorized = await fetch(`${companion.url}/v1/lenses/counts`, { method: "POST", headers: { "Content-Type": "application/json", "X-Trace-Protocol": PROTOCOL_VERSION }, body: JSON.stringify(request) }); assert.equal(unauthorized.status, 401);
    const cold = await fetch(`${companion.url}/v1/lenses/counts`, { method: "POST", headers, body: JSON.stringify(request) }); assert.equal(cold.status, 200);
    const coldPayload = await cold.json(); assert.equal(CodeLensCountsResponseSchema.safeParse(coldPayload).success, true);
    assert.deepEqual((coldPayload as any).cache, { hits: 0, misses: 1, rebuilt: true }); assert.equal((coldPayload as any).counts[0].callers, 1); assert.equal((coldPayload as any).counts[0].consumers, 0);
    const warm = await fetch(`${companion.url}/v1/lenses/counts`, { method: "POST", headers, body: JSON.stringify(request) }); assert.equal(warm.status, 200); assert.deepEqual(((await warm.json()) as any).cache, { hits: 1, misses: 0, rebuilt: false });
    const stale = await fetch(`${companion.url}/v1/lenses/counts`, { method: "POST", headers, body: JSON.stringify({ ...request, repository: { repositoryId: "app", commit: "b".repeat(40) } }) }); assert.equal(stale.status, 409);
  } finally {
    await companion.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("temporal comparison route is authenticated and reports the exact missing repository revision", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trace-server-temporal-"));
  const token = "test-token-that-is-long-enough";
  const companion = await startServer({ host: "127.0.0.1", port: 0, dataDirectory: directory, fixtureMode: false, token, automaticScan: false });
  const missing = "f".repeat(40);
  const point = { revisions: { workspace: missing }, selection: { repositoryPath: process.cwd(), relativePath: "missing.php", revision: { repositoryId: "workspace", commit: missing, dirty: false }, range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 }, selectedText: "missing" } };
  const request = { protocolVersion: PROTOCOL_VERSION, mode: "origin", before: point, after: point };
  try {
    companion.store.upsertRepository({ id: "workspace", root: process.cwd() });
    const unauthorized = await fetch(`${companion.url}/v1/trace/compare`, { method: "POST", headers: { "Content-Type": "application/json", "X-Trace-Protocol": PROTOCOL_VERSION }, body: JSON.stringify(request) });
    assert.equal(unauthorized.status, 401);
    const missingRevision = await fetch(`${companion.url}/v1/trace/compare`, { method: "POST", headers: { "Content-Type": "application/json", "X-Trace-Protocol": PROTOCOL_VERSION, Authorization: `Bearer ${token}` }, body: JSON.stringify(request) });
    assert.equal(missingRevision.status, 404);
    const payload = await missingRevision.json() as { error: { code: string; details: { side: string; repositoryId: string; requestedCommit: string; reason: string } } };
    assert.equal(payload.error.code, "NOT_FOUND");
    assert.deepEqual(payload.error.details, { side: "before", repositoryId: "workspace", requestedCommit: missing, reason: "Commit object is unavailable" });
  } finally {
    await companion.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("inclusion route returns revert-aware release assessments", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trace-server-inclusion-")); const repository = path.join(directory, "repository");
  const token = "test-token-that-is-long-enough"; await mkdir(path.join(repository, "src"), { recursive: true });
  await exec("git", ["init", "-b", "main", repository]); await exec("git", ["-C", repository, "config", "user.name", "Trace Test"]); await exec("git", ["-C", repository, "config", "user.email", "trace@example.test"]);
  await writeFile(path.join(repository, "composer.json"), JSON.stringify({ name: "example/package", autoload: { "psr-4": { "Example\\": "src/" } } }));
  await writeFile(path.join(repository, "src", "Service.php"), "<?php namespace Example; class Service { public function value(): int { return 1; } }");
  await exec("git", ["-C", repository, "add", "--all"]); await exec("git", ["-C", repository, "commit", "-m", "Initial service"]);
  await writeFile(path.join(repository, "src", "Service.php"), "<?php namespace Example; class Service { public function value(): int { return 2; } }");
  await exec("git", ["-C", repository, "add", "--all"]); await exec("git", ["-C", repository, "commit", "-m", "Apply value change"]);
  const selected = (await exec("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim(); await exec("git", ["-C", repository, "tag", "v-active"]);
  await exec("git", ["-C", repository, "revert", "--no-edit", selected]); const reverted = (await exec("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim(); await exec("git", ["-C", repository, "tag", "v-reverted"]);
  const base = (await exec("git", ["-C", repository, "rev-parse", `${selected}^`])).stdout.trim(); await exec("git", ["-C", repository, "switch", "-c", "equivalent", base]);
  await writeFile(path.join(repository, "src", "Service.php"), "<?php namespace Example; class Service { public function value(): int { return 2; } }"); await exec("git", ["-C", repository, "add", "--all"]); await exec("git", ["-C", repository, "commit", "-m", "Independent equivalent patch"]); await exec("git", ["-C", repository, "tag", "v-equivalent"]); await exec("git", ["-C", repository, "switch", "main"]);
  const consumer = path.join(directory, "consumer"); await mkdir(consumer); await exec("git", ["init", "-b", "main", consumer]); await exec("git", ["-C", consumer, "config", "user.name", "Trace Test"]); await exec("git", ["-C", consumer, "config", "user.email", "trace@example.test"]);
  await writeFile(path.join(consumer, "composer.json"), JSON.stringify({ name: "example/consumer", require: { "example/package": "^1" } })); await writeFile(path.join(consumer, "composer.lock"), JSON.stringify({ packages: [{ name: "example/package", version: "1.0.0", source: { type: "git", url: "https://github.com/example/package.git", reference: selected } }], "packages-dev": [] })); await exec("git", ["-C", consumer, "add", "--all"]); await exec("git", ["-C", consumer, "commit", "-m", "Lock package"]);
  const github = createHttpServer((request, response) => {
    if (request.url?.includes(`/commits/${selected}/pulls`)) { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify([{ number: 17, html_url: "https://github.com/example/package/pull/17", title: "Value change", state: "closed", merged_at: "2025-01-01T00:00:00Z", head: { sha: selected, repo: { full_name: "contributor/package", html_url: "https://github.com/contributor/package" } } }])); return; }
    if (request.url?.endsWith("/releases/tags/v-active")) { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ html_url: "https://github.com/example/package/releases/tag/v-active", name: "Active", published_at: "2025-01-02T00:00:00Z", draft: false, prerelease: false, target_commitish: "main" })); return; }
    if (request.url?.endsWith("/releases/tags/v-equivalent")) { response.writeHead(503); response.end(); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve) => github.listen(0, "127.0.0.1", resolve)); const githubAddress = github.address(); assert.ok(githubAddress && typeof githubAddress === "object");
  const companion = await startServer({ host: "127.0.0.1", port: 0, dataDirectory: path.join(directory, "data"), fixtureMode: false, token, automaticScan: false, scanner: { watchFileSystem: false, discoverComposerPackages: false }, githubApiBase: `http://127.0.0.1:${githubAddress.port}` });
  const headers = { "Content-Type": "application/json", "X-Trace-Protocol": PROTOCOL_VERSION, Authorization: `Bearer ${token}` };
  try {
    companion.store.upsertRepository({ id: "package", root: repository, remoteUrl: "git@github.com:Example/Package.git" });
    const indexed = await fetch(`${companion.url}/v1/index`, { method: "POST", headers, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, repositoryId: "package" }) }); assert.equal(indexed.status, 200);
    companion.store.upsertRepository({ id: "consumer", root: consumer }); const consumerIndexed = await fetch(`${companion.url}/v1/index`, { method: "POST", headers, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, repositoryId: "consumer" }) }); assert.equal(consumerIndexed.status, 200);
    const packageResponse = await fetch(`${companion.url}/v1/packages`, { headers: { "X-Trace-Protocol": PROTOCOL_VERSION, Authorization: `Bearer ${token}` } }); assert.equal(packageResponse.status, 200);
    const packagePayload = await packageResponse.json() as { dependencies: Array<{ packageName: string; indexedRepositoryId?: string; indexedRevision?: string; resolutionMethod?: string; resolution?: string }> };
    const linkedDependency = packagePayload.dependencies.find((item) => item.packageName === "example/package"); assert.equal(linkedDependency?.indexedRepositoryId, "package"); assert.equal(linkedDependency?.indexedRevision, reverted); assert.equal(linkedDependency?.resolutionMethod, "source-url"); assert.equal(linkedDependency?.resolution, "unavailable");
    const symbol = companion.store.activeSymbols().find((item) => item.fqn === "Example\\Service::value"); assert.ok(symbol);
    const withoutToken = await fetch(`${companion.url}/v1/inclusion`, { method: "POST", headers, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, symbolId: symbol.id, commit: selected }) }); assert.equal(withoutToken.status, 200);
    const withoutTokenPayload = await withoutToken.json() as { githubAssociations: { pullRequests: unknown[]; releases: unknown[]; limitations: string[] } };
    assert.deepEqual(withoutTokenPayload.githubAssociations.pullRequests, []); assert.deepEqual(withoutTokenPayload.githubAssociations.releases, []); assert.ok(withoutTokenPayload.githubAssociations.limitations.some((item) => item.includes("no GitHub token")));
    const credentials = await fetch(`${companion.url}/v1/credentials/github`, { method: "PUT", headers, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, token: "github-test-token" }) }); assert.equal(credentials.status, 200);
    const response = await fetch(`${companion.url}/v1/inclusion`, { method: "POST", headers, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, symbolId: symbol.id, commit: selected }) }); assert.equal(response.status, 200);
    const payload = await response.json() as { releases: string[]; releaseAssessments: Array<{ release: string; revision: string; state: string; activeBehaviour: string; revertCommit?: string }>; consumers: Array<{ limitations: string[] }>; githubAssociations: { pullRequests: Array<{ number: number; headRepository?: string }>; releases: Array<{ tagName: string; tagCommit: string; draft: boolean; prerelease: boolean }>; limitations: string[] } };
    assert.equal(ChangeInclusionResponseSchema.safeParse(payload).success, true);
    assert.deepEqual(new Set(payload.releases), new Set(["v-active", "v-reverted"]));
    assert.equal(payload.releaseAssessments.find((item) => item.release === "v-active")?.activeBehaviour, "likely-active");
    const revertedAssessment = payload.releaseAssessments.find((item) => item.release === "v-reverted"); assert.equal(revertedAssessment?.activeBehaviour, "reverted"); assert.equal(revertedAssessment?.revertCommit, reverted);
    const equivalentAssessment = payload.releaseAssessments.find((item) => item.release === "v-equivalent"); assert.equal(equivalentAssessment?.state, "likely-equivalent"); assert.equal(equivalentAssessment?.activeBehaviour, "likely-active");
    assert.ok(payload.consumers[0]?.limitations.some((limitation) => limitation.includes("selected change paths")));
    assert.equal(payload.githubAssociations.pullRequests[0]?.number, 17); assert.equal(payload.githubAssociations.pullRequests[0]?.headRepository, "contributor/package");
    const githubRelease = payload.githubAssociations.releases.find((item) => item.tagName === "v-active"); assert.equal(githubRelease?.tagCommit, selected); assert.equal(githubRelease?.draft, false); assert.equal(githubRelease?.prerelease, false);
    assert.ok(payload.githubAssociations.limitations.some((limitation) => limitation.includes("v-equivalent") && limitation.includes("503")));
  } finally { await companion.close(); await new Promise<void>((resolve, reject) => github.close((error) => error ? reject(error) : resolve())); await rm(directory, { recursive: true, force: true }); }
});
