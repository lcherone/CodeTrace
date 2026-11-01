import assert from "node:assert/strict";
import test from "node:test";
import { BrowserLaunchResponseSchema, ChangeInclusionResponseSchema, CodeLensCountsRequestSchema, CodeLensCountsResponseSchema, ComposerDependencySchema, EditorContextResponseSchema, EditorContextUpdateRequestSchema, GitHubAssociationsSchema, GraphResponseSchema, HistoryEventSchema, PROTOCOL_VERSION, SelectionSchema, TemporalGraphComparisonRequestSchema } from "./index.js";

test("selection requires revision-qualified repository context", () => {
  const result = SelectionSchema.safeParse({
    repositoryPath: "/repo",
    relativePath: "src/Order.php",
    revision: { repositoryId: "client", commit: "abc123", dirty: false },
    range: { startLine: 5, startColumn: 0, endLine: 5, endColumn: 10 },
    selectedText: "calculateTotal",
  });
  assert.equal(result.success, true);
});

test("browser launch and live editor context remain revision and generation qualified", () => {
  const selection = { repositoryPath: "/repo", relativePath: "src/Order.php", revision: { repositoryId: "client", commit: "a".repeat(40), dirty: false }, range: { startLine: 5, startColumn: 0, endLine: 5, endColumn: 10 } };
  assert.equal(EditorContextUpdateRequestSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, clientId: "vscode-window-1", context: { selection, mode: "impact" } }).success, true);
  assert.equal(EditorContextUpdateRequestSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, clientId: "vscode-window-1", context: { selection: { ...selection, symbolHint: "Soho\\Pos\\Model\\OrderTrait" }, mode: "impact" } }).success, true);
  assert.equal(EditorContextUpdateRequestSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, clientId: "vscode-window-1", context: { selection: { ...selection, symbolHint: "return $secret;" }, mode: "impact" } }).success, false);
  assert.equal(EditorContextUpdateRequestSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, clientId: "vscode-window-1", context: { selection: { ...selection, selectedText: "secret", documentText: "<?php echo $secret;", documentVersion: 2 }, mode: "impact" } }).success, false);
  assert.equal(EditorContextResponseSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, version: 4, context: { clientId: "vscode-window-1", selection, mode: "impact", generation: 7, receivedAt: new Date().toISOString() } }).success, true);
  assert.equal(BrowserLaunchResponseSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, url: "http://127.0.0.1:47173/?ticket=opaque", expiresAt: new Date().toISOString() }).success, true);
});

test("graph rejects edges without evidence", () => {
  const result = GraphResponseSchema.safeParse({
    protocolVersion: PROTOCOL_VERSION,
    queryId: "q1",
    mode: "origin",
    focusNodeId: "m1",
    nodes: [],
    edges: [{ id: "e1", source: "m1", target: "m2", type: "calls", label: "Calls", confidence: "confirmed", evidence: [] }],
    history: [],
    freshness: { generation: 1, indexedAt: new Date().toISOString(), repositories: [], partial: false, limitations: [] },
  });
  assert.equal(result.success, false);
});

test("CodeLens counts are revision-qualified, bounded, and distinguish callers from consumers", () => {
  const item = { id: "lens-1", path: "src/Order.php", range: { startLine: 5, startColumn: 0, endLine: 5, endColumn: 10 }, symbol: "App\\Order::total" };
  assert.equal(CodeLensCountsRequestSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, repository: { repositoryId: "app", commit: "a".repeat(40) }, items: [item] }).success, true);
  assert.equal(CodeLensCountsRequestSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, repository: { repositoryId: "app", commit: "a".repeat(40) }, items: Array.from({ length: 201 }, (_, index) => ({ ...item, id: `lens-${index}` })) }).success, false);
  assert.equal(CodeLensCountsRequestSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, repository: { repositoryId: "app", commit: "a".repeat(40) }, items: [{ ...item, path: "../Order.php" }] }).success, false);
  assert.equal(CodeLensCountsResponseSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, repository: { repositoryId: "app", commit: "a".repeat(40) }, generation: 7, counts: [{ id: "lens-1", symbolId: "method:total", callers: 3, consumers: 2, partial: false, limitations: [] }], cache: { hits: 0, misses: 1, rebuilt: true } }).success, true);
});

test("history accepts Git strict ISO dates with explicit offsets", () => {
  const result = HistoryEventSchema.safeParse({
    id: "event-1",
    symbolId: "symbol-1",
    commit: "abc123",
    category: "implementation",
    summary: "Change implementation",
    authorName: "Trace Fixture",
    authorEmail: "trace@example.test",
    authoredAt: "2024-01-20T12:00:00+00:00",
    limitations: [],
  });
  assert.equal(result.success, true);
});

test("temporal comparison requires explicit matching full commit bases", () => {
  const commit = "a".repeat(40);
  const selection = {
    repositoryPath: "/repo",
    relativePath: "src/Order.php",
    revision: { repositoryId: "client", commit, dirty: false },
    range: { startLine: 5, startColumn: 0, endLine: 5, endColumn: 10 },
    selectedText: "calculateTotal",
  };
  assert.equal(TemporalGraphComparisonRequestSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, mode: "impact", before: { revisions: { client: commit }, selection }, after: { revisions: { client: commit }, selection } }).success, true);
  assert.equal(TemporalGraphComparisonRequestSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, mode: "impact", before: { revisions: { client: "b".repeat(40) }, selection }, after: { revisions: { client: commit }, selection } }).success, false);
  assert.equal(TemporalGraphComparisonRequestSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, mode: "impact", before: { revisions: { client: commit }, selection: { ...selection, documentText: "<?php", revision: { ...selection.revision, dirty: true } } }, after: { revisions: { client: commit }, selection } }).success, false);
});

test("lineage and revert-aware inclusion preserve separate evidence states", () => {
  const commit = "a".repeat(40); const next = "b".repeat(40);
  const evidence = { repositoryId: "repo", commit: next, path: "src/New.php", resolutionMethod: "syntax-fingerprint-and-git-change", confidence: "possible", detail: "Unique structural continuity", limitations: ["Intent is not proven"] };
  assert.equal(HistoryEventSchema.safeParse({ id: "rename", symbolId: "symbol", commit: next, category: "rename", summary: "Rename method", authorName: "Trace", authorEmail: "trace@example.test", authoredAt: "2024-01-01T00:00:00Z", lineage: { fromPath: "src/Old.php", toPath: "src/New.php", fromSymbol: "Old::price", toSymbol: "New::price", confidence: "possible", evidence: [evidence], limitations: [] }, limitations: [] }).success, true);
  assert.equal(ChangeInclusionResponseSchema.safeParse({ protocolVersion: PROTOCOL_VERSION, symbolId: "symbol", commit, releases: ["v1"], releaseAssessments: [{ release: "v1", revision: next, state: "contains-original", activeBehaviour: "reverted", basisCommit: next, revertCommit: next, lastMatchingCommit: next, evidence: [evidence], limitations: [] }], consumers: [{ consumerRepositoryId: "client", packageName: "company/package", selectedChangeCommit: commit, state: "likely-equivalent", activeBehaviour: "likely-active", basisCommit: next, equivalentCommit: next, lastMatchingCommit: next, reason: "Equivalent patch is active", evidence: [evidence], limitations: ["Bounded"] }], limitations: [] }).success, true);
});

test("Composer and GitHub association contracts preserve independent identity evidence", () => {
  const dependency = ComposerDependencySchema.parse({ repositoryId: "consumer", generation: 1, packageName: "acme/shared", development: false, direct: true, declaredConstraint: "dev-main as 2.x-dev", declaredConstraintBase: "dev-main", declaredAlias: "2.x-dev", resolvedVersion: "dev-main", resolvedSourceReference: "dev-main", resolvedSourceUrl: "git@github.com:Acme/Shared.git", normalizedSourceUrl: "github.com/acme/shared", resolvedDistReference: "archive-ref", indexedRepositoryId: "shared", indexedRevision: "a".repeat(40), resolution: "unavailable" });
  assert.equal(dependency.resolvedSourceCommit, undefined); assert.equal(dependency.resolutionMethod, "unresolved"); assert.deepEqual(dependency.resolutionEvidence, []);
  const evidence = { repositoryId: "shared", commit: "a".repeat(40), resolutionMethod: "github-exact-tag-release-api", confidence: "confirmed" as const, detail: "Exact release", limitations: [] };
  assert.equal(GitHubAssociationsSchema.safeParse({ pullRequests: [], releases: [{ repository: "acme/shared", repositoryUrl: "https://github.com/acme/shared", tagName: "v1", tagCommit: "a".repeat(40), url: "https://github.com/acme/shared/releases/tag/v1", draft: false, prerelease: true, targetCommitish: "main", confidence: "confirmed", evidence: [evidence], limitations: [] }], limitations: [] }).success, true);
});
