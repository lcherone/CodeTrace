import assert from "node:assert/strict";
import test from "node:test";
import { layeredGraphPositions } from "./layout.js";

test("layered graph positions preserve stable top-to-bottom call flow", () => {
  const nodes = [{ id: "caller", label: "Caller", kind: "method" }, { id: "focus", label: "Focus", kind: "method" }, { id: "target", label: "Target", kind: "method" }, { id: "release", label: "Release", kind: "release" }];
  const edges = [{ id: "calls-in", source: "caller", target: "focus", type: "calls" }, { id: "calls-out", source: "focus", target: "target", type: "calls" }, { id: "included", source: "target", target: "release", type: "included-in-release" }];
  const positions = layeredGraphPositions(nodes, edges, "focus");
  assert.ok(positions.get("caller")!.y < positions.get("focus")!.y);
  assert.ok(positions.get("target")!.y > positions.get("focus")!.y);
  assert.ok(positions.get("release")!.y > positions.get("target")!.y);
  assert.deepEqual(layeredGraphPositions([...nodes].reverse(), [...edges].reverse(), "focus"), positions);
});

test("cycles share a stable layer instead of producing contradictory direction", () => {
  const nodes = [{ id: "focus", label: "Focus" }, { id: "a", label: "A" }, { id: "b", label: "B" }];
  const edges = [{ id: "one", source: "focus", target: "a", type: "calls" }, { id: "two", source: "a", target: "b", type: "calls" }, { id: "three", source: "b", target: "a", type: "calls" }];
  const positions = layeredGraphPositions(nodes, edges, "focus");
  assert.equal(positions.get("a")!.rank, positions.get("b")!.rank);
  assert.ok(positions.get("a")!.rank > positions.get("focus")!.rank);
});
