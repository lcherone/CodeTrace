import assert from "node:assert/strict";
import test from "node:test";
import { initialPanelMessages } from "./panelMessages";

test("replays loading and errors when a first graph has not loaded", () => {
  assert.deepEqual(initialPanelMessages(undefined, undefined, { type: "loading", message: "Tracing…" }), [
    { type: "loading", message: "Tracing…" },
  ]);
  assert.deepEqual(initialPanelMessages(undefined, undefined, { type: "error", message: "Trace failed", detail: "Timed out" }), [
    { type: "error", message: "Trace failed", detail: "Timed out" },
  ]);
});

test("a loaded graph takes precedence over a stale transient state", () => {
  const graph = { mode: "impact" } as Parameters<typeof initialPanelMessages>[0];
  assert.deepEqual(initialPanelMessages(graph, undefined, { type: "loading", message: "Tracing…" }), [
    { type: "graph", graph },
  ]);
});

test("replays the retained graph and comparison when a closed panel is recreated", () => {
  const graph = { mode: "history" } as Parameters<typeof initialPanelMessages>[0];
  const comparison = { protocolVersion: "1.0" } as Parameters<typeof initialPanelMessages>[1];
  assert.deepEqual(initialPanelMessages(graph, comparison, undefined), [
    { type: "graph", graph },
    { type: "comparison", result: comparison },
  ]);
});
