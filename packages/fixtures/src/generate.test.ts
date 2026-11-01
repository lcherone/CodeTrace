import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateFixtures } from "./generate.js";

function git(repository: string, args: string[]): string {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}

function stablePatchId(repository: string, commit: string): string {
  const patch = execFileSync("git", ["-C", repository, "show", "--pretty=format:", "--binary", commit]);
  return execFileSync("git", ["-C", repository, "patch-id", "--stable"], { input: patch, encoding: "utf8" }).trim().split(/\s+/)[0]!;
}

function lockedReference(repository: string, commit: string): string {
  const lock = JSON.parse(git(repository, ["show", `${commit}:composer.lock`])) as { packages: Array<{ name: string; source?: { reference?: string }; dist?: { reference?: string } }> };
  const pkg = lock.packages.find((item) => item.name === "company/commerce")!;
  return pkg.source?.reference ?? pkg.dist?.reference ?? "";
}

function gitJson(repository: string, commit: string, file: string): any {
  return JSON.parse(git(repository, ["show", `${commit}:${file}`]));
}

function normalizedExpectations(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if ((key === "repositoryPath" || key === "resolvedPath") && typeof item === "string") return path.basename(item);
    if (key === "resolutionEvidence" && Array.isArray(item)) {
      return item.map((entry) => typeof entry === "string"
        ? entry.replace(/Canonical path .*\/shared-commerce was used/, "Canonical path <fixture>/shared-commerce was used")
        : entry);
    }
    return item;
  }));
}

test("generates revision-specific package and consumer histories", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "trace-fixtures-"));
  const destination = path.join(parent, "repos");
  try {
    const manifest = await generateFixtures(destination);
    assert.equal(manifest.repositories.length, 3);

    const shared = manifest.repositories.find((repository) => repository.id === "company-commerce")!;
    const store = manifest.repositories.find((repository) => repository.id === "client-store")!;
    const reporting = manifest.repositories.find((repository) => repository.id === "client-reporting")!;

    assert.deepEqual(git(shared.path, ["tag", "--list", "v*", "--sort=version:refname"]).split("\n"), ["v1.0.0", "v1.1.0", "v1.1.0-equivalent", "v1.1.1", "v2.0.0", "v2.0.1"]);
    assert.match(git(shared.path, ["branch", "--list", "release/1.x"]), /release\/1\.x/);
    assert.deepEqual(Object.keys(shared.commits), ["introduction", "implementation", "documentation", "unrelated", "formatting", "moveRename", "signature", "analysisSurface", "parallelRelease", "revertedChange", "revert", "activityChange", "activityRevert", "activityReapply", "equivalenceBranchBase", "equivalentCherryPick"]);
    assert.equal(git(shared.path, ["merge-base", "--is-ancestor", shared.commits.revertedChange!, shared.head]), "");
    const baseOrder = git(shared.path, ["show", `${shared.head}:src/BaseOrder.php`]);
    const contract = git(shared.path, ["show", `${shared.head}:src/Contracts/PricedOrder.php`]);
    const trait = git(shared.path, ["show", `${shared.head}:src/Support/PricingMath.php`]);
    assert.match(baseOrder, /discountedSubtotal/);
    assert.match(baseOrder, /public function price\(PriceContext \$context\): Money/);
    assert.match(baseOrder, /Rules and currency for the calculation/);
    assert.match(baseOrder, /static::currencyCode\(\)/);
    assert.match(baseOrder, /public static function create\(int \$subtotal\): static/);
    assert.match(baseOrder, /new static\(\$subtotal\)/);
    assert.match(contract, /calculateTotal\(bool \$includeTax = true\)/);
    assert.match(contract, /public function price\(PriceContext \$context\): Money/);
    assert.match(trait, /protected function priceSubtotal\(int \$subtotal, PriceContext \$context, string \$currency\): Money/);
    assert.match(git(shared.path, ["show", `${shared.head}:src/RegionalOrder.php`]), /abstract class RegionalOrder extends BaseOrder/);
    assert.doesNotMatch(git(shared.path, ["show", `${shared.head}:src/RegionalOrder.php`]), /function calculateTotal/);
    assert.match(git(shared.path, ["show", `${shared.head}:src/StandardOrder.php`]), /extends RegionalOrder/);
    assert.match(git(shared.path, ["show", `${shared.head}:src/WholesaleOrder.php`]), /extends RegionalOrder/);
    assert.match(git(shared.path, ["show", `${shared.head}:src/WholesaleOrder.php`]), /does not call the parent/);
    assert.match(git(shared.path, ["show", `${shared.head}:src/Legacy/LegacyPriceAdapter.php`]), /@param PriceContext \$context Legacy pricing input/);
    assert.match(git(shared.path, ["show", `${shared.head}:src/Legacy/LegacyPriceAdapter.php`]), /@return Money Legacy monetary output/);
    assert.match(git(shared.path, ["show", `${shared.head}:src/Value/Money.php`]), /final readonly class Money/);
    assert.match(git(shared.path, ["show", `${shared.head}:src/Value/PriceContext.php`]), /final readonly class PriceContext/);
    assert.doesNotMatch(baseOrder, /deliberately reverted/);
    assert.match(baseOrder, /public function fixtureMarker\(\): string/);
    assert.match(git(shared.path, ["show", `${shared.tags["v1.0.0"]}:src/BaseOrder.php`]), /return \$this->subtotal/);
    assert.equal(git(shared.path, ["diff", "--name-only", shared.commits.implementation!, shared.commits.documentation!]), "src/BaseOrder.php");
    assert.doesNotMatch(git(shared.path, ["show", `${shared.commits.implementation}:src/BaseOrder.php`]), /Calculate the payable total/);
    assert.match(git(shared.path, ["show", `${shared.commits.documentation}:src/BaseOrder.php`]), /Calculate the payable total/);
    assert.deepEqual(manifest.expectations.historyCategories, ["introduction", "implementation", "documentation", "formatting", "signature"]);
    assert.deepEqual(manifest.expectations.examples, {
      nativeTypeMethod: "Company\\Commerce\\BaseOrder::price",
      phpDocTypeMethod: "Company\\Commerce\\Legacy\\LegacyPriceAdapter::copy",
      interfaceContract: "Company\\Commerce\\Contracts\\PricedOrder::price",
      trait: "Company\\Commerce\\Support\\PricingMath::priceSubtotal",
      lateStaticMethod: "Company\\Commerce\\BaseOrder::create",
      inheritedWithoutOverride: "Company\\Commerce\\StandardOrder",
      overrideWithoutParentCall: "Company\\Commerce\\WholesaleOrder::calculateTotal",
      overrideCallingParent: "Client\\Store\\Order::calculateTotal",
      directCaller: "Client\\Store\\CheckoutService::quote",
      impactCaller: "Client\\Store\\CheckoutController::summary",
      dynamicCaller: "Client\\Store\\CheckoutService::dynamic",
      unresolvedCaller: "Client\\Store\\CheckoutService::unresolved",
    });

    const storeLock = JSON.parse(await readFile(path.join(store.path, "composer.lock"), "utf8")) as { packages: Array<{ source?: { reference?: string }; dist?: { reference?: string } }> };
    const reportingLock = JSON.parse(await readFile(path.join(reporting.path, "composer.lock"), "utf8")) as { packages: Array<{ source?: { reference?: string }; dist?: { reference?: string } }> };
    assert.equal(storeLock.packages[0]!.dist?.reference, manifest.expectations.newerConsumerReference);
    assert.equal(storeLock.packages[0]!.source, undefined);
    assert.equal(reportingLock.packages[0]!.source?.reference, manifest.expectations.olderConsumerReference);
    assert.match(await readFile(path.join(store.path, "src/Order.php"), "utf8"), /parent::calculateTotal/);
    const checkout = await readFile(path.join(store.path, "src/CheckoutService.php"), "utf8");
    assert.match(checkout, /public function total\(Order \$order\): int/);
    assert.match(checkout, /use Company\\Commerce\\BaseOrder/);
    assert.match(checkout, /public function quote\(BaseOrder \$order, PriceContext \$context\): Money/);
    assert.match(checkout, /return \$order->price\(\$context\)/);
    assert.match(checkout, /\$service->\{\$method\}/);
    assert.match(checkout, /public function unresolved\(object \$service, PriceContext \$context\): mixed/);
    assert.match(checkout, /receiver type cannot resolve price precisely/);
    assert.match(await readFile(path.join(store.path, "src/CheckoutController.php"), "utf8"), /return \$checkout->quote\(\$order, \$context\)/);
    const receiverShowcase = await readFile(path.join(store.path, "src/ReceiverInferenceShowcase.php"), "utf8");
    for (const pattern of [
      /public BaseOrder \$order/,
      /__construct\(private BaseOrder \$order\)/,
      /private \$order;[\s\S]*\$this->order = \$order/,
      /new DefaultOrder\(1200\)/,
      /\$selectedOrder = \$order/,
      /\$this->makeOrder\(\)->price/,
      /RetailPriceGateway\|WholesalePriceGateway \$gateway/,
      /@param BaseOrder \$order/,
      /\$order = \$replacement/,
      /\$order->\{\$method\}/,
      /\$container->get\(BaseOrder::class\)->price/,
      /\$container->make\(BaseOrder::class\)->price/,
      /\$container->resolve\(BaseOrder::class\)->price/,
      /new \$class\(1200\)/,
      /\$reflection->newInstance\(1200\)/,
      /MagicOrderProxy \$proxy/,
    ]) assert.match(receiverShowcase, pattern);
    assert.doesNotMatch(await readFile(path.join(reporting.path, "src/Report.php"), "utf8"), /BaseOrder|calculateTotal/);
    assert.equal(git(store.path, ["rev-list", "--count", "HEAD"]), "4");
    assert.deepEqual(Object.keys(store.commits), ["initialConsumer", "dependencyUpdate", "impactSurface", "receiverInference"]);
    assert.deepEqual(Object.keys(reporting.commits), ["dependencyOnly", "dependencyUpdate", "legacyTrackRestore", "customForkEvaluation", "customForkRestore"]);

    const receiverInference = manifest.expectations.receiverInference;
    assert.equal(receiverInference.repositoryId, "client-store");
    assert.equal(receiverInference.commit, store.commits.receiverInference);
    assert.equal(receiverInference.path, "src/ReceiverInferenceShowcase.php");
    assert.equal(receiverInference.targetMethod, "Company\\Commerce\\BaseOrder::price");
    const receiverCases = new Map(receiverInference.cases.map((item) => [item.id, item]));
    assert.deepEqual([...receiverCases.keys()], [
      "native-property", "promoted-property", "constructor-assignment", "local-new-import-alias", "variable-alias", "typed-factory-return",
      "native-union", "phpdoc-only", "reassignment-invalidation", "dynamic-method-name", "container-get", "container-make",
      "container-resolve", "runtime-class-string", "reflection-factory", "magic-fallback",
    ]);
    for (const id of ["native-property", "promoted-property", "constructor-assignment", "local-new-import-alias", "variable-alias", "typed-factory-return"]) {
      const item = receiverCases.get(id)!;
      assert.equal(item.status, "resolved", id);
      assert.equal(item.confidence, "confirmed", id);
      assert.equal(item.expectedCallTargets.length, 1, id);
      assert.deepEqual(item.limitations, [], id);
    }
    assert.equal(receiverCases.get("native-property")?.resolutionMethod, "native-property");
    assert.equal(receiverCases.get("promoted-property")?.resolutionMethod, "promoted-property");
    assert.equal(receiverCases.get("constructor-assignment")?.resolutionMethod, "constructor-assignment");
    assert.deepEqual(receiverCases.get("local-new-import-alias")?.candidateTypes, ["Company\\Commerce\\StandardOrder"]);
    assert.equal(receiverCases.get("variable-alias")?.expression, "$selectedOrder");
    assert.equal(receiverCases.get("typed-factory-return")?.expression, "$this->makeOrder()");
    assert.equal(receiverCases.get("native-union")?.status, "ambiguous");
    assert.equal(receiverCases.get("native-union")?.confidence, "possible");
    assert.deepEqual(receiverCases.get("native-union")?.expectedCallTargets, ["Client\\Store\\RetailPriceGateway::price", "Client\\Store\\WholesalePriceGateway::price"]);
    assert.equal(receiverCases.get("phpdoc-only")?.status, "resolved");
    assert.equal(receiverCases.get("phpdoc-only")?.confidence, "possible");
    assert.equal(receiverCases.get("phpdoc-only")?.resolutionMethod, "phpdoc-parameter");
    for (const id of ["reassignment-invalidation", "container-get", "container-make", "container-resolve", "runtime-class-string", "reflection-factory", "magic-fallback"]) {
      const item = receiverCases.get(id)!;
      assert.equal(item.status, "unresolved", id);
      assert.equal(item.confidence, "unresolved", id);
      assert.deepEqual(item.expectedCallTargets, [], id);
      assert.ok(item.limitations.length > 0, id);
    }
    assert.equal(receiverCases.get("dynamic-method-name")?.status, "dynamic");
    assert.equal(receiverCases.get("dynamic-method-name")?.confidence, "unresolved");
    assert.deepEqual(receiverCases.get("dynamic-method-name")?.expectedCallTargets, []);
    assert.equal(receiverCases.get("reassignment-invalidation")?.resolutionMethod, "invalidated");
    assert.deepEqual(receiverCases.get("container-get")?.candidateTypes, []);
    assert.deepEqual(receiverCases.get("runtime-class-string")?.candidateTypes, ["Company\\Commerce\\BaseOrder"]);
    assert.deepEqual(receiverCases.get("reflection-factory")?.candidateTypes, ["Company\\Commerce\\BaseOrder"]);
    assert.deepEqual(receiverCases.get("magic-fallback")?.candidateTypes, ["Client\\Store\\MagicOrderProxy"]);

    const composerResolution = manifest.expectations.composerResolution;
    const sharedComposer = gitJson(shared.path, shared.head, "composer.json");
    const storeComposer = gitJson(store.path, store.head, "composer.json");
    const forkComposer = gitJson(reporting.path, reporting.commits.customForkEvaluation!, "composer.json");
    const pathLock = gitJson(store.path, store.head, "composer.lock");
    const forkLock = gitJson(reporting.path, reporting.commits.customForkEvaluation!, "composer.lock");
    assert.deepEqual(sharedComposer.extra["branch-alias"], composerResolution.branchAliases);
    assert.equal(storeComposer.require["company/commerce"], composerResolution.pathRepository.declaredConstraint);
    assert.equal(composerResolution.pathRepository.declaredConstraintBase, "dev-feature/pricing");
    assert.equal(composerResolution.pathRepository.declaredAlias, "2.1.x-dev");
    assert.equal(pathLock.packages[0].version, composerResolution.pathRepository.resolvedVersion);
    assert.equal(pathLock.packages[0].source, undefined);
    assert.equal(composerResolution.pathRepository.resolvedSourceReference, undefined);
    assert.equal(composerResolution.pathRepository.resolvedSourceUrl, undefined);
    assert.equal(composerResolution.pathRepository.normalizedSourceUrl, undefined);
    assert.equal(composerResolution.pathRepository.resolvedSourceCommit, undefined);
    assert.equal(pathLock.packages[0].dist.type, "path");
    assert.equal(pathLock.packages[0].dist.reference, composerResolution.pathRepository.resolvedDistReference);
    assert.equal(pathLock.packages[0].dist.url, composerResolution.pathRepository.resolvedDistUrl);
    assert.equal(path.resolve(store.path, pathLock.packages[0].dist.url), composerResolution.pathRepository.resolvedPath);
    assert.equal(pathLock.aliases[0].alias, composerResolution.pathRepository.declaredAlias);
    assert.equal(pathLock.aliases[0].alias_normalized, "2.1.9999999.9999999-dev");
    const [pathCandidate, pathForkCandidate, pathComposerCandidate] = composerResolution.pathRepository.repositoryCandidates;
    assert.ok(pathCandidate && pathForkCandidate && pathComposerCandidate);
    assert.equal(pathCandidate.type, "path");
    assert.equal(pathCandidate.url, storeComposer.repositories[0].url);
    assert.equal(pathCandidate.resolvedPath, shared.path);
    assert.equal(pathCandidate.canonical, true);
    assert.equal(pathForkCandidate.type, "vcs");
    assert.equal(pathForkCandidate.normalizedUrl, "code.example.invalid/forks/commerce-fork");
    assert.equal(pathForkCandidate.canonical, false);
    assert.equal(pathComposerCandidate.type, "composer");
    assert.equal(pathComposerCandidate.normalizedUrl, "packages.example.invalid/custom");
    assert.equal(pathComposerCandidate.canonical, false);
    assert.equal(composerResolution.pathRepository.expected.resolution, "path");
    assert.equal(composerResolution.pathRepository.expected.resolutionMethod, "path");
    assert.equal(composerResolution.pathRepository.expected.indexedRepositoryId, "company-commerce");
    assert.equal(composerResolution.pathRepository.expected.indexedRevision, shared.head);
    assert.deepEqual(composerResolution.pathRepository.expected.resolutionEvidence, [`Canonical path ${shared.path} was used as repository identity`]);

    assert.equal(forkComposer.require["company/commerce"], composerResolution.customFork.declaredConstraint);
    assert.equal(composerResolution.customFork.declaredConstraintBase, "dev-fork/maintenance");
    assert.equal(composerResolution.customFork.declaredAlias, "1.0.x-dev");
    assert.equal(forkLock.packages[0].version, composerResolution.customFork.resolvedVersion);
    assert.equal(forkLock.packages[0].source.reference, composerResolution.customFork.resolvedSourceReference);
    assert.equal(forkLock.packages[0].source.url, composerResolution.customFork.resolvedSourceUrl);
    assert.equal(composerResolution.customFork.normalizedSourceUrl, "code.example.invalid/forks/commerce-fork");
    assert.equal(composerResolution.customFork.resolvedSourceCommit, shared.head);
    assert.equal(forkLock.packages[0].dist, null);
    assert.equal(composerResolution.customFork.resolvedDistReference, undefined);
    assert.equal(composerResolution.customFork.resolvedDistUrl, undefined);
    assert.equal(composerResolution.customFork.resolvedPath, undefined);
    assert.equal(forkLock.aliases[0].alias, composerResolution.customFork.declaredAlias);
    assert.equal(forkLock.aliases[0].alias_normalized, "1.0.9999999.9999999-dev");
    const [customVcsCandidate, customComposerCandidate] = composerResolution.customFork.repositoryCandidates;
    assert.ok(customVcsCandidate && customComposerCandidate);
    assert.equal(customVcsCandidate.url, forkComposer.repositories[0].url);
    assert.equal(customVcsCandidate.normalizedUrl, composerResolution.customFork.normalizedSourceUrl);
    assert.equal(customVcsCandidate.canonical, false);
    assert.equal(customComposerCandidate.url, forkComposer.repositories[1].url);
    assert.equal(customComposerCandidate.normalizedUrl, "packages.example.invalid/custom");
    assert.equal(customComposerCandidate.canonical, false);
    assert.equal(composerResolution.customFork.expected.resolution, "declared-only");
    assert.equal(composerResolution.customFork.expected.resolutionMethod, "unresolved");
    assert.equal(composerResolution.customFork.expected.indexedRepositoryId, undefined);
    assert.equal(composerResolution.customFork.expected.indexedRevision, undefined);
    assert.deepEqual(composerResolution.customFork.expected.resolutionEvidence, [
      "Normalized source URL code.example.invalid/forks/commerce-fork was used as repository identity",
      "No indexed repository matched the available identity evidence",
    ]);
    assert.match(composerResolution.customFork.limitations[0] ?? "", /candidate source, not proof.*selected/);
    assert.match(composerResolution.customFork.limitations[1] ?? "", /matching commit hash does not identify a fork/);
    assert.ok(composerResolution.identities.some((identity) => identity.kind === "declared-custom-repository" && !identity.indexed));
    assert.notEqual(composerResolution.pathRepository.consumerCommit, composerResolution.customFork.consumerCommit);

    const githubAssociations = manifest.expectations.githubAssociations;
    assert.equal(githubAssociations.sourceRepositoryUrl, shared.remoteUrl);
    assert.equal(githubAssociations.localInclusionPreserved, true);
    assert.deepEqual(githubAssociations.expectedWithoutCredentials.pullRequests, []);
    assert.deepEqual(githubAssociations.expectedWithoutCredentials.releases, []);
    assert.match(githubAssociations.expectedWithoutCredentials.limitations.join(" "), /no GitHub token/);
    assert.deepEqual(githubAssociations.expectedWithUnsupportedHost.pullRequests, []);
    assert.deepEqual(githubAssociations.expectedWithUnsupportedHost.releases, []);
    assert.match(githubAssociations.expectedWithUnsupportedHost.limitations.join(" "), /not a normalized GitHub repository/);
    assert.equal(githubAssociations.evidenceRequirements.pullRequest.confidence, "confirmed");
    assert.deepEqual(githubAssociations.evidenceRequirements.pullRequest.evidence, ["exact repository identity", "exact selected commit", "GitHub commit-to-pull-request API response"]);
    assert.match(githubAssociations.evidenceRequirements.pullRequest.limitations.join(" "), /does not by itself prove.*merged/);
    assert.equal(githubAssociations.evidenceRequirements.release.confidence, "possible");
    assert.deepEqual(githubAssociations.evidenceRequirements.release.evidence, ["exact repository identity", "exact local tag name and tag commit", "same-tag-name GitHub release API response"]);
    assert.match(githubAssociations.evidenceRequirements.release.limitations.join(" "), /remote tag object or commit was not independently verified/);
    assert.match(githubAssociations.partialFailure.expected, /successful local inclusion evidence/);
    assert.equal(githubAssociations.partialFailure.limitations.length, 2);

    const comparison = manifest.expectations.historicalComparison;
    assert.equal(comparison.protocolVersion, "1.0");
    assert.equal(comparison.mode, "impact");
    assert.deepEqual(Object.keys(comparison.before.revisions).sort(), ["client-reporting", "client-store", "company-commerce"]);
    assert.deepEqual(Object.keys(comparison.after.revisions).sort(), ["client-reporting", "client-store", "company-commerce"]);
    assert.deepEqual(comparison.before.revisions, {
      "company-commerce": shared.commits.introduction,
      "client-store": store.commits.initialConsumer,
      "client-reporting": reporting.commits.dependencyOnly,
    });
    assert.deepEqual(comparison.after.revisions, {
      "company-commerce": shared.head,
      "client-store": store.commits.impactSurface,
      "client-reporting": reporting.commits.dependencyUpdate,
    });
    assert.equal(comparison.before.selection.revision.commit, comparison.before.revisions[comparison.before.selection.revision.repositoryId]);
    assert.equal(comparison.after.selection.revision.commit, comparison.after.revisions[comparison.after.selection.revision.repositoryId]);
    assert.equal(comparison.before.selection.revision.dirty, false);
    assert.equal(comparison.after.selection.revision.dirty, false);

    const repositories = new Map(manifest.repositories.map((repository) => [repository.id, repository]));
    for (const side of [comparison.before, comparison.after]) {
      for (const [repositoryId, revision] of Object.entries(side.revisions)) {
        const fixtureRepository = repositories.get(repositoryId)!;
        assert.match(revision, /^[0-9a-f]{40}$/);
        assert.equal(git(fixtureRepository.path, ["cat-file", "-t", revision]), "commit");
      }
      for (const [repositoryId, references] of Object.entries(side.packageReferences)) {
        const fixtureRepository = repositories.get(repositoryId)!;
        assert.equal(lockedReference(fixtureRepository.path, side.revisions[repositoryId]!), references["company/commerce"]);
        assert.equal(references["company/commerce"], side.revisions["company-commerce"]);
      }
    }
    assert.notEqual(comparison.before.revisions["company-commerce"], shared.head);
    assert.notEqual(comparison.before.revisions["client-store"], store.head);
    assert.notEqual(comparison.after.revisions["client-reporting"], reporting.head);
    assert.equal(lockedReference(reporting.path, reporting.head), comparison.before.revisions["company-commerce"]);
    assert.equal(lockedReference(reporting.path, comparison.after.revisions["client-reporting"]!), comparison.after.revisions["company-commerce"]);
    assert.deepEqual(comparison.expectedRelationships.removed, [
      {
        identity: "edge|uses-trait|symbol|company-commerce|class|Company\\Commerce\\BaseOrder|symbol|company-commerce|trait|Company\\Commerce\\Support\\PricingRules",
        type: "uses-trait",
        source: "Company\\Commerce\\BaseOrder",
        target: "Company\\Commerce\\Support\\PricingRules",
      },
    ]);
    assert.ok(comparison.expectedRelationships.added.some((edge) => edge.type === "calls" && edge.source.endsWith("CheckoutService::quote") && edge.target.endsWith("BaseOrder::price")));
    assert.ok(comparison.expectedRelationships.added.some((edge) => edge.type === "declares" && edge.target.endsWith("BaseOrder::fixtureMarker")));
    assert.deepEqual(comparison.expectedRelationships.changed.map((edge) => edge.identity), [
      "edge|requires|project|client-store|package|company/commerce",
      "edge|requires|project|client-reporting|package|company/commerce",
    ]);
    assert.ok(comparison.expectedRelationships.changed.every((edge) => edge.changedFields.join(",") === "evidence,resolvedSourceCommit"));
    assert.ok(comparison.expectedRelationships.changed.every((edge) => edge.before.sourceCommit !== edge.after.sourceCommit || edge.before.targetCommit !== edge.after.targetCommit));
    assert.match(comparison.limitations.join(" "), /fail comparison rather than fall back/i);

    const historyEvidence = manifest.expectations.historyEvidence;
    assert.deepEqual(historyEvidence.lineage, {
      commit: shared.commits.moveRename,
      events: [
        {
          category: "move",
          fromPath: "src/Support/PricingRules.php",
          toPath: "src/Support/PricingMath.php",
          fromSymbol: "Company\\Commerce\\Support\\PricingRules::applyDiscount",
          toSymbol: "Company\\Commerce\\Support\\PricingMath::discountedSubtotal",
          confidence: "possible",
          evidence: [
            {
              repositoryId: "company-commerce",
              commit: shared.commits.moveRename,
              path: "src/Support/PricingMath.php",
              resolutionMethod: "git-rename-diff",
              confidence: "confirmed",
              detail: "Git rename detection maps src/Support/PricingRules.php to src/Support/PricingMath.php",
              limitations: [],
            },
            {
              repositoryId: "company-commerce",
              commit: shared.commits.moveRename,
              path: "src/Support/PricingMath.php",
              resolutionMethod: "syntax-fingerprint-and-git-change",
              confidence: "possible",
              detail: "A unique method preserved its syntax-aware implementation fingerprint and structural contract across the moved Git file",
              limitations: ["Static equivalence establishes continuity but cannot prove the author's naming intent"],
            },
          ],
          limitations: [],
        },
        {
          category: "rename",
          fromPath: "src/Support/PricingRules.php",
          toPath: "src/Support/PricingMath.php",
          fromSymbol: "Company\\Commerce\\Support\\PricingRules::applyDiscount",
          toSymbol: "Company\\Commerce\\Support\\PricingMath::discountedSubtotal",
          confidence: "possible",
          evidence: [{
            repositoryId: "company-commerce",
            commit: shared.commits.moveRename,
            path: "src/Support/PricingMath.php",
            resolutionMethod: "syntax-fingerprint-and-git-change",
            confidence: "possible",
            detail: "A unique method preserved its syntax-aware implementation fingerprint and structural contract in a Git-changed file",
            limitations: ["Static equivalence establishes continuity but cannot prove the author's naming intent"],
          }],
          limitations: ["Static equivalence establishes continuity but cannot prove the author's naming intent"],
        },
      ],
    });
    assert.notEqual(historyEvidence.equivalence.originalCommit, historyEvidence.equivalence.cherryPickCommit);
    assert.equal(stablePatchId(shared.path, historyEvidence.equivalence.originalCommit), historyEvidence.equivalence.patchId);
    assert.equal(stablePatchId(shared.path, historyEvidence.equivalence.cherryPickCommit), historyEvidence.equivalence.patchId);
    assert.equal(git(shared.path, ["rev-parse", `${historyEvidence.equivalence.cherryPickCommit}^`]), shared.commits.equivalenceBranchBase);
    assert.match(git(shared.path, ["branch", "--contains", historyEvidence.equivalence.cherryPickCommit]), /equivalent\/discount/);
    assert.equal(historyEvidence.equivalence.expected.state, "likely-equivalent");
    assert.equal(historyEvidence.equivalence.expected.activeBehaviour, "likely-active");
    assert.deepEqual(historyEvidence.equivalence.expectedReleaseAssessment, {
      release: "v1.1.0-equivalent",
      revision: shared.commits.equivalentCherryPick,
      state: "likely-equivalent",
      activeBehaviour: "likely-active",
      basisCommit: shared.commits.equivalentCherryPick,
      equivalentCommit: shared.commits.equivalentCherryPick,
      lastMatchingCommit: shared.commits.equivalentCherryPick,
      evidenceResolutionMethods: ["git-commit-ancestry", "git-patch-id-stable", "git-patch-id-reachable-order"],
      limitations: [],
    });
    assert.equal(shared.tags["v1.1.0-equivalent"], shared.commits.equivalentCherryPick);
    assert.equal(git(shared.path, ["rev-parse", "main"]), shared.commits.activityReapply);
    assert.match(git(shared.path, ["show", `${shared.commits.activityChange}:src/BaseOrder.php`]), /fixtureMarker/);
    assert.doesNotMatch(git(shared.path, ["show", `${shared.commits.activityRevert}:src/BaseOrder.php`]), /fixtureMarker/);
    assert.match(git(shared.path, ["show", `${shared.commits.activityReapply}:src/BaseOrder.php`]), /fixtureMarker/);
    assert.match(git(shared.path, ["show", "-s", "--format=%B", shared.commits.activityRevert!]), new RegExp(`This reverts commit ${shared.commits.activityChange}`));
    assert.match(git(shared.path, ["show", "-s", "--format=%B", shared.commits.activityReapply!]), new RegExp(`This reverts commit ${shared.commits.activityRevert}`));
    assert.deepEqual(historyEvidence.activity.map(({ name, activeBehaviour }) => ({ name, activeBehaviour })), [
      { name: "regression-reverted-at-head", activeBehaviour: "reverted" },
      { name: "marker-originally-active", activeBehaviour: "likely-active" },
      { name: "marker-reverted", activeBehaviour: "reverted" },
      { name: "marker-reapplied-at-head", activeBehaviour: "likely-active" },
      { name: "unavailable-basis", activeBehaviour: "unknown" },
    ]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("reproduces commit, tag, and expectation identities", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "trace-fixtures-deterministic-"));
  try {
    const first = await generateFixtures(path.join(parent, "first"));
    const second = await generateFixtures(path.join(parent, "second"));
    assert.deepEqual(
      first.repositories.map(({ id, head, commits, tags }) => ({ id, head, commits, tags })),
      second.repositories.map(({ id, head, commits, tags }) => ({ id, head, commits, tags })),
    );
    assert.deepEqual(normalizedExpectations(first.expectations), normalizedExpectations(second.expectations));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("refuses to overwrite a non-empty fixture destination", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "trace-fixtures-guard-"));
  try {
    await generateFixtures(path.join(parent, "generated"));
    await assert.rejects(generateFixtures(path.join(parent, "generated")), /must be empty/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
