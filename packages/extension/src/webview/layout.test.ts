import assert from "node:assert/strict";
import test from "node:test";
import { layeredGraphPositions, type LayoutEdge, type LayoutNode } from "./layout";

const nodes = (...ids: string[]): LayoutNode[] => ids.map((id) => ({ id, label: id }));
const edge = (id: string, source: string, target: string, type: string): LayoutEdge => ({ id, source, target, type });

test("centres the focus with every raw source above its target", () => {
  const positions = layeredGraphPositions(
    nodes("focus", "caller", "callee", "parent", "contract", "override"),
    [
      edge("caller", "caller", "focus", "calls"),
      edge("callee", "focus", "callee", "calls"),
      edge("parent", "parent", "focus", "overrides"),
      edge("contract", "contract", "focus", "implements-method"),
      edge("override", "focus", "override", "overrides"),
    ],
    "focus",
  );

  assert.deepEqual(positions.get("focus"), { x: 0, y: 0, rank: 0 });
  assert.equal(positions.get("caller")!.rank, -1);
  assert.equal(positions.get("parent")!.rank, -1);
  assert.equal(positions.get("contract")!.rank, -1);
  assert.equal(positions.get("callee")!.rank, 1);
  assert.equal(positions.get("override")!.rank, 1);
});

test("lays out multi-hop directed relationships in top-to-bottom ranks", () => {
  const positions = layeredGraphPositions(
    nodes("package", "class", "focus", "call", "commit", "release"),
    [
      edge("declares-class", "package", "class", "declares"),
      edge("declares-focus", "class", "focus", "declares"),
      edge("calls", "focus", "call", "calls"),
      edge("changed", "call", "commit", "changed-in"),
      edge("released", "commit", "release", "included-in-release"),
    ],
    "focus",
  );

  assert.deepEqual(
    ["package", "class", "focus", "call", "commit", "release"].map((id) => positions.get(id)!.rank),
    [-2, -1, 0, 1, 2, 3],
  );
});

test("is deterministic across response ordering and separates siblings", () => {
  const graphNodes = nodes("focus", "alpha", "beta", "gamma", "orphan");
  const graphEdges = [
    edge("b", "focus", "beta", "calls"),
    edge("a", "focus", "alpha", "calls"),
    edge("g", "focus", "gamma", "calls"),
  ];
  const first = layeredGraphPositions(graphNodes, graphEdges, "focus");
  const second = layeredGraphPositions([...graphNodes].reverse(), [...graphEdges].reverse(), "focus");

  assert.deepEqual([...first], [...second]);
  assert.equal(new Set([first.get("alpha")!.x, first.get("beta")!.x, first.get("gamma")!.x]).size, 3);
  assert.notDeepEqual(first.get("orphan"), first.get("alpha"));
});

test("keeps cyclic graphs finite and assigns every node once", () => {
  const positions = layeredGraphPositions(
    nodes("focus", "one", "two"),
    [edge("one", "focus", "one", "calls"), edge("two", "one", "two", "calls"), edge("cycle", "two", "focus", "calls")],
    "focus",
  );

  assert.equal(positions.size, 3);
  assert.equal(positions.get("focus")!.rank, positions.get("one")!.rank);
  assert.equal(positions.get("one")!.rank, positions.get("two")!.rank);
  for (const position of positions.values()) {
    assert.equal(Number.isFinite(position.x), true);
    assert.equal(Number.isFinite(position.y), true);
  }
});

test("keeps every shortcut and diamond edge strictly top-to-bottom outside cycles", () => {
  const graphEdges = [
    edge("shortcut", "source", "focus", "calls"),
    edge("left-in", "source", "left", "calls"),
    edge("left-out", "left", "focus", "calls"),
    edge("right-in", "source", "right", "calls"),
    edge("right-out", "right", "focus", "calls"),
    edge("downstream", "focus", "sink", "calls"),
  ];
  const positions = layeredGraphPositions(nodes("focus", "source", "left", "right", "sink"), graphEdges, "focus");

  assert.equal(positions.get("focus")!.rank, 0);
  for (const relationship of graphEdges) {
    assert.ok(
      positions.get(relationship.source)!.rank < positions.get(relationship.target)!.rank,
      `${relationship.id} must flow down: ${positions.get(relationship.source)!.rank} < ${positions.get(relationship.target)!.rank}`,
    );
  }
});
