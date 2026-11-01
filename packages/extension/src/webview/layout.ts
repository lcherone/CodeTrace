export interface LayoutNode {
  id: string;
  label?: string;
  kind?: string;
}

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
  type: string;
}

export interface LayoutPoint {
  x: number;
  y: number;
  rank: number;
}

export interface LayeredLayoutOptions {
  horizontalGap?: number;
  verticalGap?: number;
}

interface DirectedEdge {
  id: string;
  from: string;
  to: string;
}

/**
 * Produce stable top-to-bottom positions around the focused node.
 *
 * Rank zero contains the focus, negative ranks are upstream, and positive
 * ranks are downstream. The result is independent of response array order so
 * refreshes and mode switches do not turn the graph into a moving target.
 */
export function layeredGraphPositions(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  focusNodeId: string,
  options: LayeredLayoutOptions = {},
): Map<string, LayoutPoint> {
  const horizontalGap = options.horizontalGap ?? 270;
  const verticalGap = options.verticalGap ?? 176;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  if (!nodeById.has(focusNodeId)) return new Map();

  const directed = edges
    .filter((edge) => nodeById.has(edge.source) && nodeById.has(edge.target) && edge.source !== edge.target)
    .map((edge): DirectedEdge => ({ id: edge.id, from: edge.source, to: edge.target }))
    .sort(compareDirectedEdges);
  const stable = stableNodes(nodes, focusNodeId);
  const stableIndex = new Map(stable.map((node, index) => [node.id, index]));
  const components = stronglyConnectedComponents(stable.map((node) => node.id), directed);
  for (const component of components) component.sort((left, right) => stableIndex.get(left)! - stableIndex.get(right)!);
  components.sort((left, right) => stableIndex.get(left[0]!)! - stableIndex.get(right[0]!)!);
  const componentByNode = new Map<string, number>();
  components.forEach((component, index) => component.forEach((nodeId) => componentByNode.set(nodeId, index)));
  const componentEdges = new Map<string, DirectedEdge>();
  for (const edge of directed) {
    const from = componentByNode.get(edge.from)!;
    const to = componentByNode.get(edge.to)!;
    if (from === to) continue;
    const key = `${from}\0${to}`;
    if (!componentEdges.has(key)) componentEdges.set(key, { id: key, from: String(from), to: String(to) });
  }
  const condensed = [...componentEdges.values()].sort(compareDirectedEdges);
  const focusComponent = componentByNode.get(focusNodeId)!;
  const absoluteRanks = topologicalLongestPathRanks(components.length, condensed);
  const focusRank = absoluteRanks.get(focusComponent)!;
  const rankById = new Map<string, number>();
  for (let component = 0; component < components.length; component += 1) {
    const rank = absoluteRanks.get(component)! - focusRank;
    for (const nodeId of components[component]!) rankById.set(nodeId, rank);
  }

  const layers = new Map<number, string[]>();
  for (const node of stableNodes(nodes, focusNodeId)) {
    const rank = rankById.get(node.id)!;
    const layer = layers.get(rank) ?? [];
    layer.push(node.id);
    layers.set(rank, layer);
  }

  const orderById = new Map<string, number>([[focusNodeId, 0]]);
  const ranks = [...layers.keys()];
  const maxDistance = Math.max(0, ...ranks.map(Math.abs));
  for (let distance = 1; distance <= maxDistance; distance += 1) {
    orderLayer(-distance, layers, rankById, directed, orderById, nodeById);
    orderLayer(distance, layers, rankById, directed, orderById, nodeById);
  }
  orderLayer(0, layers, rankById, directed, orderById, nodeById, focusNodeId);

  const result = new Map<string, LayoutPoint>();
  for (const [rank, ids] of layers) {
    const ordered = [...ids].sort((left, right) => (orderById.get(left) ?? 0) - (orderById.get(right) ?? 0));
    if (rank === 0) {
      result.set(focusNodeId, { x: 0, y: 0, rank: 0 });
      const peers = ordered.filter((id) => id !== focusNodeId);
      peers.forEach((id, index) => {
        const step = Math.floor(index / 2) + 1;
        result.set(id, { x: (index % 2 === 0 ? -step : step) * horizontalGap, y: 0, rank: 0 });
      });
      continue;
    }
    ordered.forEach((id, index) => {
      result.set(id, {
        x: (index - (ordered.length - 1) / 2) * horizontalGap,
        y: rank * verticalGap,
        rank,
      });
    });
  }
  return result;
}

function stableNodes(nodes: readonly LayoutNode[], focusNodeId?: string): LayoutNode[] {
  return [...nodes].sort((left, right) => {
    if (left.id === focusNodeId) return -1;
    if (right.id === focusNodeId) return 1;
    return compareText(nodeKey(left), nodeKey(right));
  });
}

function nodeKey(node: LayoutNode | undefined): string {
  return `${node?.kind ?? ""}\0${node?.label ?? ""}\0${node?.id ?? ""}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDirectedEdges(left: DirectedEdge, right: DirectedEdge): number {
  return compareText(`${left.from}\0${left.to}\0${left.id}`, `${right.from}\0${right.to}\0${right.id}`);
}

function adjacency(edges: readonly DirectedEdge[], from: "from" | "to", to: "from" | "to"): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const edge of edges) {
    const neighbours = result.get(edge[from]) ?? [];
    if (!neighbours.includes(edge[to])) neighbours.push(edge[to]);
    result.set(edge[from], neighbours);
  }
  for (const neighbours of result.values()) neighbours.sort(compareText);
  return result;
}

function stronglyConnectedComponents(nodeIds: readonly string[], edges: readonly DirectedEdge[]): string[][] {
  const graph = adjacency(edges, "from", "to");
  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (nodeId: string): void => {
    indexes.set(nodeId, nextIndex);
    lowLinks.set(nodeId, nextIndex);
    nextIndex += 1;
    stack.push(nodeId);
    onStack.add(nodeId);
    for (const neighbour of graph.get(nodeId) ?? []) {
      if (!indexes.has(neighbour)) {
        visit(neighbour);
        lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId)!, lowLinks.get(neighbour)!));
      } else if (onStack.has(neighbour)) {
        lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId)!, indexes.get(neighbour)!));
      }
    }
    if (lowLinks.get(nodeId) !== indexes.get(nodeId)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== nodeId);
    components.push(component);
  };

  for (const nodeId of nodeIds) if (!indexes.has(nodeId)) visit(nodeId);
  return components;
}

function topologicalLongestPathRanks(componentCount: number, edges: readonly DirectedEdge[]): Map<number, number> {
  const outgoing = new Map<number, number[]>();
  const indegree = Array.from({ length: componentCount }, () => 0);
  for (const edge of edges) {
    const from = Number(edge.from);
    const to = Number(edge.to);
    const targets = outgoing.get(from) ?? [];
    targets.push(to);
    outgoing.set(from, targets);
    indegree[to] = (indegree[to] ?? 0) + 1;
  }
  for (const targets of outgoing.values()) targets.sort((left, right) => left - right);
  const ready = Array.from({ length: componentCount }, (_, index) => index).filter((index) => indegree[index] === 0);
  const ranks = new Map<number, number>(ready.map((component) => [component, 0]));
  let visited = 0;
  while (ready.length) {
    const component = ready.shift()!;
    visited += 1;
    const rank = ranks.get(component) ?? 0;
    for (const target of outgoing.get(component) ?? []) {
      ranks.set(target, Math.max(ranks.get(target) ?? 0, rank + 1));
      indegree[target] = (indegree[target] ?? 0) - 1;
      if (indegree[target] === 0) {
        const insertion = ready.findIndex((candidate) => candidate > target);
        if (insertion === -1) ready.push(target);
        else ready.splice(insertion, 0, target);
      }
    }
  }
  if (visited !== componentCount) throw new Error("Trace graph condensation unexpectedly contains a cycle.");
  return ranks;
}

function orderLayer(
  rank: number,
  layers: ReadonlyMap<number, readonly string[]>,
  rankById: ReadonlyMap<string, number>,
  edges: readonly DirectedEdge[],
  orderById: Map<string, number>,
  nodeById: ReadonlyMap<string, LayoutNode>,
  focusNodeId?: string,
): void {
  const ids = layers.get(rank);
  if (!ids) return;
  const anchorRank = rank < 0 ? rank + 1 : rank > 0 ? rank - 1 : 0;
  const score = (id: string): number | undefined => {
    const anchors = edges.flatMap((edge) => edge.from === id ? [edge.to] : edge.to === id ? [edge.from] : [])
      .filter((other) => rankById.get(other) === anchorRank)
      .map((other) => orderById.get(other))
      .filter((value): value is number => value !== undefined);
    return anchors.length ? anchors.reduce((sum, value) => sum + value, 0) / anchors.length : undefined;
  };
  const ordered = [...ids].sort((left, right) => {
    if (left === focusNodeId) return -1;
    if (right === focusNodeId) return 1;
    const leftScore = score(left);
    const rightScore = score(right);
    if (leftScore !== undefined || rightScore !== undefined) {
      if (leftScore === undefined) return 1;
      if (rightScore === undefined) return -1;
      if (leftScore !== rightScore) return leftScore - rightScore;
    }
    return compareText(nodeKey(nodeById.get(left)), nodeKey(nodeById.get(right)));
  });
  ordered.forEach((id, index) => orderById.set(id, index));
}
