import { z } from "zod";

export const PROTOCOL_VERSION = "1.0" as const;

export const ConfidenceSchema = z.enum(["confirmed", "possible", "dependency-only", "unresolved"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const SourceRangeSchema = z.object({
  startLine: z.number().int().positive(),
  startColumn: z.number().int().nonnegative(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().nonnegative(),
});
export type SourceRange = z.infer<typeof SourceRangeSchema>;

export const RevisionIdentitySchema = z.object({
  repositoryId: z.string().min(1),
  commit: z.string().min(1),
  branch: z.string().optional(),
  dirty: z.boolean().default(false),
});
export type RevisionIdentity = z.infer<typeof RevisionIdentitySchema>;

export const SymbolKindSchema = z.enum(["class", "interface", "trait", "method"]);
export type SymbolKind = z.infer<typeof SymbolKindSchema>;

export const LogicalSymbolIdentitySchema = z.object({
  kind: SymbolKindSchema,
  fullyQualifiedName: z.string().min(1),
  memberName: z.string().optional(),
});
export type LogicalSymbolIdentity = z.infer<typeof LogicalSymbolIdentitySchema>;

export const SymbolOccurrenceSchema = z.object({
  id: z.string().min(1),
  logical: LogicalSymbolIdentitySchema,
  revision: RevisionIdentitySchema,
  path: z.string().min(1),
  range: SourceRangeSchema,
  overlayId: z.string().optional(),
});
export type SymbolOccurrence = z.infer<typeof SymbolOccurrenceSchema>;

export const SelectionSchema = z.object({
  repositoryPath: z.string().min(1),
  relativePath: z.string().min(1),
  revision: RevisionIdentitySchema,
  range: SourceRangeSchema,
  selectedText: z.string(),
  documentText: z.string().optional(),
  documentVersion: z.number().int().nonnegative().optional(),
});
export type Selection = z.infer<typeof SelectionSchema>;

export const TraceModeSchema = z.enum(["origin", "inheritance", "callers", "consumers", "impact", "history"]);
export type TraceMode = z.infer<typeof TraceModeSchema>;

export const BrowserLaunchRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
});
export type BrowserLaunchRequest = z.infer<typeof BrowserLaunchRequestSchema>;

export const BrowserLaunchResponseSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  url: z.string().url(),
  expiresAt: z.string().datetime(),
});
export type BrowserLaunchResponse = z.infer<typeof BrowserLaunchResponseSchema>;

export const EditorContextSelectionSchema = z.object({
  repositoryPath: z.string().min(1),
  relativePath: z.string().min(1),
  revision: RevisionIdentitySchema,
  range: SourceRangeSchema,
  symbolHint: z.string().min(1).max(512).regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\\[A-Za-z_][A-Za-z0-9_]*)*(?:::[A-Za-z_][A-Za-z0-9_]*)?$/).optional(),
}).strict();
export type EditorContextSelection = z.infer<typeof EditorContextSelectionSchema>;

export const EditorContextPayloadSchema = z.object({
  selection: EditorContextSelectionSchema,
  mode: TraceModeSchema.default("impact"),
  theme: z.enum(["light", "dark", "high-contrast"]).optional(),
});
export type EditorContextPayload = z.infer<typeof EditorContextPayloadSchema>;

export const EditorContextUpdateRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  clientId: z.string().min(1).max(128),
  context: EditorContextPayloadSchema.nullable(),
});
export type EditorContextUpdateRequest = z.infer<typeof EditorContextUpdateRequestSchema>;

export const EditorContextStateSchema = EditorContextPayloadSchema.extend({
  clientId: z.string().min(1).max(128),
  generation: z.number().int().nonnegative(),
  receivedAt: z.string().datetime(),
});
export type EditorContextState = z.infer<typeof EditorContextStateSchema>;

export const EditorContextResponseSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  version: z.number().int().nonnegative(),
  context: EditorContextStateSchema.nullable(),
});
export type EditorContextResponse = z.infer<typeof EditorContextResponseSchema>;

export const TraceRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1),
  selection: SelectionSchema,
  mode: TraceModeSchema.default("origin"),
  confidence: z.array(ConfidenceSchema).default(["confirmed", "possible", "dependency-only", "unresolved"]),
  projectIds: z.array(z.string()).default([]),
  expansionLimit: z.number().int().min(1).max(500).default(100),
});
export type TraceRequest = z.infer<typeof TraceRequestSchema>;

const RelativeSourcePathSchema = z.string().min(1).refine((value) => !value.startsWith("/") && !value.split(/[\\/]/).includes(".."), {
  message: "Source paths must be relative and remain inside the repository",
});

export const CodeLensCountItemSchema = z.object({
  id: z.string().min(1).max(200),
  path: RelativeSourcePathSchema,
  range: SourceRangeSchema,
  symbol: z.string().min(1).max(1_000).optional(),
});
export type CodeLensCountItem = z.infer<typeof CodeLensCountItemSchema>;

export const CodeLensCountsRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  repository: z.object({ repositoryId: z.string().min(1).max(200), commit: z.string().min(1).max(128) }),
  items: z.array(CodeLensCountItemSchema).min(1).max(200),
});
export type CodeLensCountsRequest = z.infer<typeof CodeLensCountsRequestSchema>;

export const CodeLensCountSchema = z.object({
  id: z.string().min(1),
  symbolId: z.string().optional(),
  callers: z.number().int().nonnegative(),
  consumers: z.number().int().nonnegative(),
  partial: z.boolean(),
  limitations: z.array(z.string()).default([]),
});
export type CodeLensCount = z.infer<typeof CodeLensCountSchema>;

export const CodeLensCountsResponseSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  repository: z.object({ repositoryId: z.string().min(1), commit: z.string().min(1) }),
  generation: z.number().int().positive(),
  counts: z.array(CodeLensCountSchema),
  cache: z.object({ hits: z.number().int().nonnegative(), misses: z.number().int().nonnegative(), rebuilt: z.boolean() }),
});
export type CodeLensCountsResponse = z.infer<typeof CodeLensCountsResponseSchema>;

export const ExpandRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1),
  queryId: z.string().min(1),
  nodeId: z.string().min(1),
  mode: TraceModeSchema,
  limit: z.number().int().min(1).max(200).default(50),
});
export type ExpandRequest = z.infer<typeof ExpandRequestSchema>;

export const RepositoryConfigSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  localPath: z.string().optional(),
  remoteUrl: z.string().min(1).optional(),
  defaultBranch: z.string().min(1).default("main"),
  additionalBranches: z.array(z.string()).default([]),
  include: z.array(z.string()).default(["**/*.php", "composer.json", "composer.lock"]),
  exclude: z.array(z.string()).default(["vendor/**", "node_modules/**", ".git/**"]),
  packageNames: z.array(z.string()).default([]),
}).refine((value) => value.localPath !== undefined || value.remoteUrl !== undefined, {
  message: "A localPath or remoteUrl is required",
});
export type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>;

export const IndexRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1),
  repositories: z.array(RepositoryConfigSchema).min(1),
  force: z.boolean().default(false),
});
export type IndexRequest = z.infer<typeof IndexRequestSchema>;

export const GraphNodeKindSchema = z.enum(["project", "package-revision", "class", "interface", "trait", "method", "commit", "release"]);
export type GraphNodeKind = z.infer<typeof GraphNodeKindSchema>;

export const EvidenceSchema = z.object({
  repositoryId: z.string().min(1),
  commit: z.string().min(1),
  path: z.string().optional(),
  range: SourceRangeSchema.optional(),
  resolutionMethod: z.string().min(1),
  confidence: ConfidenceSchema,
  detail: z.string().min(1),
  limitations: z.array(z.string()).default([]),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const GraphNodeSchema = z.object({
  id: z.string().min(1),
  kind: GraphNodeKindSchema,
  label: z.string().min(1),
  subtitle: z.string().optional(),
  occurrence: SymbolOccurrenceSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  focused: z.boolean().optional(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const RelationshipTypeSchema = z.enum([
  "requires", "resolves-to", "declares", "extends", "implements", "uses-trait",
  "inherits", "overrides", "calls", "calls-parent", "changed-in", "included-in-release",
  "possible-lineage", "implements-method", "parameter-type", "return-type", "late-static-binding",
  "signature-compatible", "signature-incompatible", "signature-unknown",
]);
export type RelationshipType = z.infer<typeof RelationshipTypeSchema>;

export const GraphEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  type: RelationshipTypeSchema,
  label: z.string().min(1),
  confidence: ConfidenceSchema,
  evidence: z.array(EvidenceSchema).min(1),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const HistoryEventSchema = z.object({
  id: z.string().min(1),
  symbolId: z.string().min(1),
  commit: z.string().min(1),
  parentCommit: z.string().optional(),
  category: z.enum(["introduction", "implementation", "signature", "documentation", "formatting", "relationship", "move", "rename", "revert"]),
  summary: z.string().min(1),
  authorName: z.string(),
  authorEmail: z.string(),
  // Git's strict ISO format commonly uses an explicit `+00:00` offset rather
  // than the equivalent `Z`; both are valid revision evidence.
  authoredAt: z.string().datetime({ offset: true }),
  beforeSource: z.string().optional(),
  afterSource: z.string().optional(),
  lineage: z.object({
    fromPath: z.string().min(1),
    toPath: z.string().min(1),
    fromSymbol: z.string().min(1),
    toSymbol: z.string().min(1),
    confidence: ConfidenceSchema,
    evidence: z.array(EvidenceSchema).min(1),
    limitations: z.array(z.string()).default([]),
  }).optional(),
  limitations: z.array(z.string()).default([]),
});
export type HistoryEvent = z.infer<typeof HistoryEventSchema>;

export const InclusionStateSchema = z.enum(["contains-original", "likely-equivalent", "does-not-contain-original", "unknown"]);
export type InclusionState = z.infer<typeof InclusionStateSchema>;
export const ActiveBehaviourSchema = z.enum(["likely-active", "reverted", "unknown"]);
export type ActiveBehaviour = z.infer<typeof ActiveBehaviourSchema>;

export const ConsumerInclusionSchema = z.object({
  consumerRepositoryId: z.string().min(1),
  packageName: z.string().min(1),
  declaredConstraint: z.string().optional(),
  declaredConstraintBase: z.string().optional(),
  declaredAlias: z.string().optional(),
  resolvedVersion: z.string().optional(),
  resolvedSourceReference: z.string().optional(),
  resolvedSourceUrl: z.string().optional(),
  resolvedDistReference: z.string().optional(),
  resolvedDistUrl: z.string().optional(),
  resolvedPath: z.string().optional(),
  resolvedSourceCommit: z.string().optional(),
  indexedRepositoryId: z.string().optional(),
  indexedRevision: z.string().optional(),
  resolutionMethod: z.string().optional(),
  resolutionEvidence: z.array(z.string()).default([]),
  indexedSourceCommit: z.string().optional(),
  selectedChangeCommit: z.string().min(1),
  state: InclusionStateSchema,
  activeBehaviour: ActiveBehaviourSchema,
  basisCommit: z.string().min(1),
  equivalentCommit: z.string().min(1).optional(),
  revertCommit: z.string().min(1).optional(),
  lastMatchingCommit: z.string().min(1).optional(),
  reason: z.string().min(1),
  evidence: z.array(EvidenceSchema),
  limitations: z.array(z.string()).default([]),
});
export type ConsumerInclusion = z.infer<typeof ConsumerInclusionSchema>;

export const ReleaseInclusionAssessmentSchema = z.object({
  release: z.string().min(1),
  revision: z.string().min(1),
  state: InclusionStateSchema,
  activeBehaviour: ActiveBehaviourSchema,
  basisCommit: z.string().min(1),
  equivalentCommit: z.string().min(1).optional(),
  revertCommit: z.string().min(1).optional(),
  lastMatchingCommit: z.string().min(1).optional(),
  evidence: z.array(EvidenceSchema),
  limitations: z.array(z.string()).default([]),
});
export type ReleaseInclusionAssessment = z.infer<typeof ReleaseInclusionAssessmentSchema>;

export const ComposerResolutionMethodSchema = z.enum(["explicit-mapping", "path", "source-url", "package-name", "unresolved"]);
export type ComposerResolutionMethod = z.infer<typeof ComposerResolutionMethodSchema>;

export const ComposerPackageSchema = z.object({
  repositoryId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  rootPath: z.string(),
  name: z.string().min(1),
  version: z.string().optional(),
  sourceCommit: z.string().optional(),
  repositoryPath: z.string().optional(),
  repositoryUrl: z.string().optional(),
  normalizedRepositoryUrl: z.string().optional(),
  branchAliases: z.record(z.string(), z.string()).default({}),
  autoload: z.record(z.string(), z.array(z.string())),
});
export type ComposerPackage = z.infer<typeof ComposerPackageSchema>;

export const ComposerRepositoryCandidateSchema = z.object({
  type: z.string().min(1),
  url: z.string().optional(),
  normalizedUrl: z.string().optional(),
  resolvedPath: z.string().optional(),
  canonical: z.boolean(),
  packageName: z.string().optional(),
  versionOverride: z.string().optional(),
});
export type ComposerRepositoryCandidate = z.infer<typeof ComposerRepositoryCandidateSchema>;

export const ComposerDependencySchema = z.object({
  repositoryId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  packageName: z.string().min(1),
  development: z.boolean(),
  direct: z.boolean(),
  declaredConstraint: z.string().optional(),
  declaredConstraintBase: z.string().optional(),
  declaredAlias: z.string().optional(),
  resolvedVersion: z.string().optional(),
  resolvedSourceReference: z.string().optional(),
  resolvedSourceUrl: z.string().optional(),
  normalizedSourceUrl: z.string().optional(),
  resolvedDistReference: z.string().optional(),
  resolvedDistUrl: z.string().optional(),
  resolvedPath: z.string().optional(),
  resolvedSourceCommit: z.string().optional(),
  indexedRepositoryId: z.string().optional(),
  indexedRevision: z.string().optional(),
  resolutionMethod: ComposerResolutionMethodSchema.default("unresolved"),
  resolutionEvidence: z.array(z.string()).default([]),
  repositoryCandidates: z.array(ComposerRepositoryCandidateSchema).default([]),
  resolution: z.enum(["exact", "declared-only", "path", "ambiguous", "unavailable"]),
});
export type ComposerDependency = z.infer<typeof ComposerDependencySchema>;

export const GitHubPullRequestAssociationSchema = z.object({
  repository: z.string().min(1),
  repositoryUrl: z.string().url(),
  commit: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  mergedAt: z.string().datetime({ offset: true }).nullable().optional(),
  headRepository: z.string().optional(),
  headRepositoryUrl: z.string().url().optional(),
  headCommit: z.string().optional(),
  confidence: ConfidenceSchema,
  evidence: z.array(EvidenceSchema).min(1),
  limitations: z.array(z.string()).default([]),
});
export type GitHubPullRequestAssociation = z.infer<typeof GitHubPullRequestAssociationSchema>;

export const GitHubReleaseAssociationSchema = z.object({
  repository: z.string().min(1),
  repositoryUrl: z.string().url(),
  tagName: z.string().min(1),
  tagCommit: z.string().min(1),
  url: z.string().url(),
  name: z.string().nullable().optional(),
  publishedAt: z.string().datetime({ offset: true }).nullable().optional(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  targetCommitish: z.string().optional(),
  confidence: ConfidenceSchema,
  evidence: z.array(EvidenceSchema).min(1),
  limitations: z.array(z.string()).default([]),
});
export type GitHubReleaseAssociation = z.infer<typeof GitHubReleaseAssociationSchema>;

export const GitHubAssociationsSchema = z.object({
  pullRequests: z.array(GitHubPullRequestAssociationSchema).default([]),
  releases: z.array(GitHubReleaseAssociationSchema).default([]),
  limitations: z.array(z.string()).default([]),
});
export type GitHubAssociations = z.infer<typeof GitHubAssociationsSchema>;

export const ChangeInclusionResponseSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  symbolId: z.string().min(1),
  commit: z.string().min(1),
  releases: z.array(z.string()),
  releaseAssessments: z.array(ReleaseInclusionAssessmentSchema).default([]),
  consumers: z.array(ConsumerInclusionSchema),
  githubAssociations: GitHubAssociationsSchema.default({ pullRequests: [], releases: [], limitations: [] }),
  limitations: z.array(z.string()).default([]),
});
export type ChangeInclusionResponse = z.infer<typeof ChangeInclusionResponseSchema>;

export const GraphResponseSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  queryId: z.string().min(1),
  mode: TraceModeSchema,
  focusNodeId: z.string().min(1),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  history: z.array(HistoryEventSchema).default([]),
  freshness: z.object({
    generation: z.number().int().nonnegative(),
    indexedAt: z.string().datetime(),
    repositories: z.array(RevisionIdentitySchema),
    partial: z.boolean(),
    limitations: z.array(z.string()),
  }),
});
export type GraphResponse = z.infer<typeof GraphResponseSchema>;

export const CommitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i, "A full Git commit object ID is required");
export type CommitObjectId = z.infer<typeof CommitObjectIdSchema>;

export const RepositoryRevisionMapSchema = z.record(z.string().min(1), CommitObjectIdSchema)
  .refine((value) => Object.keys(value).length > 0, "At least one repository revision is required");
export type RepositoryRevisionMap = z.infer<typeof RepositoryRevisionMapSchema>;

export const TemporalGraphPointSchema = z.object({
  revisions: RepositoryRevisionMapSchema,
  selection: SelectionSchema,
}).superRefine((value, context) => {
  const declared = value.revisions[value.selection.revision.repositoryId];
  if (!declared) {
    context.addIssue({ code: "custom", path: ["selection", "revision", "repositoryId"], message: "The selected repository must have an explicit revision" });
  } else if (declared.toLowerCase() !== value.selection.revision.commit.toLowerCase()) {
    context.addIssue({ code: "custom", path: ["selection", "revision", "commit"], message: "The selection commit must exactly match its declared repository revision" });
  }
  if (value.selection.revision.dirty || value.selection.documentText !== undefined) {
    context.addIssue({ code: "custom", path: ["selection"], message: "Temporal graph points must use committed Git objects without a working-tree overlay" });
  }
});
export type TemporalGraphPoint = z.infer<typeof TemporalGraphPointSchema>;

export const TemporalGraphComparisonRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  mode: TraceModeSchema,
  before: TemporalGraphPointSchema,
  after: TemporalGraphPointSchema,
  limit: z.number().int().min(1).max(500).default(100),
});
export type TemporalGraphComparisonRequest = z.infer<typeof TemporalGraphComparisonRequestSchema>;

export const GraphBasisChangeSchema = z.object({
  repositoryId: z.string().min(1),
  kind: z.enum(["added", "removed", "changed"]),
  beforeCommit: CommitObjectIdSchema.optional(),
  afterCommit: CommitObjectIdSchema.optional(),
});
export type GraphBasisChange = z.infer<typeof GraphBasisChangeSchema>;

export const RepositoryRevisionResolutionSchema = z.object({
  repositoryId: z.string().min(1),
  requestedCommit: CommitObjectIdSchema,
  resolvedCommit: CommitObjectIdSchema,
  status: z.literal("resolved"),
});
export type RepositoryRevisionResolution = z.infer<typeof RepositoryRevisionResolutionSchema>;

export const GraphNodeChangeSchema = z.object({
  identity: z.string().min(1),
  before: GraphNodeSchema,
  after: GraphNodeSchema,
  changedFields: z.array(z.string().min(1)).min(1),
});
export type GraphNodeChange = z.infer<typeof GraphNodeChangeSchema>;

export const GraphEdgeChangeSchema = z.object({
  identity: z.string().min(1),
  before: GraphEdgeSchema,
  after: GraphEdgeSchema,
  changedFields: z.array(z.string().min(1)).min(1),
});
export type GraphEdgeChange = z.infer<typeof GraphEdgeChangeSchema>;

export const TemporalGraphComparisonResponseSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  basis: z.object({
    policy: z.literal("explicit-revisions-only"),
    complete: z.literal(true),
    before: z.array(RepositoryRevisionResolutionSchema),
    after: z.array(RepositoryRevisionResolutionSchema),
  }),
  before: GraphResponseSchema,
  after: GraphResponseSchema,
  basisChanges: z.array(GraphBasisChangeSchema),
  changes: z.object({
    nodes: z.object({ added: z.array(GraphNodeSchema), removed: z.array(GraphNodeSchema), changed: z.array(GraphNodeChangeSchema) }),
    edges: z.object({ added: z.array(GraphEdgeSchema), removed: z.array(GraphEdgeSchema), changed: z.array(GraphEdgeChangeSchema) }),
  }),
});
export type TemporalGraphComparisonResponse = z.infer<typeof TemporalGraphComparisonResponseSchema>;

export const IndexStateSchema = z.object({
  repositoryId: z.string(),
  state: z.enum(["queued", "running", "ready", "failed", "cancelled"]),
  generation: z.number().int().nonnegative(),
  completedFiles: z.number().int().nonnegative(),
  totalFiles: z.number().int().nonnegative(),
  indexedCommit: z.string().optional(),
  error: z.string().optional(),
});
export type IndexState = z.infer<typeof IndexStateSchema>;

export const ErrorResponseSchema = z.object({
  protocolVersion: z.string(),
  error: z.object({
    code: z.enum(["PROTOCOL_MISMATCH", "UNAUTHORIZED", "INVALID_REQUEST", "NOT_FOUND", "CONFLICT", "CANCELLED", "INTERNAL"]),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export type CompanionStatus = {
  protocolVersion: typeof PROTOCOL_VERSION;
  service: "trace-companion";
  state: "ready" | "indexing" | "degraded";
  uptimeSeconds: number;
  fixtureMode: boolean;
};
