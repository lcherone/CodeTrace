export interface ComposerResolutionPresentation {
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
  indexedRepositoryId?: string;
  indexedRevision?: string;
  resolution?: string;
  resolutionMethod?: string;
  branchAliases: Array<{ branch: string; alias: string }>;
  repositoryCandidates: Array<{ type: string; url?: string; normalizedUrl?: string; resolvedPath?: string; canonical: boolean; packageName?: string }>;
  evidence: string[];
  limitations: string[];
}

const composerKeys = [
  "declaredConstraint", "declaredConstraintBase", "declaredAlias", "resolvedVersion",
  "resolvedSourceReference", "resolvedSourceUrl", "normalizedSourceUrl", "resolvedDistReference",
  "resolvedDistUrl", "resolvedPath", "indexedRepositoryId", "indexedRevision", "resolution",
  "resolutionMethod", "resolutionEvidence", "resolutionLimitations", "symbolAnalysis", "branchAliases", "repositoryCandidates",
] as const;

export const composerMetadataKeys = new Set<string>(composerKeys);

export function composerResolutionFromMetadata(metadata: Record<string, unknown>): ComposerResolutionPresentation | undefined {
  if (!composerKeys.some((key) => metadata[key] !== undefined)) return undefined;
  const text = (key: string): string | undefined => typeof metadata[key] === "string" ? metadata[key] : undefined;
  const list = (key: string): string[] => Array.isArray(metadata[key]) ? metadata[key].filter((item): item is string => typeof item === "string") : [];
  const limitations = list("resolutionLimitations");
  const resolution = text("resolution");
  const symbolAnalysis = text("symbolAnalysis");
  if (resolution === "ambiguous") limitations.push("Repository identity is ambiguous; no single indexed source can be claimed.");
  if (resolution === "unavailable") limitations.push("No indexed repository matched the available Composer identity evidence.");
  if (symbolAnalysis === "unavailable-for-exact-revision") limitations.push("Symbol analysis is unavailable for the exact locked revision.");
  const branchAliases = metadata.branchAliases && typeof metadata.branchAliases === "object" && !Array.isArray(metadata.branchAliases)
    ? Object.entries(metadata.branchAliases).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([branch, alias]) => ({ branch, alias }))
    : [];
  const repositoryCandidates = Array.isArray(metadata.repositoryCandidates) ? metadata.repositoryCandidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const value = candidate as Record<string, unknown>;
    if (typeof value.type !== "string" || typeof value.canonical !== "boolean") return [];
    return [{
      type: value.type,
      ...(typeof value.url === "string" ? { url: value.url } : {}),
      ...(typeof value.normalizedUrl === "string" ? { normalizedUrl: value.normalizedUrl } : {}),
      ...(typeof value.resolvedPath === "string" ? { resolvedPath: value.resolvedPath } : {}),
      canonical: value.canonical,
      ...(typeof value.packageName === "string" ? { packageName: value.packageName } : {}),
    }];
  }) : [];
  return {
    ...(text("declaredConstraint") ? { declaredConstraint: text("declaredConstraint")! } : {}),
    ...(text("declaredConstraintBase") ? { declaredConstraintBase: text("declaredConstraintBase")! } : {}),
    ...(text("declaredAlias") ? { declaredAlias: text("declaredAlias")! } : {}),
    ...(text("resolvedVersion") ? { resolvedVersion: text("resolvedVersion")! } : {}),
    ...(text("resolvedSourceReference") ? { resolvedSourceReference: text("resolvedSourceReference")! } : {}),
    ...(text("resolvedSourceUrl") ? { resolvedSourceUrl: text("resolvedSourceUrl")! } : {}),
    ...(text("normalizedSourceUrl") ? { normalizedSourceUrl: text("normalizedSourceUrl")! } : {}),
    ...(text("resolvedDistReference") ? { resolvedDistReference: text("resolvedDistReference")! } : {}),
    ...(text("resolvedDistUrl") ? { resolvedDistUrl: text("resolvedDistUrl")! } : {}),
    ...(text("resolvedPath") ? { resolvedPath: text("resolvedPath")! } : {}),
    ...(text("indexedRepositoryId") ? { indexedRepositoryId: text("indexedRepositoryId")! } : {}),
    ...(text("indexedRevision") ? { indexedRevision: text("indexedRevision")! } : {}),
    ...(resolution ? { resolution } : {}),
    ...(text("resolutionMethod") ? { resolutionMethod: text("resolutionMethod")! } : {}),
    branchAliases,
    repositoryCandidates,
    evidence: list("resolutionEvidence"),
    limitations: [...new Set(limitations)],
  };
}
