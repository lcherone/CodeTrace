import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRepositoryUrl, parseComposer } from "./composer.js";
import { linkComposerRevisions } from "./relationships.js";
import type { ComposerDependency } from "./model.js";

const oid = "a".repeat(40);

test("keeps declared constraint, resolved version, and source commit separate", () => {
  const result = parseComposer("consumer", 1, "", JSON.stringify({ name: "acme/consumer", require: { "acme/shared": "^2.0" }, autoload: { "psr-4": { "Acme\\": "src/" } } }), JSON.stringify({ packages: [{ name: "acme/shared", version: "2.4.0", source: { reference: oid } }] }));
  assert.equal(result.dependencies[0]?.declaredConstraint, "^2.0");
  assert.equal(result.dependencies[0]?.resolvedVersion, "2.4.0");
  assert.equal(result.dependencies[0]?.resolvedSourceCommit, oid);
  assert.equal(result.dependencies[0]?.indexedRevision, undefined);
});

test("preserves aliases, source and dist evidence without treating non-object references as commits", () => {
  const result = parseComposer("consumer", 2, "", JSON.stringify({ require: { "acme/shared": "dev-feature as 2.4.x-dev" }, extra: { "branch-alias": { "dev-main": "3.x-dev" } }, repositories: [{ type: "vcs", url: "https://token:secret@github.com/Acme/Shared.git?access_token=hidden#fragment", canonical: false }] }), JSON.stringify({ packages: [{ name: "acme/shared", version: "dev-feature", source: { type: "git", url: "https://token:secret@github.com/Acme/Shared.git?token=hidden#fragment", reference: "dev-feature" }, dist: { type: "zip", url: "https://token@example.test/archive.zip?signature=hidden#fragment", reference: "dist-ref" } }] }));
  const dependency = result.dependencies[0];
  assert.equal(dependency?.declaredConstraint, "dev-feature as 2.4.x-dev");
  assert.equal(dependency?.declaredConstraintBase, "dev-feature");
  assert.equal(dependency?.declaredAlias, "2.4.x-dev");
  assert.equal(dependency?.resolvedSourceReference, "dev-feature");
  assert.equal(dependency?.resolvedSourceCommit, undefined);
  assert.equal(dependency?.resolvedDistReference, "dist-ref");
  assert.equal(dependency?.normalizedSourceUrl, "github.com/acme/shared");
  assert.equal(dependency?.resolvedSourceUrl, "https://github.com/Acme/Shared.git");
  assert.equal(dependency?.resolvedDistUrl, "https://example.test/archive.zip");
  assert.equal(dependency?.repositoryCandidates?.[0]?.url, "https://github.com/Acme/Shared.git");
  assert.equal(dependency?.repositoryCandidates?.[0]?.canonical, false);
  assert.ok(!JSON.stringify(dependency).includes("secret") && !JSON.stringify(dependency).includes("hidden"));
  assert.deepEqual(result.pkg.branchAliases, { "dev-main": "3.x-dev" });
});

test("normalizes GitHub transports but preserves custom-host path case", () => {
  assert.equal(normalizeRepositoryUrl("git@github.com:Acme/Shared.git"), "github.com/acme/shared");
  assert.equal(normalizeRepositoryUrl("https://github.com/acme/shared/"), "github.com/acme/shared");
  assert.equal(normalizeRepositoryUrl("ssh://git@Git.Example.test/Team/Shared.git"), "git.example.test/Team/Shared");
  assert.notEqual(normalizeRepositoryUrl("https://git.example.test/Team/Shared.git"), normalizeRepositoryUrl("https://git.example.test/team/shared.git"));
});

test("resolves forks by evidence precedence and never by a shared commit alone", () => {
  const packages = [
    { repositoryId: "upstream", generation: 1, rootPath: "", repositoryPath: "/repos/Upstream", name: "acme/shared", sourceCommit: oid, repositoryUrl: "https://github.com/acme/shared", normalizedRepositoryUrl: "github.com/acme/shared", autoload: {} },
    { repositoryId: "fork", generation: 1, rootPath: "packages/shared", repositoryPath: "/repos/Fork/packages/shared", name: "acme/shared", sourceCommit: oid, repositoryUrl: "git@github.com:customer/shared.git", normalizedRepositoryUrl: "github.com/customer/shared", autoload: {} },
  ];
  const byUrl: ComposerDependency = { repositoryId: "consumer", generation: 1, packageName: "acme/shared", development: false, direct: true, resolvedSourceReference: oid, resolvedSourceCommit: oid, resolvedSourceUrl: "git@github.com:Customer/Shared.git", normalizedSourceUrl: "github.com/customer/shared", resolution: "exact" };
  linkComposerRevisions(packages, [byUrl]);
  assert.equal(byUrl.indexedRepositoryId, "fork"); assert.equal(byUrl.resolutionMethod, "source-url");
  const commitOnly: ComposerDependency = { repositoryId: "consumer", generation: 1, packageName: "acme/shared", development: false, direct: true, resolvedSourceReference: oid, resolvedSourceCommit: oid, resolution: "exact" };
  linkComposerRevisions(packages, [commitOnly]);
  assert.equal(commitOnly.indexedRepositoryId, undefined); assert.equal(commitOnly.resolution, "ambiguous");
  const explicit: ComposerDependency = { repositoryId: "consumer", generation: 1, packageName: "acme/shared", development: false, direct: true, resolvedSourceReference: oid, resolvedSourceCommit: oid, resolution: "exact" };
  linkComposerRevisions(packages, [explicit], [{ packageName: "acme/shared", repositoryId: "fork", packageRoot: "packages/shared" }]);
  assert.equal(explicit.indexedRepositoryId, "fork"); assert.equal(explicit.resolutionMethod, "explicit-mapping");
});

test("path identity is case-sensitive and outranks duplicate package names", () => {
  const packages = [
    { repositoryId: "upper", generation: 1, rootPath: "", repositoryPath: "/repos/Case/Shared", name: "acme/shared", sourceCommit: oid, autoload: {} },
    { repositoryId: "lower", generation: 1, rootPath: "", repositoryPath: "/repos/case/shared", name: "acme/shared", sourceCommit: oid, autoload: {} },
  ];
  const dependency: ComposerDependency = { repositoryId: "consumer", generation: 1, packageName: "acme/shared", development: false, direct: true, resolvedPath: "/repos/Case/Shared", resolution: "path" };
  linkComposerRevisions(packages, [dependency]);
  assert.equal(dependency.indexedRepositoryId, "upper"); assert.equal(dependency.resolutionMethod, "path");
});

test("uses exact installed paths ahead of wildcard path repositories while retaining version hints", () => {
  const manifest = { require: { "acme/shared": "@dev" }, repositories: [{ type: "path", url: "../packages/*", options: { versions: { "acme/shared": "2.5.x-dev", "acme/other": "1.x-dev" } } }] };
  const result = parseComposer("consumer", 1, "", JSON.stringify(manifest), JSON.stringify({ packages: [{ name: "acme/shared", version: "2.5.x-dev", dist: { reference: oid } }] }), { repositoryPath: "/workspace", installedPackages: [{ name: "acme/shared", "install-path": "../acme/shared" }] });
  const dependency = result.dependencies[0];
  assert.equal(dependency?.resolvedPath, "/workspace/vendor/acme/shared");
  assert.equal(dependency?.resolvedDistReference, oid); assert.equal(dependency?.resolvedSourceCommit, undefined);
  assert.equal(dependency?.repositoryCandidates?.length, 1);
  assert.equal(dependency?.repositoryCandidates?.[0]?.url, "../packages/*");
  assert.equal(dependency?.repositoryCandidates?.[0]?.resolvedPath, undefined);
  assert.equal(dependency?.repositoryCandidates?.[0]?.packageName, "acme/shared");
  assert.equal(dependency?.repositoryCandidates?.[0]?.versionOverride, "2.5.x-dev");
});

test("reports declared-only dependencies when no lock exists", () => {
  const result = parseComposer("consumer", 1, "", JSON.stringify({ require: { "acme/shared": "dev-main" } }));
  assert.equal(result.dependencies[0]?.resolution, "declared-only");
});

test("accepts Composer lock alias_normalized without using it as a revision", () => {
  const result = parseComposer("consumer", 1, "", JSON.stringify({ require: { "acme/shared": "dev-main" } }), JSON.stringify({ packages: [{ name: "acme/shared", version: "dev-main", source: { reference: "dev-main" } }], aliases: [{ package: "acme/shared", alias_normalized: "2.0.9999999.9999999-dev" }] }));
  assert.equal(result.dependencies[0]?.declaredAlias, "2.0.9999999.9999999-dev");
  assert.equal(result.dependencies[0]?.resolvedSourceReference, "dev-main");
  assert.equal(result.dependencies[0]?.resolvedSourceCommit, undefined);
});
