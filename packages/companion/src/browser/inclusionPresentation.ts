import type { ActiveBehaviour, InclusionState } from "@trace/contracts";

export interface InclusionAssessmentLike {
  state: InclusionState;
  activeBehaviour: ActiveBehaviour;
  basisCommit: string;
  equivalentCommit?: string | undefined;
  revertCommit?: string | undefined;
  lastMatchingCommit?: string | undefined;
}

export interface AssessmentPresentation {
  inclusionLabel: string;
  activeBehaviourLabel: string;
  commits: Array<{ label: string; commit: string }>;
}

const inclusionLabels: Record<InclusionState, string> = {
  "contains-original": "Contains original",
  "likely-equivalent": "Likely equivalent",
  "does-not-contain-original": "Does not contain original",
  unknown: "Unknown",
};

const behaviourLabels: Record<ActiveBehaviour, string> = {
  "likely-active": "Likely active",
  reverted: "Reverted",
  unknown: "Unknown",
};

export function presentAssessment(assessment: InclusionAssessmentLike): AssessmentPresentation {
  const commits: AssessmentPresentation["commits"] = [{ label: "Assessment basis", commit: assessment.basisCommit }];
  if (assessment.equivalentCommit) commits.push({ label: "Equivalent change", commit: assessment.equivalentCommit });
  if (assessment.revertCommit) commits.push({ label: "Revert", commit: assessment.revertCommit });
  if (assessment.lastMatchingCommit) commits.push({ label: "Last matching behaviour", commit: assessment.lastMatchingCommit });
  return {
    inclusionLabel: inclusionLabels[assessment.state],
    activeBehaviourLabel: behaviourLabels[assessment.activeBehaviour],
    commits,
  };
}
