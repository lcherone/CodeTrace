import assert from "node:assert/strict";
import test from "node:test";
import { presentAssessment } from "./inclusionPresentation";

test("presents equivalent inclusion separately from likely active behaviour", () => {
  assert.deepEqual(presentAssessment({
    state: "likely-equivalent",
    activeBehaviour: "likely-active",
    basisCommit: "a".repeat(40),
    equivalentCommit: "b".repeat(40),
  }), {
    inclusionLabel: "Likely equivalent",
    activeBehaviourLabel: "Likely active",
    commits: [
      { label: "Assessment basis", commit: "a".repeat(40) },
      { label: "Equivalent change", commit: "b".repeat(40) },
    ],
  });
});

test("presents revert evidence without implying that inclusion disappeared", () => {
  assert.deepEqual(presentAssessment({
    state: "contains-original",
    activeBehaviour: "reverted",
    basisCommit: "c".repeat(40),
    revertCommit: "d".repeat(40),
    lastMatchingCommit: "e".repeat(40),
  }), {
    inclusionLabel: "Contains original",
    activeBehaviourLabel: "Reverted",
    commits: [
      { label: "Assessment basis", commit: "c".repeat(40) },
      { label: "Revert", commit: "d".repeat(40) },
      { label: "Last matching behaviour", commit: "e".repeat(40) },
    ],
  });
});
