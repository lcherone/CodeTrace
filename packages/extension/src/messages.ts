import { ChangeInclusionResponseSchema, GraphResponseSchema, RepositoryRevisionMapSchema, TemporalGraphComparisonResponseSchema } from "@trace/contracts";
import { z } from "zod";
import { isAllowedGitHubUrl } from "./externalLinks";

export const ModeSchema = z.enum(["origin", "inheritance", "callers", "consumers", "impact", "history"]);
export type TraceMode = z.infer<typeof ModeSchema>;

export const WebviewInboundMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("changeMode"), mode: ModeSchema }),
  z.object({ type: z.literal("openSource"), nodeId: z.string().min(1) }),
  z.object({ type: z.literal("openEvidence"), edgeId: z.string().min(1), evidenceIndex: z.number().int().nonnegative() }),
  z.object({ type: z.literal("openHistory"), eventId: z.string().min(1), side: z.enum(["before", "after", "diff"]) }),
  z.object({ type: z.literal("checkInclusion"), eventId: z.string().min(1) }),
  z.object({ type: z.literal("openGitHub"), url: z.string().refine(isAllowedGitHubUrl, "Only exact HTTPS github.com links are allowed") }),
  z.object({ type: z.literal("expand"), nodeId: z.string().min(1), direction: z.enum(["in", "out", "both"]) }),
  z.object({ type: z.literal("navigate"), nodeId: z.string().min(1) }),
  z.object({ type: z.literal("compare"), beforeRevisions: RepositoryRevisionMapSchema, afterRevisions: RepositoryRevisionMapSchema }),
]);
export type WebviewInboundMessage = z.infer<typeof WebviewInboundMessageSchema>;

export const ExtensionOutboundMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("graph"), graph: GraphResponseSchema }),
  z.object({ type: z.literal("loading"), message: z.string() }),
  z.object({ type: z.literal("error"), message: z.string(), detail: z.string().optional() }),
  z.object({ type: z.literal("connection"), connected: z.boolean() }),
  z.object({ type: z.literal("inclusion"), eventId: z.string().min(1), result: ChangeInclusionResponseSchema }),
  z.object({ type: z.literal("comparison"), result: TemporalGraphComparisonResponseSchema }),
]);
export type ExtensionOutboundMessage = z.infer<typeof ExtensionOutboundMessageSchema>;

export function parseWebviewMessage(value: unknown): WebviewInboundMessage | undefined {
  const result = WebviewInboundMessageSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
