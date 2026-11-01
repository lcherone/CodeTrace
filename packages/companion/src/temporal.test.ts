import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { PROTOCOL_VERSION, TemporalGraphComparisonResponseSchema, type GraphResponse, type Selection, type TemporalGraphComparisonRequest } from "@trace/contracts";
import { GraphService } from "./graph.js";
import { IndexCoordinator } from "./indexer.js";
import type { IndexedRelationship, IndexedSymbol, ParsedMethod } from "./model.js";
import { parsePhp } from "./php.js";
import { TraceStore } from "./store.js";
import { TemporalGraphService, TemporalRevisionError, temporalEdgeIdentity } from "./temporal.js";

const exec = promisify(execFile);

test("temporal snapshots exhaustively traverse connected relationships beyond three hops", () => {
  const store = new TraceStore(":memory:"); const graphs = new GraphService(store);
  const commitId = "a".repeat(40); const range = { startLine: 1, startColumn: 0, endLine: 1, endColumn: 10 };
  const symbols: IndexedSymbol[] = Array.from({ length: 6 }, (_, index) => {
    const classFqn = `Example\\Service${index}`; const memberName = "run";
    const data: ParsedMethod = { id: `method:${index}`, classFqn, name: memberName, visibility: "public", static: false, abstract: false, signature: "run(): void", source: "", range, implementationFingerprint: `implementation-${index}`, signatureFingerprint: "signature", documentationFingerprint: "documentation", calls: [] };
    return { id: `repo@${commitId}:method:${index}`, repositoryId: "repo", commit: commitId, generation: 0, path: `src/Service${index}.php`, kind: "method", fqn: `${classFqn}::${memberName}`, memberName, classFqn, range, data };
  });
  const relationships: IndexedRelationship[] = Array.from({ length: 5 }, (_, index) => ({ id: `call:${index}`, repositoryId: "repo", commit: commitId, generation: 0, sourceId: symbols[index]!.id, targetId: symbols[index + 1]!.id, type: "calls", confidence: "confirmed", path: symbols[index]!.path, range, detail: `Service${index} calls Service${index + 1}`, limitations: [] }));
  const snapshot = { symbols, relationships, packages: [], dependencies: [], repositoryCommits: new Map([["repo", commitId]]) };
  const selected: Selection = { repositoryPath: "/repo", relativePath: symbols[0]!.path, revision: { repositoryId: "repo", commit: commitId, dirty: false }, range, selectedText: "run" };
  try {
    const complete = graphs.traceSnapshot(selected, "callers", snapshot, 100);
    assert.equal(complete.nodes.length, 6); assert.equal(complete.edges.length, 5);
    assert.equal(complete.freshness.partial, false);
    const limited = graphs.traceSnapshot(selected, "callers", snapshot, 3);
    assert.ok(limited.nodes.length <= 3); assert.ok(limited.edges.length <= 3);
    assert.equal(limited.freshness.partial, true);
    assert.ok(limited.freshness.limitations.some((limitation) => limitation.includes("requested node or edge limit")));
  } finally { store.close(); }
});

async function initialise(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await exec("git", ["init", "-b", "main", root]);
  await exec("git", ["-C", root, "config", "user.name", "Trace Test"]);
  await exec("git", ["-C", root, "config", "user.email", "trace@example.test"]);
}

async function commit(root: string, message: string): Promise<string> {
  await exec("git", ["-C", root, "add", "--all"]);
  await exec("git", ["-C", root, "commit", "-m", message]);
  return (await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
}

const sharedV1 = `<?php
namespace Company\\Shared;
interface Prices { public function price(): int; }
class BaseOrder implements Prices { public function price(): int { return 100; } }
`;
const sharedV2 = `<?php
namespace Company\\Shared;
trait PricingMarker { public function pricingVersion(): int { return 2; } }
class BaseOrder { use PricingMarker; public function price(bool $discount = true): int { return $discount ? 90 : 100; } }
`;
const clientV1 = `<?php
namespace Client;
use Company\\Shared\\BaseOrder;
class Checkout { public function quote(BaseOrder $order): int { return $order->price(); } }
`;
const clientV2 = `<?php
namespace Client;
use Company\\Shared\\BaseOrder;
class Checkout { public function quote(BaseOrder $order): int { return $order->price(true); } }
`;

function lock(reference: string, version: string): string {
  return JSON.stringify({ packages: [{ name: "company/shared", version, source: { type: "git", url: "https://example.invalid/shared.git", reference } }], "packages-dev": [] });
}

function selection(repositoryId: string, repositoryPath: string, commitId: string, source: string): Selection {
  const method = parsePhp(source, "src/Checkout.php").types[0]?.methods.find((item) => item.name === "quote");
  assert.ok(method);
  return { repositoryPath, relativePath: "src/Checkout.php", revision: { repositoryId, commit: commitId, dirty: false }, range: method.range, selectedText: "quote" };
}

test("temporal edge identities distinguish repeated semantic relationships but keep requires revision-independent", () => {
  const revision = { repositoryId: "repo", commit: "a".repeat(40), dirty: false };
  const occurrence = { id: "method", logical: { kind: "method" as const, fullyQualifiedName: "Example\\Service", memberName: "run" }, revision, path: "src/Service.php", range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 } };
  const graph = {
    protocolVersion: PROTOCOL_VERSION, queryId: "query", mode: "origin" as const, focusNodeId: "method",
    nodes: [{ id: "method", kind: "method" as const, label: "Example\\Service::run", occurrence, metadata: {} }, { id: "value", kind: "class" as const, label: "Example\\Value", occurrence: { ...occurrence, id: "value", logical: { kind: "class" as const, fullyQualifiedName: "Example\\Value" } }, metadata: {} }, { id: "project:client", kind: "project" as const, label: "client", metadata: {} }, { id: "package:shared:company/shared:old", kind: "package-revision" as const, label: "company/shared", metadata: { resolvedSourceCommit: "a".repeat(40) } }],
    edges: [], history: [], freshness: { generation: 0, indexedAt: new Date().toISOString(), repositories: [revision], partial: false, limitations: [] },
  } satisfies GraphResponse;
  const evidence = (detail: string) => [{ repositoryId: "repo", commit: revision.commit, path: "src/Service.php", resolutionMethod: "static-analysis", confidence: "confirmed" as const, detail, limitations: [] }];
  const left = { id: "left", source: "method", target: "value", type: "parameter-type" as const, label: "Parameter type", confidence: "confirmed" as const, evidence: evidence("Example\\Service::run declares $left as Value (native)") };
  const right = { ...left, id: "right", evidence: evidence("Example\\Service::run declares $right as Value (native)") };
  assert.notEqual(temporalEdgeIdentity(left, graph), temporalEdgeIdentity(right, graph));
  const firstBinding = { ...left, id: "binding-1", target: "value", type: "late-static-binding" as const, label: "Late static binding", confidence: "possible" as const, evidence: evidence("new static follows the runtime class [occurrence 1] (line 10)") };
  const movedBinding = { ...firstBinding, evidence: evidence("new static follows the runtime class [occurrence 1] (line 20)") };
  const secondBinding = { ...firstBinding, id: "binding-2", evidence: evidence("new static follows the runtime class [occurrence 2] (line 21)") };
  assert.equal(temporalEdgeIdentity(firstBinding, graph), temporalEdgeIdentity(movedBinding, graph));
  assert.notEqual(temporalEdgeIdentity(firstBinding, graph), temporalEdgeIdentity(secondBinding, graph));
  const requires = { id: "requires-old", source: "project:client", target: "package:shared:company/shared:old", type: "requires" as const, label: "Requires", confidence: "dependency-only" as const, evidence: evidence(`Lock resolves company/shared to ${"a".repeat(40)}`) };
  const newer = { ...requires, id: "requires-new", evidence: evidence(`Lock resolves company/shared to ${"b".repeat(40)}`) };
  assert.equal(temporalEdgeIdentity(requires, graph), temporalEdgeIdentity(newer, graph));
});

test("temporal comparison reconstructs every repository from its exact declared Git basis", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "trace-temporal-"));
  const shared = path.join(temporary, "shared"); const client = path.join(temporary, "client");
  const store = new TraceStore(":memory:"); const graphs = new GraphService(store);
  const scanner = new IndexCoordinator(store, { watchFileSystem: false, discoverComposerPackages: false });
  try {
    await initialise(shared); await mkdir(path.join(shared, "src"));
    await writeFile(path.join(shared, "composer.json"), JSON.stringify({ name: "company/shared", autoload: { "psr-4": { "Company\\Shared\\": "src/" } } }));
    await writeFile(path.join(shared, "src", "BaseOrder.php"), sharedV1);
    const sharedBefore = await commit(shared, "Shared v1");
    await writeFile(path.join(shared, "src", "BaseOrder.php"), sharedV2);
    const sharedAfter = await commit(shared, "Shared v2");

    await initialise(client); await mkdir(path.join(client, "src"));
    await writeFile(path.join(client, "composer.json"), JSON.stringify({ name: "client/store", require: { "company/shared": "^1 || ^2" }, autoload: { "psr-4": { "Client\\": "src/" } } }));
    await writeFile(path.join(client, "composer.lock"), lock(sharedBefore, "1.0.0"));
    await writeFile(path.join(client, "src", "Checkout.php"), clientV1);
    const clientBefore = await commit(client, "Client v1");
    await writeFile(path.join(client, "composer.lock"), lock(sharedAfter, "2.0.0"));
    await writeFile(path.join(client, "src", "Checkout.php"), clientV2);
    const clientAfter = await commit(client, "Client v2");

    store.upsertRepository({ id: "shared", root: shared }); store.upsertRepository({ id: "client", root: client });
    assert.equal((await scanner.index({ id: "shared", root: shared })).indexedCommit, sharedAfter);
    assert.equal((await scanner.index({ id: "client", root: client })).indexedCommit, clientAfter);

    const request: TemporalGraphComparisonRequest = {
      protocolVersion: PROTOCOL_VERSION,
      mode: "impact",
      limit: 100,
      before: { revisions: { shared: sharedBefore, client: clientBefore }, selection: selection("client", client, clientBefore, clientV1) },
      after: { revisions: { shared: sharedAfter, client: clientAfter }, selection: selection("client", client, clientAfter, clientV2) },
    };
    const result = await new TemporalGraphService(store, graphs).compare(request);
    assert.equal(TemporalGraphComparisonResponseSchema.safeParse(result).success, true);
    assert.equal(result.basis.policy, "explicit-revisions-only"); assert.equal(result.basis.complete, true);
    assert.deepEqual(new Map(result.before.freshness.repositories.map((item) => [item.repositoryId, item.commit])), new Map([["client", clientBefore], ["shared", sharedBefore]]));
    assert.deepEqual(new Map(result.after.freshness.repositories.map((item) => [item.repositoryId, item.commit])), new Map([["client", clientAfter], ["shared", sharedAfter]]));
    for (const node of result.before.nodes) if (node.occurrence) assert.equal(node.occurrence.revision.commit, request.before.revisions[node.occurrence.revision.repositoryId]);
    for (const node of result.after.nodes) if (node.occurrence) assert.equal(node.occurrence.revision.commit, request.after.revisions[node.occurrence.revision.repositoryId]);
    assert.equal(result.basisChanges.length, 2);
    const changedCheckout = result.changes.nodes.changed.find((item) => item.identity === "symbol|client|method|Client\\Checkout::quote");
    assert.ok(changedCheckout?.changedFields.includes("implementation"));
    assert.equal(changedCheckout?.identity.includes(clientBefore), false);
    assert.ok(result.changes.nodes.added.some((node) => node.label === "Company\\Shared\\PricingMarker"));
    assert.ok(result.changes.nodes.removed.some((node) => node.label === "Company\\Shared\\Prices"));
    assert.ok(result.changes.edges.added.some((edge) => edge.type === "uses-trait"));
    assert.ok(result.changes.edges.removed.some((edge) => edge.type === "implements"));
    const requires = result.changes.edges.changed.find((item) => item.identity === "edge|requires|project|client|package|company/shared");
    assert.ok(requires?.changedFields.includes("resolvedSourceCommit"));
    assert.ok(requires?.changedFields.includes("evidence"));

    const expanded = graphs.expand(result.before.queryId, result.before.focusNodeId, "both");
    for (const node of expanded.nodes) if (node.occurrence) assert.equal(node.occurrence.revision.commit, request.before.revisions[node.occurrence.revision.repositoryId]);
  } finally {
    await scanner.close(); store.close(); await rm(temporary, { recursive: true, force: true });
  }
});

test("temporal comparison fails rather than substituting an unavailable revision", async () => {
  const store = new TraceStore(":memory:"); const graphs = new GraphService(store);
  const missing = "f".repeat(40);
  try {
    store.upsertRepository({ id: "missing", root: process.cwd() });
    const point = { revisions: { missing }, selection: { repositoryPath: process.cwd(), relativePath: "missing.php", revision: { repositoryId: "missing", commit: missing, dirty: false }, range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 }, selectedText: "missing" } };
    await assert.rejects(new TemporalGraphService(store, graphs).compare({ protocolVersion: PROTOCOL_VERSION, mode: "origin", limit: 10, before: point, after: point }), (error: unknown) => {
      assert.ok(error instanceof TemporalRevisionError);
      assert.equal(error.details.side, "before"); assert.equal(error.details.repositoryId, "missing"); assert.equal(error.details.requestedCommit, missing);
      return true;
    });
  } finally { store.close(); }
});
