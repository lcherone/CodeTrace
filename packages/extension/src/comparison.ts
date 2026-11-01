import {
  TemporalGraphComparisonRequestSchema,
  PROTOCOL_VERSION,
  type GraphNode,
  type GraphResponse,
  type RepositoryRevisionMap,
  type Selection,
  type TemporalGraphComparisonRequest,
  type TemporalGraphComparisonResponse,
  type TraceMode,
} from "@trace/contracts";

export const comparisonStates = ["added", "removed", "changed", "unchanged"] as const;
export type ComparisonState = typeof comparisonStates[number];

export interface ComparisonView {
  graph: GraphResponse;
  nodeStates: Map<string, ComparisonState>;
  edgeStates: Map<string, ComparisonState>;
  changedFields: Map<string, string[]>;
  counts: Record<ComparisonState, number>;
}

export function buildTemporalComparisonRequest(
  selection: Selection,
  mode: TraceMode,
  beforeRevisions: RepositoryRevisionMap,
  afterRevisions: RepositoryRevisionMap,
  limit: number,
): TemporalGraphComparisonRequest {
  const committedSelection = (revisions: RepositoryRevisionMap): Selection => {
    const commit = revisions[selection.revision.repositoryId];
    const { documentText: _documentText, documentVersion: _documentVersion, ...committed } = selection;
    return {
      ...committed,
      revision: { ...selection.revision, commit: commit ?? "", dirty: false },
    };
  };
  return TemporalGraphComparisonRequestSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    mode,
    limit,
    before: { revisions: beforeRevisions, selection: committedSelection(beforeRevisions) },
    after: { revisions: afterRevisions, selection: committedSelection(afterRevisions) },
  });
}

export function comparisonView(result: TemporalGraphComparisonResponse, state: ComparisonState): ComparisonView {
  const addedNodeIds = new Set(result.changes.nodes.added.map((node) => node.id));
  const removedNodeIds = new Set(result.changes.nodes.removed.map((node) => node.id));
  const changedAfterNodeIds = new Set(result.changes.nodes.changed.map((change) => change.after.id));
  const changedBeforeNodeIds = new Set(result.changes.nodes.changed.map((change) => change.before.id));
  const addedEdgeIds = new Set(result.changes.edges.added.map((edge) => edge.id));
  const changedAfterEdgeIds = new Set(result.changes.edges.changed.map((change) => change.after.id));
  const source = state === "removed" ? result.before : result.after;
  const selectedEdges = state === "added"
    ? result.changes.edges.added
    : state === "removed"
      ? result.changes.edges.removed
      : state === "changed"
        ? result.changes.edges.changed.map((change) => change.after)
        : source.edges.filter((edge) => !addedEdgeIds.has(edge.id) && !changedAfterEdgeIds.has(edge.id));
  const explicitNodes = state === "added"
    ? result.changes.nodes.added
    : state === "removed"
      ? result.changes.nodes.removed
      : state === "changed"
        ? result.changes.nodes.changed.map((change) => change.after)
        : source.nodes.filter((node) => !addedNodeIds.has(node.id) && !changedAfterNodeIds.has(node.id));
  const requiredNodeIds = new Set(selectedEdges.flatMap((edge) => [edge.source, edge.target]));
  explicitNodes.forEach((node) => requiredNodeIds.add(node.id));
  if (source.nodes.some((node) => node.id === source.focusNodeId)) requiredNodeIds.add(source.focusNodeId);
  const selectedNodes = source.nodes.filter((node) => requiredNodeIds.has(node.id));
  const focusNodeId = selectedNodes.some((node) => node.id === source.focusNodeId) ? source.focusNodeId : selectedNodes[0]?.id ?? source.focusNodeId;
  const nodeStates = new Map<string, ComparisonState>();
  const edgeStates = new Map<string, ComparisonState>();
  const changedFields = new Map<string, string[]>();
  for (const node of selectedNodes) nodeStates.set(node.id, nodeState(node, addedNodeIds, removedNodeIds, changedAfterNodeIds, changedBeforeNodeIds));
  for (const edge of selectedEdges) edgeStates.set(edge.id, state);
  for (const change of result.changes.nodes.changed) changedFields.set(change.after.id, change.changedFields);
  for (const change of result.changes.edges.changed) changedFields.set(change.after.id, change.changedFields);
  const counts = {
    added: result.changes.edges.added.length,
    removed: result.changes.edges.removed.length,
    changed: result.changes.edges.changed.length,
    unchanged: result.after.edges.filter((edge) => !addedEdgeIds.has(edge.id) && !changedAfterEdgeIds.has(edge.id)).length,
  };
  return {
    graph: {
      ...source,
      queryId: `comparison:${result.before.queryId}:${result.after.queryId}:${state}`,
      focusNodeId,
      nodes: selectedNodes,
      edges: selectedEdges,
    },
    nodeStates,
    edgeStates,
    changedFields,
    counts,
  };
}

export function defaultComparisonState(result: TemporalGraphComparisonResponse): ComparisonState {
  if (result.changes.edges.changed.length || result.changes.nodes.changed.length) return "changed";
  if (result.changes.edges.added.length || result.changes.nodes.added.length) return "added";
  if (result.changes.edges.removed.length || result.changes.nodes.removed.length) return "removed";
  return "unchanged";
}

function nodeState(
  node: GraphNode,
  added: ReadonlySet<string>,
  removed: ReadonlySet<string>,
  changedAfter: ReadonlySet<string>,
  changedBefore: ReadonlySet<string>,
): ComparisonState {
  if (added.has(node.id)) return "added";
  if (removed.has(node.id)) return "removed";
  if (changedAfter.has(node.id) || changedBefore.has(node.id)) return "changed";
  return "unchanged";
}

