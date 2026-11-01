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

test("browser launch, cookie auth, editor context, assets, and source privacy work end to end", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trace-server-browser-"));
  const token = "test-token-that-is-long-enough", commit = "a".repeat(40), root = "/synthetic/browser";
  const companion = await startServer({ host: "127.0.0.1", port: 0, dataDirectory: directory, fixtureMode: true, token, automaticScan: false });
  const bearer = { "Content-Type": "application/json", "X-Trace-Protocol": PROTOCOL_VERSION, Authorization: `Bearer ${token}` };
  try {
    companion.store.upsertRepository({ id: "browser-repo", root });
    const generation = companion.store.beginGeneration("browser-repo", commit, "main", false, 1);
    const parsed = parsePhp(`<?php
namespace App;

final class Service
{
    public function target(): void {}
}`, "src/Service.php");
    const symbols = symbolsFromFiles("browser-repo", generation, commit, [parsed]);
    companion.store.publishGeneration(generation, "browser-repo", "browser-route", symbols, resolveRelationships("browser-repo", generation, commit, symbols), [], []);
    const focus = symbols.find((item) => item.fqn === "App\\Service::target"); assert.ok(focus);
    for (const symbol of symbols) companion.store.replaceHistory("browser-repo", symbol.id, [{ id: `history-source-${symbol.kind}`, symbolId: symbol.id, commit, category: "implementation", summary: "Changed target", authorName: "Trace", authorEmail: "trace@example.test", authoredAt: new Date().toISOString(), beforeSource: "<?php SENTINEL_BROWSER_SOURCE", afterSource: "<?php SENTINEL_BROWSER_SOURCE_AFTER", limitations: [] }]);

    const page = await fetch(`${companion.url}/`); const html = await page.text(); assert.equal(page.status, 200);
    const nonce = html.match(/script-src 'self' 'nonce-([^']+)'/)?.[1]; assert.ok(nonce); assert.match(page.headers.get("content-security-policy") ?? "", new RegExp(`style-src 'self' 'nonce-${nonce}'`)); assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/); assert.match(html, new RegExp(`nonce="${nonce}" src="/browser/bridge\\.js\\?v=[a-f0-9]+"`)); assert.match(html, new RegExp(`nonce="${nonce}" src="/browser/app\\.js\\?v=[a-f0-9]+"`)); assert.doesNotMatch(html, /\{\{[^}]+\}\}/);
    for (const asset of ["bridge.js", "app.js", "app.css", "codicon.ttf"]) { const response = await fetch(`${companion.url}/browser/${asset}`); assert.equal(response.status, 200, asset); assert.equal(response.headers.get("cache-control"), "no-store", asset); }

    const launch = await fetch(`${companion.url}/v1/browser-launch`, { method: "POST", headers: bearer, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION }) }); assert.equal(launch.status, 201);
    const launchPayload = await launch.json() as { url: string; expiresAt: string }; assert.equal(new URL(launchPayload.url).origin, companion.url);
    const exchange = await fetch(launchPayload.url, { redirect: "manual" }); assert.equal(exchange.status, 303); assert.equal(exchange.headers.get("location"), "/");
    const setCookie = exchange.headers.get("set-cookie"); assert.ok(setCookie); assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(";")[0]!;
    const reuse = await fetch(launchPayload.url, { redirect: "manual" }); assert.equal(reuse.status, 401);
    const repositories = await fetch(`${companion.url}/v1/repositories`, { headers: { "X-Trace-Protocol": PROTOCOL_VERSION, Cookie: cookie } }); assert.equal(repositories.status, 200);

    const selection = { repositoryPath: root, relativePath: focus.path, revision: { repositoryId: root, commit, dirty: true }, range: focus.range };
    const leakedContext = await fetch(`${companion.url}/v1/editor-context`, { method: "POST", headers: bearer, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, clientId: "window-1", context: { mode: "origin", selection: { ...selection, selectedText: "SENTINEL", documentText: "<?php SENTINEL_BROWSER_SOURCE" } } }) }); assert.equal(leakedContext.status, 400);
    const mismatch = await fetch(`${companion.url}/v1/editor-context`, { method: "POST", headers: bearer, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, clientId: "window-1", context: { mode: "origin", selection: { ...selection, revision: { ...selection.revision, commit: "b".repeat(40) } } } }) }); assert.equal(mismatch.status, 409);
    const update = await fetch(`${companion.url}/v1/editor-context`, { method: "POST", headers: bearer, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, clientId: "window-1", context: { mode: "origin", theme: "dark", selection } }) }); assert.equal(update.status, 200);
    const current = await fetch(`${companion.url}/v1/editor-context?after=0&waitMs=0`, { headers: { "X-Trace-Protocol": PROTOCOL_VERSION, Cookie: cookie } }); const currentPayload = await current.json() as any; assert.equal(currentPayload.context.generation, generation); assert.equal(currentPayload.context.selection.revision.repositoryId, "browser-repo"); assert.equal(currentPayload.context.selection.revision.dirty, true); assert.equal(JSON.stringify(currentPayload).includes("SENTINEL_BROWSER_SOURCE"), false);

    const traceBody = { protocolVersion: PROTOCOL_VERSION, mode: "origin", limit: 100, selection: { ...selection, selectedText: "target" } };
    const browserTrace = await fetch(`${companion.url}/v1/trace`, { method: "POST", headers: { "Content-Type": "application/json", "X-Trace-Protocol": PROTOCOL_VERSION, Cookie: cookie, Origin: companion.url }, body: JSON.stringify(traceBody) }); assert.equal(browserTrace.status, 200); const browserText = await browserTrace.text(); assert.doesNotMatch(browserText, /SENTINEL_BROWSER_SOURCE|beforeSource|afterSource/);
    const bearerTrace = await fetch(`${companion.url}/v1/trace`, { method: "POST", headers: bearer, body: JSON.stringify(traceBody) }); assert.equal(bearerTrace.status, 200); assert.match(await bearerTrace.text(), /SENTINEL_BROWSER_SOURCE/);
    const source = await fetch(`${companion.url}/v1/source?repositoryId=browser-repo&path=src%2FService.php&commit=${commit}`, { headers: { "X-Trace-Protocol": PROTOCOL_VERSION, Cookie: cookie } }); assert.equal(source.status, 403);
  } finally { await companion.close(); await rm(directory, { recursive: true, force: true }); }
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
