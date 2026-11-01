import assert from "node:assert/strict";
import test from "node:test";
import { composerResolutionFromMetadata } from "./composerPresentation";

test("presents Composer inline aliases without mixing the alias into the locked source reference", () => {
  assert.deepEqual(composerResolutionFromMetadata({
    declaredConstraint: "dev-feature as 2.4.x-dev",
    declaredConstraintBase: "dev-feature",
    declaredAlias: "2.4.x-dev",
    resolvedVersion: "dev-feature",
    resolvedSourceReference: "a".repeat(40),
    resolvedSourceUrl: "https://github.com/acme-fork/commerce.git",
    normalizedSourceUrl: "github.com/acme-fork/commerce",
    resolvedPath: "vendor/company/commerce",
    resolution: "path",
    resolutionMethod: "canonical-path",
    resolutionEvidence: ["Canonical path selected the indexed fork checkout"],
    branchAliases: { "dev-main": "2.x-dev" },
    repositoryCandidates: [{ type: "path", resolvedPath: "/work/vendor/company/commerce", canonical: true, packageName: "company/commerce" }],
  }), {
    declaredConstraint: "dev-feature as 2.4.x-dev",
    declaredConstraintBase: "dev-feature",
    declaredAlias: "2.4.x-dev",
    resolvedVersion: "dev-feature",
    resolvedSourceReference: "a".repeat(40),
    resolvedSourceUrl: "https://github.com/acme-fork/commerce.git",
    normalizedSourceUrl: "github.com/acme-fork/commerce",
    resolvedPath: "vendor/company/commerce",
    resolution: "path",
    resolutionMethod: "canonical-path",
    branchAliases: [{ branch: "dev-main", alias: "2.x-dev" }],
    repositoryCandidates: [{ type: "path", resolvedPath: "/work/vendor/company/commerce", canonical: true, packageName: "company/commerce" }],
    evidence: ["Canonical path selected the indexed fork checkout"],
    limitations: [],
  });
});

test("surfaces ambiguous and exact-revision limitations", () => {
  const result = composerResolutionFromMetadata({ resolution: "ambiguous", symbolAnalysis: "unavailable-for-exact-revision" });
  assert.deepEqual(result?.limitations, [
    "Repository identity is ambiguous; no single indexed source can be claimed.",
    "Symbol analysis is unavailable for the exact locked revision.",
  ]);
});
