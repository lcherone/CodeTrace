import type { GraphResponse, TemporalGraphComparisonResponse } from "@trace/contracts";
import type { ExtensionOutboundMessage } from "./messages";

export type TransientPanelMessage = Extract<ExtensionOutboundMessage, { type: "loading" | "error" }>;

export function initialPanelMessages(
  graph: GraphResponse | undefined,
  comparison: TemporalGraphComparisonResponse | undefined,
  transient: TransientPanelMessage | undefined,
): ExtensionOutboundMessage[] {
  const messages: ExtensionOutboundMessage[] = [];
  if (graph) messages.push({ type: "graph", graph });
  else if (transient) messages.push(transient);
  if (comparison) messages.push({ type: "comparison", result: comparison });
  return messages;
}
