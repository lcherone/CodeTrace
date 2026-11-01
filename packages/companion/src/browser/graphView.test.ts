import assert from "node:assert/strict";
import test from "node:test";
import type { GraphEdge, GraphNode, GraphResponse } from "@trace/contracts";
import { graphView } from "./graphView.js";

const node = (id: string, label = id): GraphNode => ({ id, kind: "method", label, metadata: {} });
const edge = (id: string, source: string, target: string, type: GraphEdge["type"] = "calls", confidence: GraphEdge["confidence"] = "confirmed"): GraphEdge => ({ id, source, target, type, label: type, confidence, evidence: [{ repositoryId: "repo", commit: "a".repeat(40), resolutionMethod: "test", confidence, detail: id, limitations: [] }] });
const graph = (nodes: GraphNode[], edges: GraphEdge[]): GraphResponse => ({ protocolVersion: "1.0", queryId: "q", mode: "impact", focusNodeId: "focus", nodes, edges, history: [], freshness: { generation: 1, indexedAt: new Date().toISOString(), repositories: [], partial: false, limitations: [] } });

test("progressive graph view defaults to high-priority focused relationships and reports hidden work", () => {
  const nodes = [node("focus"), node("parent"), ...Array.from({ length: 20 }, (_, index) => node(`dependency-${index}`))];
  const edges = [edge("override", "focus", "parent", "overrides"), ...Array.from({ length: 20 }, (_, index) => edge(`requires-${index}`, "focus", `dependency-${index}`, "requires", "dependency-only"))];
  const view = graphView(graph(nodes, edges), "focused", 10);
  assert.equal(view.nodes.length, 10);
  assert.ok(view.nodes.some((item) => item.id === "focus"));
  assert.ok(view.nodes.some((item) => item.id === "parent"));
  assert.equal(view.edges.some((item) => item.id === "override"), true);
  assert.equal(view.hiddenNodeCount, 12);
  assert.ok(view.hiddenEdgeCount > 0);
});

test("depth and pinned selection reveal connected context deterministically", () => {
  const value = graph([node("focus"), node("one"), node("two"), node("three")], [edge("e1", "focus", "one"), edge("e2", "one", "two"), edge("e3", "two", "three")]);
  assert.deepEqual(graphView(value, "focused", 10).nodes.map((item) => item.id), ["focus", "one"]);
  assert.deepEqual(graphView(value, "neighbours", 10).nodes.map((item) => item.id), ["focus", "one", "two"]);
  const pinned = graphView(value, "focused", 2, "e3");
  assert.ok(pinned.nodes.some((item) => item.id === "two")); assert.ok(pinned.nodes.some((item) => item.id === "three"));
});

test("class focused view presents lineage and package consumers before declared methods", () => {
  const focus: GraphNode = { id: "focus", kind: "class", label: "App\\Customer", metadata: {} };
  const parent: GraphNode = { id: "parent", kind: "class", label: "Package\\Customer", metadata: { storyRole: "parent" } };
  const pkg: GraphNode = { id: "package", kind: "package-revision", label: "vendor/package", metadata: { storyRole: "parent-package" } };
  const project: GraphNode = { id: "project", kind: "project", label: "consumer", metadata: { storyRole: "consumer-project" } };
  const method = node("method", "App\\Customer::save");
  const value = graph([focus, parent, pkg, project, method], [
    edge("parent-edge", "focus", "parent", "extends", "unresolved"),
    edge("package-edge", "package", "parent", "declares", "unresolved"),
    edge("consumer-edge", "project", "package", "requires", "dependency-only"),
    edge("method-edge", "focus", "method", "declares"),
  ]);
  const view = graphView(value, "focused", 10);
  assert.deepEqual(view.nodes.map((item) => item.id), ["focus", "parent", "package", "project"]);
  assert.equal(view.edges.some((item) => item.id === "method-edge"), false);
  assert.equal(graphView(value, "neighbours", 10).nodes.some((item) => item.id === "method"), true);
});
