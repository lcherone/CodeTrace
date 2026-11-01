import type { GraphEdge, GraphNode, GraphResponse } from "@trace/contracts";

export type GraphDepth = "focused" | "neighbours" | "all";

export interface GraphView {
  nodes: GraphNode[];
  edges: GraphEdge[];
  hiddenNodeCount: number;
  hiddenEdgeCount: number;
}

const relationshipPriority: Record<string, number> = {
  overrides: 0,
  "calls-parent": 0,
  calls: 3,
  extends: 1,
  inherits: 1,
  implements: 1,
  "implements-method": 1,
  "uses-trait": 1,
  "parameter-type": 2,
  "return-type": 2,
  "late-static-binding": 2,
  declares: 4,
  "changed-in": 4,
  "included-in-release": 4,
  requires: 5,
};

const confidencePriority: Record<string, number> = {
  confirmed: 0,
  possible: 1,
  "dependency-only": 2,
  unresolved: 3,
};

export function graphView(
  graph: GraphResponse,
  depth: GraphDepth,
  nodeLimit: number,
  pinnedId?: string,
): GraphView {
  if (!graph.nodes.length) return { nodes: [], edges: [], hiddenNodeCount: 0, hiddenEdgeCount: 0 };

  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) continue;
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge]);
    adjacency.set(edge.target, [...(adjacency.get(edge.target) ?? []), edge]);
  }

  const maxDepth = depth === "focused" ? 1 : depth === "neighbours" ? 2 : Number.POSITIVE_INFINITY;
  const distance = new Map<string, number>([[graph.focusNodeId, 0]]);
  const queue = [graph.focusNodeId];
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index]!;
    const nextDistance = (distance.get(nodeId) ?? 0) + 1;
    if (nextDistance > maxDepth) continue;
    for (const edge of adjacency.get(nodeId) ?? []) {
      const otherId = edge.source === nodeId ? edge.target : edge.source;
      if (distance.has(otherId)) continue;
      distance.set(otherId, nextDistance);
      queue.push(otherId);
    }
  }

  const candidateIds = new Set(distance.keys());
  const pinnedEdge = graph.edges.find((edge) => edge.id === pinnedId);
  if (pinnedEdge) {
    candidateIds.add(pinnedEdge.source);
    candidateIds.add(pinnedEdge.target);
  } else if (pinnedId && nodesById.has(pinnedId)) {
    candidateIds.add(pinnedId);
  }

  const edgeScore = (edge: GraphEdge): number =>
    (relationshipPriority[edge.type] ?? 3) * 10 + (confidencePriority[edge.confidence] ?? 3);
  const nodeScore = (nodeId: string): number => {
    if (nodeId === graph.focusNodeId) return -1;
    if (nodeId === pinnedId || pinnedEdge?.source === nodeId || pinnedEdge?.target === nodeId) return 0;
    const nearestEdge = Math.min(...(adjacency.get(nodeId) ?? []).map(edgeScore), 99);
    return (distance.get(nodeId) ?? 999) * 100 + nearestEdge;
  };

  const orderedIds = [...candidateIds].sort((left, right) =>
    nodeScore(left) - nodeScore(right) || (nodesById.get(left)?.label ?? left).localeCompare(nodesById.get(right)?.label ?? right),
  );
  const safeLimit = Number.isFinite(nodeLimit) ? Math.max(1, nodeLimit) : orderedIds.length;
  const visibleIds = new Set(orderedIds.slice(0, safeLimit));
  visibleIds.add(graph.focusNodeId);
  if (pinnedEdge) {
    visibleIds.add(pinnedEdge.source);
    visibleIds.add(pinnedEdge.target);
  } else if (pinnedId && nodesById.has(pinnedId)) {
    visibleIds.add(pinnedId);
  }

  const nodes = graph.nodes.filter((node) => visibleIds.has(node.id));
  const edges = graph.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target) && candidateIds.has(edge.source) && candidateIds.has(edge.target));
  return {
    nodes,
    edges,
    hiddenNodeCount: Math.max(0, graph.nodes.length - nodes.length),
    hiddenEdgeCount: Math.max(0, graph.edges.length - edges.length),
  };
}

export function relationshipRank(type: string): number {
  return relationshipPriority[type] ?? 3;
}
