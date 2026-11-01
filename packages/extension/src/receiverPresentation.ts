import type { Confidence } from "@trace/contracts";

export const receiverStatuses = ["resolved", "ambiguous", "unresolved", "dynamic"] as const;
export type ReceiverStatus = typeof receiverStatuses[number];

export const receiverResolutionMethods = [
  "this", "static-class", "parent", "native-parameter", "phpdoc-parameter", "native-property",
  "promoted-property", "constructor-assignment", "local-new", "variable-alias", "branch-merge",
  "method-return", "unresolved", "invalidated", "dynamic-method", "container-lookup",
  "runtime-class-string", "reflection", "magic-call",
] as const;
export type ReceiverResolutionMethod = typeof receiverResolutionMethods[number];

export interface ReceiverAnalysisPresentation {
  id: string;
  status: ReceiverStatus;
  expression: string;
  methodName?: string;
  candidateTypes: string[];
  resolutionMethod: ReceiverResolutionMethod;
  confidence: Confidence;
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  limitations: string[];
}

const statusSet = new Set<string>(receiverStatuses);
const methodSet = new Set<string>(receiverResolutionMethods);
const confidenceSet = new Set<string>(["confirmed", "possible", "dependency-only", "unresolved"]);

export function receiverAnalysisFromMetadata(metadata: Record<string, unknown>): ReceiverAnalysisPresentation[] {
  if (!Array.isArray(metadata.receiverAnalysis)) return [];
  return metadata.receiverAnalysis.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const value = candidate as Record<string, unknown>;
    const range = value.range;
    if (typeof value.id !== "string" || typeof value.expression !== "string" || typeof value.status !== "string" || !statusSet.has(value.status)
      || typeof value.resolutionMethod !== "string" || !methodSet.has(value.resolutionMethod) || typeof value.confidence !== "string" || !confidenceSet.has(value.confidence)
      || !range || typeof range !== "object" || Array.isArray(range)) return [];
    const sourceRange = range as Record<string, unknown>;
    if (![sourceRange.startLine, sourceRange.startColumn, sourceRange.endLine, sourceRange.endColumn].every((part) => typeof part === "number")) return [];
    return [{
      id: value.id,
      status: value.status as ReceiverStatus,
      expression: value.expression,
      ...(typeof value.methodName === "string" ? { methodName: value.methodName } : {}),
      candidateTypes: Array.isArray(value.candidateTypes) ? value.candidateTypes.filter((item): item is string => typeof item === "string") : [],
      resolutionMethod: value.resolutionMethod as ReceiverResolutionMethod,
      confidence: value.confidence as Confidence,
      range: {
        startLine: sourceRange.startLine as number,
        startColumn: sourceRange.startColumn as number,
        endLine: sourceRange.endLine as number,
        endColumn: sourceRange.endColumn as number,
      },
      limitations: Array.isArray(value.limitations) ? value.limitations.filter((item): item is string => typeof item === "string") : [],
    }];
  });
}

export function receiverPrecisionMessage(analysis: ReceiverAnalysisPresentation): string {
  if (analysis.status === "resolved" && analysis.confidence === "confirmed" && analysis.candidateTypes.length === 1) {
    return `Precise receiver candidate: ${analysis.candidateTypes[0]}`;
  }
  return "No precise target was claimed.";
}
