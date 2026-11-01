import type { Confidence, RelationshipType, SourceRange, SymbolKind } from "@trace/contracts";

export interface RepositoryRecord {
  id: string;
  root: string;
  remoteUrl?: string;
  defaultBranch?: string;
  include?: string[];
  exclude?: string[];
  sourceRevision?: string;
  discoveredFrom?: string;
  automatic?: boolean;
}

export interface ParsedCall {
  receiver: "this" | "self" | "static" | "parent" | "class" | "variable" | "dynamic";
  className?: string;
  classNames?: string[];
  methodName?: string;
  range: SourceRange;
  confidence: Confidence;
  resolutionMethod: ReceiverResolutionMethod;
  limitations: string[];
  expression: string;
  detail: string;
}

export type ReceiverAnalysisStatus = "resolved" | "ambiguous" | "unresolved" | "dynamic";
export type ReceiverResolutionMethod =
  | "this" | "static-class" | "parent" | "native-parameter" | "phpdoc-parameter"
  | "native-property" | "promoted-property" | "constructor-assignment" | "local-new"
  | "variable-alias" | "branch-merge" | "method-return" | "unresolved" | "invalidated"
  | "dynamic-method" | "container-lookup" | "runtime-class-string" | "reflection" | "magic-call";

export interface ParsedReceiverAnalysis {
  id: string;
  status: ReceiverAnalysisStatus;
  expression: string;
  methodName?: string;
  candidateTypes: string[];
  resolutionMethod: ReceiverResolutionMethod;
  confidence: Confidence;
  range: SourceRange;
  limitations: string[];
}

export interface ParsedTypeReference {
  declared: string;
  resolved: string[];
  builtins: string[];
  source: "native" | "phpdoc";
  composite: "named" | "union" | "intersection";
  nullable: boolean;
  lateStatic: boolean;
  alternatives?: string[][];
}

export interface ParsedParameter {
  name: string;
  byReference: boolean;
  variadic: boolean;
  optional?: boolean;
  type?: ParsedTypeReference;
  docType?: ParsedTypeReference;
  description?: string;
}

export interface ParsedLateStaticBinding {
  kind: "return-type" | "static-call" | "instantiation" | "member-access";
  range: SourceRange;
  detail: string;
}

export interface ParsedMethod {
  id: string;
  classFqn: string;
  name: string;
  visibility: "public" | "protected" | "private";
  static: boolean;
  abstract: boolean;
  final?: boolean;
  returnsByReference?: boolean;
  signature: string;
  source: string;
  range: SourceRange;
  implementationFingerprint: string;
  signatureFingerprint: string;
  documentationFingerprint: string;
  description?: string;
  documentationDetails?: string;
  parameters?: ParsedParameter[];
  returnType?: ParsedTypeReference;
  docReturnType?: ParsedTypeReference;
  returnDescription?: string;
  lateStaticBindings?: ParsedLateStaticBinding[];
  receiverAnalysis?: ParsedReceiverAnalysis[];
  calls: ParsedCall[];
}

export interface ParsedType {
  id: string;
  fqn: string;
  shortName: string;
  kind: Exclude<SymbolKind, "method">;
  abstract: boolean;
  final?: boolean;
  parent?: string;
  interfaces: string[];
  traits: string[];
  traitAdaptations?: Array<{ trait?: string; method: string; instead?: string[]; alias?: string; visibility?: "public" | "protected" | "private" }>;
  description?: string;
  documentationDetails?: string;
  methods: ParsedMethod[];
  range: SourceRange;
}

export interface ParsedFile {
  path: string;
  contentHash: string;
  namespace: string;
  imports: Record<string, string>;
  types: ParsedType[];
  limitations: string[];
}

export interface IndexedSymbol {
  id: string;
  generation: number;
  repositoryId: string;
  commit: string;
  path: string;
  kind: SymbolKind;
  fqn: string;
  memberName?: string;
  classFqn?: string;
  range: SourceRange;
  data: ParsedType | ParsedMethod;
}

export interface IndexedRelationship {
  id: string;
  generation: number;
  repositoryId: string;
  commit: string;
  sourceId: string;
  targetId: string;
  type: RelationshipType;
  confidence: Confidence;
  path?: string;
  range?: SourceRange;
  detail: string;
  limitations: string[];
  resolutionMethod?: string;
}

export interface ComposerPackage {
  repositoryId: string;
  generation: number;
  rootPath: string;
  name: string;
  version?: string;
  sourceCommit?: string;
  /** Canonical package root on disk when this generation came from a worktree. */
  repositoryPath?: string;
  repositoryUrl?: string;
  normalizedRepositoryUrl?: string;
  branchAliases?: Record<string, string>;
  autoload: Record<string, string[]>;
}

export type ComposerResolutionMethod = "explicit-mapping" | "path" | "source-url" | "package-name" | "unresolved";
export interface ComposerRepositoryCandidate {
  type: string;
  url?: string;
  normalizedUrl?: string;
  resolvedPath?: string;
  canonical: boolean;
  packageName?: string;
  versionOverride?: string;
}

export interface ComposerDependency {
  repositoryId: string;
  generation: number;
  packageName: string;
  development: boolean;
  direct: boolean;
  declaredConstraint?: string;
  declaredConstraintBase?: string;
  declaredAlias?: string;
  resolvedVersion?: string;
  resolvedSourceReference?: string;
  resolvedSourceUrl?: string;
  normalizedSourceUrl?: string;
  resolvedDistReference?: string;
  resolvedDistUrl?: string;
  resolvedPath?: string;
  /** Compatibility alias for resolvedSourceReference; never contains a Composer alias. */
  resolvedSourceCommit?: string;
  indexedRepositoryId?: string;
  indexedRevision?: string;
  resolutionMethod?: ComposerResolutionMethod;
  resolutionEvidence?: string[];
  repositoryCandidates?: ComposerRepositoryCandidate[];
  resolution: "exact" | "declared-only" | "path" | "ambiguous" | "unavailable";
}
