import assert from "node:assert/strict";
import test from "node:test";
import type { GraphEdge, GraphNode, GraphResponse, Selection, TemporalGraphComparisonResponse } from "@trace/contracts";
import { buildTemporalComparisonRequest, comparisonView, defaultComparisonState } from "./comparison";

const beforeCommit = "a".repeat(40);
const afterCommit = "b".repeat(40);
const range = { startLine: 1, startColumn: 0, endLine: 1, endColumn: 8 };
const evidence = [{ repositoryId: "client", commit: afterCommit, resolutionMethod: "test", confidence: "confirmed" as const, detail: "test evidence", limitations: [] }];
const node = (id: string): GraphNode => ({ id, kind: "method", label: id, metadata: {} });
const edge = (id: string, source: string, target: string): GraphEdge => ({ id, source, target, type: "calls", label: "Calls", confidence: "confirmed", evidence });

function graph(queryId: string, commit: string, nodes: GraphNode[], edges: GraphEdge[]): GraphResponse {
  return {
    protocolVersion: "1.0",
    queryId,
    mode: "impact",
    focusNodeId: "focus",
    nodes,
    edges,
    history: [],
    freshness: { generation: 1, indexedAt: "2026-01-01T00:00:00.000Z", repositories: [{ repositoryId: "client", commit, dirty: false }], partial: false, limitations: [] },
  };
}

test("builds explicit committed comparison points and removes the working overlay", () => {
  const selection: Selection = {
    repositoryPath: "/work/client",
    relativePath: "src/Order.php",
    revision: { repositoryId: "client", commit: afterCommit, dirty: true },
    range,
    selectedText: "total",
    documentText: "<?php unsaved",
    documentVersion: 7,
  };
  const request = buildTemporalComparisonRequest(selection, "impact", { client: beforeCommit }, { client: afterCommit }, 80);

  assert.equal(request.before.selection.revision.commit, beforeCommit);
  assert.equal(request.after.selection.revision.commit, afterCommit);
  assert.equal(request.before.selection.revision.dirty, false);
  assert.equal(request.before.selection.documentText, undefined);
  assert.equal(request.after.selection.documentVersion, undefined);
  assert.throws(() => buildTemporalComparisonRequest(selection, "impact", { other: beforeCommit }, { other: afterCommit }, 80));
});

test("keeps added, removed, changed and unchanged relationships in separate views", () => {
  const focus = node("focus");
  const stable = node("stable");
  const added = node("added");
  const removed = node("removed");
  const changedBefore = edge("changed-before", "focus", "stable");
  const changedAfter = edge("changed-after", "focus", "stable");
  const unchanged = edge("unchanged", "stable", "focus");
  const addedEdge = edge("added-edge", "focus", "added");
  const removedEdge = edge("removed-edge", "removed", "focus");
  const before = graph("before", beforeCommit, [focus, stable, removed], [unchanged, changedBefore, removedEdge]);
  const after = graph("after", afterCommit, [focus, stable, added], [unchanged, changedAfter, addedEdge]);
  const result: TemporalGraphComparisonResponse = {
    protocolVersion: "1.0",
    basis: {
      policy: "explicit-revisions-only",
      complete: true,
      before: [{ repositoryId: "client", requestedCommit: beforeCommit, resolvedCommit: beforeCommit, status: "resolved" }],
      after: [{ repositoryId: "client", requestedCommit: afterCommit, resolvedCommit: afterCommit, status: "resolved" }],
    },
    before,
    after,
    basisChanges: [{ repositoryId: "client", kind: "changed", beforeCommit, afterCommit }],
    changes: {
      nodes: { added: [added], removed: [removed], changed: [] },
      edges: { added: [addedEdge], removed: [removedEdge], changed: [{ identity: "logical-change", before: changedBefore, after: changedAfter, changedFields: ["confidence"] }] },
    },
  };

  assert.equal(defaultComparisonState(result), "changed");
  assert.deepEqual(comparisonView(result, "added").graph.edges.map((item) => item.id), ["added-edge"]);
  assert.deepEqual(comparisonView(result, "removed").graph.edges.map((item) => item.id), ["removed-edge"]);
  assert.deepEqual(comparisonView(result, "changed").graph.edges.map((item) => item.id), ["changed-after"]);
  assert.deepEqual(comparisonView(result, "unchanged").graph.edges.map((item) => item.id), ["unchanged"]);
  assert.deepEqual(comparisonView(result, "changed").changedFields.get("changed-after"), ["confidence"]);
  assert.deepEqual(comparisonView(result, "added").counts, { added: 1, removed: 1, changed: 1, unchanged: 1 });
});
