import { ChangeInclusionResponseSchema, GraphResponseSchema, RepositoryRevisionMapSchema, TemporalGraphComparisonResponseSchema } from "@trace/contracts";
import { z } from "zod";
import { isAllowedGitHubUrl } from "./externalLinks.js";
import type { ExplorerDetails, CompatibilityResult } from "../exploration.js";
import type { MethodImpactResult } from "../method-impact.js";

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
  z.object({ type: z.literal("inspect"), itemId: z.string().min(1) }),
  z.object({ type: z.literal("restoreGraph"), graph: GraphResponseSchema }),
  z.object({ type: z.literal("loadHistory"), nodeId: z.string().min(1) }),
  z.object({ type: z.literal("assessCompatibility"), itemId: z.string().min(1), targetRef: z.string().optional() }),
  z.object({ type: z.literal("methodImpact"), itemId: z.string(), methodName: z.string().optional(), targetRef: z.string().optional(), localSignature: z.string().optional(), workingTree: z.boolean().optional(), phpVersion: z.string().optional(), includeHistory: z.boolean().optional() }),
  z.object({ type: z.literal("openLocation"), url: z.string().startsWith("vscode://file/") }),
  z.object({ type: z.literal("compare"), beforeRevisions: RepositoryRevisionMapSchema, afterRevisions: RepositoryRevisionMapSchema }),
]);
export type WebviewInboundMessage = z.infer<typeof WebviewInboundMessageSchema>;

export const ExtensionOutboundMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("graph"), graph: GraphResponseSchema, exploration: z.boolean().optional() }),
  z.object({ type: z.literal("methodImpact"), result: z.custom<MethodImpactResult>((value) => typeof value === "object" && value !== null && "analysisId" in value && "rows" in value) }),
  z.object({ type: z.literal("details"), details: z.custom<ExplorerDetails>((value) => typeof value === "object" && value !== null && "itemId" in value && "links" in value && "sections" in value) }),
  z.object({ type: z.literal("compatibility"), queryId: z.string(), result: z.custom<CompatibilityResult>((value) => typeof value === "object" && value !== null && "itemId" in value && "rows" in value) }),
  z.object({ type: z.literal("context"), relativePath: z.string().min(1), line: z.number().int().positive() }),
  z.object({ type: z.literal("loading"), message: z.string() }),
  z.object({ type: z.literal("progress"), message: z.string().nullable() }),
  z.object({ type: z.literal("error"), message: z.string(), detail: z.string().optional(), trace: z.boolean().optional() }),
  z.object({ type: z.literal("connection"), connected: z.boolean() }),
  z.object({ type: z.literal("inclusion"), eventId: z.string().min(1), result: ChangeInclusionResponseSchema }),
  z.object({ type: z.literal("comparison"), result: TemporalGraphComparisonResponseSchema }),
]);
export type ExtensionOutboundMessage = z.infer<typeof ExtensionOutboundMessageSchema>;

export function parseWebviewMessage(value: unknown): WebviewInboundMessage | undefined {
  const result = WebviewInboundMessageSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
