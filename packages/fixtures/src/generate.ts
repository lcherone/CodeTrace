import { execFileSync } from "node:child_process";
import { mkdir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type FixtureCommitMap = Record<string, string>;

interface FixtureComparisonSelection {
  repositoryPath: string;
  relativePath: string;
  revision: { repositoryId: string; commit: string; dirty: false };
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  selectedText: string;
}

export interface FixtureHistoricalComparison {
  id: string;
  description: string;
  protocolVersion: "1.0";
  mode: "impact";
  before: {
    revisions: Record<string, string>;
    selection: FixtureComparisonSelection;
    packageReferences: Record<string, Record<string, string>>;
  };
  after: {
    revisions: Record<string, string>;
    selection: FixtureComparisonSelection;
    packageReferences: Record<string, Record<string, string>>;
  };
  expectedRelationships: {
    added: Array<{ identity: string; type: string; source: string; target: string }>;
    removed: Array<{ identity: string; type: string; source: string; target: string }>;
    changed: Array<{
      identity: string;
      type: string;
      source: string;
      target: string;
      changedFields: string[];
      before: { sourceCommit: string; targetCommit: string };
      after: { sourceCommit: string; targetCommit: string };
    }>;
  };
  limitations: string[];
}

export interface FixtureHistoryEvidence {
  lineage: {
    commit: string;
    events: Array<{
      category: "move" | "rename";
      fromPath: string;
      toPath: string;
      fromSymbol: string;
      toSymbol: string;
      confidence: "confirmed" | "possible";
      evidence: Array<{
        repositoryId: string;
        commit: string;
        path: string;
        resolutionMethod: string;
        confidence: "confirmed" | "possible";
        detail: string;
        limitations: string[];
      }>;
      limitations: string[];
    }>;
  };
  equivalence: {
    originalCommit: string;
    cherryPickCommit: string;
    branch: string;
    patchId: string;
    expected: {
      state: "likely-equivalent";
      activeBehaviour: "likely-active";
      basisCommit: string;
      equivalentCommit: string;
      lastMatchingCommit: string;
      evidenceResolutionMethods: string[];
      limitations: string[];
    };
    expectedReleaseAssessment: {
      release: string;
      revision: string;
      state: "likely-equivalent";
      activeBehaviour: "likely-active";
      basisCommit: string;
      equivalentCommit: string;
      lastMatchingCommit: string;
      evidenceResolutionMethods: string[];
      limitations: string[];
    };
    limitations: string[];
  };
  activity: Array<{
    name: string;
    selectedChangeCommit: string;
    basisCommit: string;
    activeBehaviour: "likely-active" | "reverted" | "unknown";
    revertCommit?: string;
    lastMatchingCommit?: string;
    evidenceResolutionMethods: string[];
    limitations: string[];
  }>;
  unavailableCommit: string;
}

export interface FixtureComposerResolution {
  packageName: string;
  branchAliases: Record<string, string>;
  identities: Array<{
    kind: "indexed-repository" | "consumer-repository" | "declared-custom-repository";
    repositoryId: string;
    packageName?: string;
    repositoryUrl?: string;
    indexed: boolean;
  }>;
  pathRepository: {
    consumerRepositoryId: string;
    consumerCommit: string;
    declaredConstraint: string;
    declaredConstraintBase: string;
    declaredAlias: string;
    resolvedVersion: string;
    resolvedSourceReference?: string;
    resolvedSourceUrl?: string;
    normalizedSourceUrl?: string;
    resolvedSourceCommit?: string;
    resolvedDistReference: string;
    resolvedDistUrl: string;
    resolvedPath: string;
    repositoryCandidates: Array<{ type: string; url?: string; normalizedUrl?: string; resolvedPath?: string; canonical: boolean; packageName?: string }>;
    expected: { resolution: "path"; resolutionMethod: "path"; indexedRepositoryId: string; indexedRevision: string; resolutionEvidence: string[] };
  };
  customFork: {
    consumerRepositoryId: string;
    consumerCommit: string;
    declaredConstraint: string;
    declaredConstraintBase: string;
    declaredAlias: string;
    resolvedVersion: string;
    resolvedSourceReference: string;
    resolvedSourceUrl: string;
    normalizedSourceUrl: string;
    resolvedSourceCommit: string;
    resolvedDistReference?: string;
    resolvedDistUrl?: string;
    resolvedPath?: string;
    repositoryCandidates: Array<{ type: string; url?: string; normalizedUrl?: string; resolvedPath?: string; canonical: boolean; packageName?: string }>;
    expected: { resolution: "declared-only"; resolutionMethod: "unresolved"; indexedRepositoryId?: string; indexedRevision?: string; resolutionEvidence: string[] };
    limitations: string[];
  };
}

export interface FixtureGitHubAssociationBoundary {
  sourceRepositoryUrl: string;
  localInclusionPreserved: true;
  expectedWithoutCredentials: { pullRequests: []; releases: []; limitations: string[] };
  expectedWithUnsupportedHost: { pullRequests: []; releases: []; limitations: string[] };
  evidenceRequirements: {
    pullRequest: { confidence: "confirmed"; evidence: string[]; limitations: string[] };
    release: { confidence: "possible"; evidence: string[]; limitations: string[] };
  };
  partialFailure: {
    expected: string;
    limitations: string[];
  };
}

export interface FixtureReceiverInference {
  repositoryId: string;
  commit: string;
  path: string;
  targetMethod: string;
  cases: Array<{
    id: string;
    caller: string;
    expression: string;
    methodName?: string;
    status: "resolved" | "ambiguous" | "unresolved" | "dynamic";
    candidateTypes: string[];
    resolutionMethod: "native-property" | "promoted-property" | "constructor-assignment" | "local-new" | "variable-alias" | "method-return" | "native-parameter" | "phpdoc-parameter" | "invalidated" | "dynamic-method" | "container-lookup" | "runtime-class-string" | "reflection" | "magic-call";
    confidence: "confirmed" | "possible" | "unresolved";
    expectedCallTargets: string[];
    limitations: string[];
  }>;
}

export interface FixtureManifest {
  generatedAt: string;
  repositories: Array<{
    id: string;
    path: string;
    packageName: string;
    remoteUrl?: string;
    head: string;
    commits: FixtureCommitMap;
    tags: Record<string, string>;
  }>;
  expectations: {
    packageName: string;
    focusSymbol: string;
    dependencyOnlyConsumer: string;
    confirmedUsageConsumer: string;
    olderConsumerReference: string;
    newerConsumerReference: string;
    revertedCommit: string;
    examples: {
      nativeTypeMethod: string;
      phpDocTypeMethod: string;
      interfaceContract: string;
      trait: string;
      lateStaticMethod: string;
      inheritedWithoutOverride: string;
      overrideWithoutParentCall: string;
      overrideCallingParent: string;
      directCaller: string;
      impactCaller: string;
      dynamicCaller: string;
      unresolvedCaller: string;
    };
    historyCategories: string[];
    historicalComparison: FixtureHistoricalComparison;
    historyEvidence: FixtureHistoryEvidence;
    composerResolution: FixtureComposerResolution;
    githubAssociations: FixtureGitHubAssociationBoundary;
    receiverInference: FixtureReceiverInference;
  };
}

const EPOCH = Date.parse("2024-01-01T09:00:00Z");
let commitSequence = 0;

function git(repository: string, args: string[], dated = false): string {
  const commitDate = new Date(EPOCH + commitSequence * 86_400_000).toISOString();
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Trace Fixture",
    GIT_AUTHOR_EMAIL: "trace-fixture@example.invalid",
    GIT_COMMITTER_NAME: "Trace Fixture",
    GIT_COMMITTER_EMAIL: "trace-fixture@example.invalid",
    ...(dated ? { GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate } : {}),
  };
  const result = execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (dated) commitSequence += 1;
  return result;
}

async function write(repository: string, relativePath: string, contents: string): Promise<void> {
  const target = path.join(repository, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

async function initialise(repository: string): Promise<void> {
  await mkdir(repository, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repository], { stdio: "ignore" });
  git(repository, ["config", "user.name", "Trace Fixture"]);
  git(repository, ["config", "user.email", "trace-fixture@example.invalid"]);
  git(repository, ["config", "commit.gpgSign", "false"]);
  git(repository, ["config", "core.autocrlf", "false"]);
  const actualRoot = git(repository, ["rev-parse", "--show-toplevel"]);
  const [canonicalRoot, canonicalRepository] = await Promise.all([realpath(actualRoot), realpath(repository)]);
  if (canonicalRoot !== canonicalRepository) {
    throw new Error(`Refusing to write fixture commits outside ${repository}`);
  }
}

function commit(repository: string, message: string): string {
  git(repository, ["add", "--all"]);
  git(repository, ["commit", "-m", message], true);
  return git(repository, ["rev-parse", "HEAD"]);
}

function tag(repository: string, name: string): string {
  git(repository, ["tag", name]);
  return git(repository, ["rev-list", "-n", "1", name]);
}

function stablePatchId(repository: string, commitId: string): string {
  const patch = execFileSync("git", ["-C", repository, "show", "--pretty=format:", "--binary", commitId]);
  return execFileSync("git", ["-C", repository, "patch-id", "--stable"], {
    input: patch,
    encoding: "utf8",
  }).trim().split(/\s+/)[0] ?? "";
}

function composerPackageJson(): string {
  return `${JSON.stringify({
    name: "company/commerce",
    description: "Shared commerce package used by Trace fixtures",
    type: "library",
    autoload: { "psr-4": { "Company\\Commerce\\": "src/" } },
    require: { php: ">=8.1" },
    extra: { "branch-alias": { "dev-main": "2.0.x-dev", "dev-feature/pricing": "2.1.x-dev" } },
  }, null, 2)}\n`;
}

function baseOrderSource(options: { implementation: "initial" | "discount" | "bad"; documented?: boolean; formatted?: boolean; signature?: boolean; renamedTrait?: boolean; unrelated?: boolean; showcase?: boolean; marker?: boolean }): string {
  const trait = options.renamedTrait ? "PricingMath" : "PricingRules";
  const operation = options.renamedTrait ? "discountedSubtotal" : "applyDiscount";
  const signature = options.signature ? "bool $includeTax = true" : "";
  const calculation = options.implementation === "initial"
    ? "return $this->subtotal;"
    : options.implementation === "bad"
      ? "return 0; // deliberately reverted fixture change"
      : `return $this->${operation}($this->subtotal);`;
  const body = options.formatted ? `\n        ${calculation}\n` : `\n        ${calculation}\n    `;
  const unrelated = options.unrelated ? `\n    public function currency(): string\n    {\n        return 'GBP';\n    }\n` : "";
  const documentation = options.documented ? `
    /**
     * Calculate the payable total for the stored order.
     *
     * Applies the shared fictional discount policy.
     *
     * @return int The payable amount in minor units.
     */
` : "";
  const showcaseImports = options.showcase ? `use Company\\Commerce\\Value\\Money;
use Company\\Commerce\\Value\\PriceContext;
` : "";
  const showcase = options.showcase ? `
    /**
     * Price an order using an explicit context.
     *
     * This demonstrates native types, interface provenance, trait-backed
     * behaviour and late-static dispatch in one focusable symbol.
     *
     * @param PriceContext $context Rules and currency for the calculation.
     * @return Money The final payable amount.
     */
    public function price(PriceContext $context): Money
    {
        return $this->priceSubtotal($this->subtotal, $context, static::currencyCode());
    }

    /** Create the concrete runtime order class. */
    public static function create(int $subtotal): static
    {
        return new static($subtotal);
    }

    protected static function currencyCode(): string
    {
        return 'GBP';
    }
` : "";
  const marker = options.marker ? `
    /** Harmless marker used to demonstrate an exact revert and reapply. */
    public function fixtureMarker(): string
    {
        return 'trace-fixture';
    }
` : "";
  return `<?php

declare(strict_types=1);

namespace Company\\Commerce;

use Company\\Commerce\\Contracts\\PricedOrder;
use Company\\Commerce\\Support\\${trait};
${showcaseImports}

abstract class BaseOrder implements PricedOrder
{
    use ${trait};

    public function __construct(protected int $subtotal)
    {
    }

${documentation}    public function calculateTotal(${signature}): int
    {${body}}
${unrelated}${showcase}${marker}}
`;
}

function traitSource(renamed: boolean, showcase = false): string {
  const trait = renamed ? "PricingMath" : "PricingRules";
  const method = renamed ? "discountedSubtotal" : "applyDiscount";
  const showcaseImports = showcase ? `
use Company\\Commerce\\Value\\Money;
use Company\\Commerce\\Value\\PriceContext;
` : "";
  const showcaseMethod = showcase ? `
    /** Build a currency-safe result from the shared discount arithmetic. */
    protected function priceSubtotal(int $subtotal, PriceContext $context, string $currency): Money
    {
        return new Money(max(0, $subtotal - $context->discountMinorUnits), $currency);
    }
` : "";
  return `<?php

declare(strict_types=1);

namespace Company\\Commerce\\Support;
${showcaseImports}
/** Reusable promotion arithmetic for fictional order implementations. */
trait ${trait}
{
    protected function ${method}(int $subtotal): int
    {
        return max(0, $subtotal - 100);
    }
${showcaseMethod}}
`;
}

function showcaseContractSource(): string {
  return `<?php

declare(strict_types=1);

namespace Company\\Commerce\\Contracts;

use Company\\Commerce\\Value\\Money;
use Company\\Commerce\\Value\\PriceContext;

/** Defines the public pricing contract for fictional orders. */
interface PricedOrder
{
    public function calculateTotal(bool $includeTax = true): int;

    /**
     * Price an order for the supplied context.
     *
     * @param PriceContext $context Rules and currency for the calculation.
     * @return Money The final payable amount.
     */
    public function price(PriceContext $context): Money;
}
`;
}

function moneySource(): string {
  return `<?php

declare(strict_types=1);

namespace Company\\Commerce\\Value;

/** Immutable fictional monetary result. */
final readonly class Money
{
    public function __construct(public int $minorUnits, public string $currency)
    {
    }
}
`;
}

function priceContextSource(): string {
  return `<?php

declare(strict_types=1);

namespace Company\\Commerce\\Value;

/** Rules and currency supplied to a pricing operation. */
final readonly class PriceContext
{
    public function __construct(public int $discountMinorUnits = 100)
    {
    }
}
`;
}

function legacyAdapterSource(): string {
  return `<?php

declare(strict_types=1);

namespace Company\\Commerce\\Legacy;

use Company\\Commerce\\Value\\Money;
use Company\\Commerce\\Value\\PriceContext;

/** Documents an integration that cannot add native type declarations yet. */
final class LegacyPriceAdapter
{
    /**
     * Copy an externally supplied pricing result.
     *
     * PHPDoc-only types are possible evidence, not runtime enforcement.
     *
     * @param PriceContext $context Legacy pricing input.
     * @return Money Legacy monetary output.
     */
    public function copy($context)
    {
        return new Money(0, 'GBP');
    }
}
`;
}

async function buildSharedPackage(repository: string): Promise<{ commits: FixtureCommitMap; tags: Record<string, string>; head: string; revertedCommit: string }> {
  await initialise(repository);
  const commits: FixtureCommitMap = {};
  const tags: Record<string, string> = {};

  await write(repository, "composer.json", composerPackageJson());
  await write(repository, "src/Contracts/PricedOrder.php", `<?php

declare(strict_types=1);

namespace Company\\Commerce\\Contracts;

interface PricedOrder
{
    public function calculateTotal(): int;
}
`);
  await write(repository, "src/Support/PricingRules.php", traitSource(false));
  await write(repository, "src/BaseOrder.php", baseOrderSource({ implementation: "initial" }));
  await write(repository, "src/RegionalOrder.php", `<?php

declare(strict_types=1);

namespace Company\\Commerce;

abstract class RegionalOrder extends BaseOrder
{
    // Intentionally does not redeclare calculateTotal.
}
`);
  await write(repository, "src/StandardOrder.php", `<?php

declare(strict_types=1);

namespace Company\\Commerce;

final class StandardOrder extends RegionalOrder
{
    // Inherits calculateTotal through an intermediate parent.
}
`);
  await write(repository, "src/WholesaleOrder.php", `<?php

declare(strict_types=1);

namespace Company\\Commerce;

final class WholesaleOrder extends RegionalOrder
{
    public function calculateTotal(): int
    {
        return 500; // Override deliberately does not call the parent.
    }
}
`);
  commits.introduction = commit(repository, "Introduce BaseOrder calculateTotal");
  tags["v1.0.0"] = tag(repository, "v1.0.0");

  await write(repository, "src/BaseOrder.php", baseOrderSource({ implementation: "discount" }));
  commits.implementation = commit(repository, "Apply shared discounts to order totals");
  tags["v1.1.0"] = tag(repository, "v1.1.0");

  await write(repository, "src/BaseOrder.php", baseOrderSource({ implementation: "discount", documented: true }));
  commits.documentation = commit(repository, "Document calculateTotal behaviour");

  await write(repository, "src/BaseOrder.php", baseOrderSource({ implementation: "discount", documented: true, unrelated: true }));
  commits.unrelated = commit(repository, "Add currency metadata beside total calculation");

  await write(repository, "src/BaseOrder.php", baseOrderSource({ implementation: "discount", documented: true, unrelated: true, formatted: true }));
  commits.formatting = commit(repository, "Format BaseOrder without changing behaviour");

  await rename(path.join(repository, "src/Support/PricingRules.php"), path.join(repository, "src/Support/PricingMath.php"));
  await write(repository, "src/Support/PricingMath.php", traitSource(true));
  await write(repository, "src/BaseOrder.php", baseOrderSource({ implementation: "discount", documented: true, unrelated: true, formatted: true, renamedTrait: true }));
  commits.moveRename = commit(repository, "Move and rename pricing trait method");

  await write(repository, "src/Contracts/PricedOrder.php", `<?php

declare(strict_types=1);

namespace Company\\Commerce\\Contracts;

interface PricedOrder
{
    public function calculateTotal(bool $includeTax = true): int;
}
`);
  await write(repository, "src/BaseOrder.php", baseOrderSource({ implementation: "discount", documented: true, unrelated: true, formatted: true, signature: true, renamedTrait: true }));
  await write(repository, "src/WholesaleOrder.php", `<?php

declare(strict_types=1);

namespace Company\\Commerce;

final class WholesaleOrder extends RegionalOrder
{
    public function calculateTotal(bool $includeTax = true): int
    {
        return 500; // Override deliberately does not call the parent.
    }
}
`);
  commits.signature = commit(repository, "Add tax option to calculateTotal contract");

  await write(repository, "src/Contracts/PricedOrder.php", showcaseContractSource());
  await write(repository, "src/Support/PricingMath.php", traitSource(true, true));
  await write(repository, "src/BaseOrder.php", baseOrderSource({ implementation: "discount", documented: true, unrelated: true, formatted: true, signature: true, renamedTrait: true, showcase: true }));
  await write(repository, "src/Value/Money.php", moneySource());
  await write(repository, "src/Value/PriceContext.php", priceContextSource());
  await write(repository, "src/Legacy/LegacyPriceAdapter.php", legacyAdapterSource());
  commits.analysisSurface = commit(repository, "Add rich pricing analysis examples");
  tags["v2.0.0"] = tag(repository, "v2.0.0");

  git(repository, ["switch", "-c", "release/1.x", "v1.1.0"]);
  await write(repository, "RELEASE_BRANCH.md", "This commit exists only on the parallel 1.x release branch.\n");
  commits.parallelRelease = commit(repository, "Document parallel 1.x release branch");
  tags["v1.1.1"] = tag(repository, "v1.1.1");
  git(repository, ["switch", "main"]);

  await write(repository, "src/BaseOrder.php", baseOrderSource({ implementation: "bad", documented: true, unrelated: true, formatted: true, signature: true, renamedTrait: true, showcase: true }));
  commits.revertedChange = commit(repository, "Regress total calculation for revert fixture");
  git(repository, ["revert", "--no-edit", commits.revertedChange], true);
  commits.revert = git(repository, ["rev-parse", "HEAD"]);

  await write(repository, "src/BaseOrder.php", baseOrderSource({ implementation: "discount", documented: true, unrelated: true, formatted: true, signature: true, renamedTrait: true, showcase: true, marker: true }));
  commits.activityChange = commit(repository, "Add fixture activity marker");
  git(repository, ["revert", "--no-edit", commits.activityChange], true);
  commits.activityRevert = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["revert", "--no-edit", commits.activityRevert], true);
  commits.activityReapply = git(repository, ["rev-parse", "HEAD"]);
  tags["v2.0.1"] = tag(repository, "v2.0.1");

  git(repository, ["switch", "-c", "equivalent/discount", commits.introduction!]);
  await write(repository, "EQUIVALENCE_BRANCH.md", "This unrelated branch base forces a distinct cherry-pick commit identity.\n");
  commits.equivalenceBranchBase = commit(repository, "Add equivalence branch marker");
  git(repository, ["cherry-pick", commits.implementation!], true);
  commits.equivalentCherryPick = git(repository, ["rev-parse", "HEAD"]);
  tags["v1.1.0-equivalent"] = tag(repository, "v1.1.0-equivalent");
  git(repository, ["switch", "main"]);

  return { commits, tags, head: git(repository, ["rev-parse", "HEAD"]), revertedCommit: commits.revertedChange };
}

function lockFile(reference: string, version: string, options: { sourceUrl?: string; pathUrl?: string; alias?: string } = {}): string {
  const lockedPackage = {
    name: "company/commerce",
    version,
    ...(options.pathUrl
      ? { dist: { type: "path", url: options.pathUrl, reference } }
      : { source: { type: "git", url: options.sourceUrl ?? "https://code.example.invalid/company/commerce.git", reference }, dist: null }),
    type: "library",
    autoload: { "psr-4": { "Company\\Commerce\\": "src/" } },
    "require-dev": {},
  };
  return `${JSON.stringify({
    _readme: ["Trace fixture lock file; generated deterministically."],
    "content-hash": "trace-fixture",
    packages: [lockedPackage],
    "packages-dev": [],
    aliases: options.alias ? [{ package: "company/commerce", version, alias: options.alias, "alias_normalized": options.alias.replace("x-dev", "9999999.9999999-dev") }] : [],
    "minimum-stability": options.alias ? "dev" : "stable",
    "stability-flags": {},
    "prefer-stable": false,
    "prefer-lowest": false,
    "platform": {},
    "platform-dev": {},
    "plugin-api-version": "2.6.0",
  }, null, 2)}\n`;
}

function receiverInferenceSource(): string {
  return `<?php

declare(strict_types=1);

namespace Client\\Store;

use Company\\Commerce\\BaseOrder;
use Company\\Commerce\\StandardOrder as DefaultOrder;
use Company\\Commerce\\Value\\Money;
use Company\\Commerce\\Value\\PriceContext;
use LogicException;
use ReflectionClass;

/** Native property type is sufficient even when construction happens elsewhere. */
final class NativePropertyCheckout
{
    public BaseOrder $order;

    public function quote(PriceContext $context): Money
    {
        return $this->order->price($context);
    }
}

/** Constructor promotion supplies both the property and its native type. */
final class PromotedPropertyCheckout
{
    public function __construct(private BaseOrder $order)
    {
    }

    public function quote(PriceContext $context): Money
    {
        return $this->order->price($context);
    }
}

/** A legacy untyped property receives a typed constructor parameter once. */
final class AssignedPropertyCheckout
{
    private $order;

    public function __construct(BaseOrder $order)
    {
        $this->order = $order;
    }

    public function quote(PriceContext $context): Money
    {
        return $this->order->price($context);
    }
}

final class RetailPriceGateway
{
    public function price(PriceContext $context): Money
    {
        return new Money(1200 - $context->discountMinorUnits, 'GBP');
    }
}

final class WholesalePriceGateway
{
    public function price(PriceContext $context): Money
    {
        return new Money(1100 - $context->discountMinorUnits, 'GBP');
    }
}

interface FixtureContainer
{
    public function get(string $id): object;

    public function make(string $id): object;

    public function resolve(string $id): object;
}

/** A magic proxy deliberately has no declared price method. */
final class MagicOrderProxy
{
    public function __call(string $name, array $arguments): mixed
    {
        throw new LogicException('Fixture magic calls are never executed.');
    }
}

/** Focusable receiver-inference examples; none of these methods execute in Trace. */
final class ReceiverInferenceShowcase
{
    public function localNew(PriceContext $context): Money
    {
        $order = new DefaultOrder(1200);
        return $order->price($context);
    }

    public function variableAlias(PriceContext $context): Money
    {
        $order = new DefaultOrder(1200);
        $selectedOrder = $order;
        return $selectedOrder->price($context);
    }

    public function factoryReturn(PriceContext $context): Money
    {
        return $this->makeOrder()->price($context);
    }

    private function makeOrder(): BaseOrder
    {
        return new DefaultOrder(1200);
    }

    public function unionReceiver(RetailPriceGateway|WholesalePriceGateway $gateway, PriceContext $context): Money
    {
        return $gateway->price($context);
    }

    /**
     * @param BaseOrder $order A receiver known only through PHPDoc.
     */
    public function phpDocReceiver($order, PriceContext $context): Money
    {
        return $order->price($context);
    }

    public function reassignedReceiver(BaseOrder $order, object $replacement, PriceContext $context): mixed
    {
        $order = $replacement;
        return $order->price($context);
    }

    public function dynamicMethod(BaseOrder $order, string $method, PriceContext $context): mixed
    {
        return $order->{$method}($context);
    }

    public function containerGet(FixtureContainer $container, PriceContext $context): mixed
    {
        return $container->get(BaseOrder::class)->price($context);
    }

    public function containerMake(FixtureContainer $container, PriceContext $context): mixed
    {
        return $container->make(BaseOrder::class)->price($context);
    }

    public function containerResolve(FixtureContainer $container, PriceContext $context): mixed
    {
        return $container->resolve(BaseOrder::class)->price($context);
    }

    /** @param class-string<BaseOrder> $class */
    public function runtimeClassString(string $class, PriceContext $context): mixed
    {
        $order = new $class(1200);
        return $order->price($context);
    }

    /** @param ReflectionClass<BaseOrder> $reflection */
    public function reflectionFactory(ReflectionClass $reflection, PriceContext $context): mixed
    {
        $order = $reflection->newInstance(1200);
        return $order->price($context);
    }

    public function magicFallback(MagicOrderProxy $proxy, PriceContext $context): mixed
    {
        return $proxy->price($context);
    }
}
`;
}

function receiverInferenceExpectation(commit: string): FixtureReceiverInference {
  const baseOrder = "Company\\Commerce\\BaseOrder";
  const basePrice = `${baseOrder}::price`;
  const local = "Client\\Store";
  return {
    repositoryId: "client-store",
    commit,
    path: "src/ReceiverInferenceShowcase.php",
    targetMethod: basePrice,
    cases: [
      { id: "native-property", caller: `${local}\\NativePropertyCheckout::quote`, expression: "$this->order", methodName: "price", status: "resolved", candidateTypes: [baseOrder], resolutionMethod: "native-property", confidence: "confirmed", expectedCallTargets: [basePrice], limitations: [] },
      { id: "promoted-property", caller: `${local}\\PromotedPropertyCheckout::quote`, expression: "$this->order", methodName: "price", status: "resolved", candidateTypes: [baseOrder], resolutionMethod: "promoted-property", confidence: "confirmed", expectedCallTargets: [basePrice], limitations: [] },
      { id: "constructor-assignment", caller: `${local}\\AssignedPropertyCheckout::quote`, expression: "$this->order", methodName: "price", status: "resolved", candidateTypes: [baseOrder], resolutionMethod: "constructor-assignment", confidence: "confirmed", expectedCallTargets: [basePrice], limitations: [] },
      { id: "local-new-import-alias", caller: `${local}\\ReceiverInferenceShowcase::localNew`, expression: "$order", methodName: "price", status: "resolved", candidateTypes: ["Company\\Commerce\\StandardOrder"], resolutionMethod: "local-new", confidence: "confirmed", expectedCallTargets: [basePrice], limitations: [] },
      { id: "variable-alias", caller: `${local}\\ReceiverInferenceShowcase::variableAlias`, expression: "$selectedOrder", methodName: "price", status: "resolved", candidateTypes: ["Company\\Commerce\\StandardOrder"], resolutionMethod: "variable-alias", confidence: "confirmed", expectedCallTargets: [basePrice], limitations: [] },
      { id: "typed-factory-return", caller: `${local}\\ReceiverInferenceShowcase::factoryReturn`, expression: "$this->makeOrder()", methodName: "price", status: "resolved", candidateTypes: [baseOrder], resolutionMethod: "method-return", confidence: "confirmed", expectedCallTargets: [basePrice], limitations: [] },
      { id: "native-union", caller: `${local}\\ReceiverInferenceShowcase::unionReceiver`, expression: "$gateway", methodName: "price", status: "ambiguous", candidateTypes: [`${local}\\RetailPriceGateway`, `${local}\\WholesalePriceGateway`], resolutionMethod: "native-parameter", confidence: "possible", expectedCallTargets: [`${local}\\RetailPriceGateway::price`, `${local}\\WholesalePriceGateway::price`], limitations: ["Receiver type RetailPriceGateway|WholesalePriceGateway has multiple statically possible candidates"] },
      { id: "phpdoc-only", caller: `${local}\\ReceiverInferenceShowcase::phpDocReceiver`, expression: "$order", methodName: "price", status: "resolved", candidateTypes: [baseOrder], resolutionMethod: "phpdoc-parameter", confidence: "possible", expectedCallTargets: [basePrice], limitations: ["Receiver type comes from PHPDoc and is not enforced by PHP"] },
      { id: "reassignment-invalidation", caller: `${local}\\ReceiverInferenceShowcase::reassignedReceiver`, expression: "$order", methodName: "price", status: "unresolved", candidateTypes: [], resolutionMethod: "invalidated", confidence: "unresolved", expectedCallTargets: [], limitations: ["Receiver was reassigned from a known native type to an unknown object value"] },
      { id: "dynamic-method-name", caller: `${local}\\ReceiverInferenceShowcase::dynamicMethod`, expression: "$order", status: "dynamic", candidateTypes: [baseOrder], resolutionMethod: "dynamic-method", confidence: "unresolved", expectedCallTargets: [], limitations: ["Dynamic method names cannot be matched to a declared method"] },
      { id: "container-get", caller: `${local}\\ReceiverInferenceShowcase::containerGet`, expression: "$container->get(BaseOrder::class)", methodName: "price", status: "unresolved", candidateTypes: [], resolutionMethod: "container-lookup", confidence: "unresolved", expectedCallTargets: [], limitations: ["Container get() result depends on runtime bindings"] },
      { id: "container-make", caller: `${local}\\ReceiverInferenceShowcase::containerMake`, expression: "$container->make(BaseOrder::class)", methodName: "price", status: "unresolved", candidateTypes: [], resolutionMethod: "container-lookup", confidence: "unresolved", expectedCallTargets: [], limitations: ["Container make() result depends on runtime bindings"] },
      { id: "container-resolve", caller: `${local}\\ReceiverInferenceShowcase::containerResolve`, expression: "$container->resolve(BaseOrder::class)", methodName: "price", status: "unresolved", candidateTypes: [], resolutionMethod: "container-lookup", confidence: "unresolved", expectedCallTargets: [], limitations: ["Container resolve() result depends on runtime bindings"] },
      { id: "runtime-class-string", caller: `${local}\\ReceiverInferenceShowcase::runtimeClassString`, expression: "$order", methodName: "price", status: "unresolved", candidateTypes: [baseOrder], resolutionMethod: "runtime-class-string", confidence: "unresolved", expectedCallTargets: [], limitations: ["Runtime class-string construction cannot be resolved without executing PHP"] },
      { id: "reflection-factory", caller: `${local}\\ReceiverInferenceShowcase::reflectionFactory`, expression: "$order", methodName: "price", status: "unresolved", candidateTypes: [baseOrder], resolutionMethod: "reflection", confidence: "unresolved", expectedCallTargets: [], limitations: ["Reflection-created instances depend on runtime class metadata"] },
      { id: "magic-fallback", caller: `${local}\\ReceiverInferenceShowcase::magicFallback`, expression: "$proxy", methodName: "price", status: "unresolved", candidateTypes: [`${local}\\MagicOrderProxy`], resolutionMethod: "magic-call", confidence: "unresolved", expectedCallTargets: [], limitations: ["Magic __call dispatch cannot prove a declared target method"] },
    ],
  };
}

async function buildUsageConsumer(repository: string, references: { old: string; current: string }): Promise<{ commits: FixtureCommitMap; tags: Record<string, string>; head: string }> {
  await initialise(repository);
  const commits: FixtureCommitMap = {};
  const composer = {
    name: "client/store",
    type: "project",
    autoload: { "psr-4": { "Client\\Store\\": "src/" } },
    repositories: [{ type: "vcs", url: "https://code.example.invalid/company/commerce.git" }],
    require: { php: ">=8.1", "company/commerce": "^1.0 || ^2.0" },
  };
  await write(repository, "composer.json", `${JSON.stringify(composer, null, 2)}\n`);
  await write(repository, "composer.lock", lockFile(references.old, "1.0.0"));
  await write(repository, "src/Order.php", `<?php

declare(strict_types=1);

namespace Client\\Store;

use Company\\Commerce\\BaseOrder as SharedOrder;

final class Order extends SharedOrder
{
    public function calculateTotal(): int
    {
        return parent::calculateTotal();
    }
}
`);
  await write(repository, "src/CheckoutService.php", `<?php

declare(strict_types=1);

namespace Client\\Store;

final class CheckoutService
{
    public function total(Order $order): int
    {
        return $order->calculateTotal(); // Confirmed typed direct caller.
    }

    public function dynamic(object $service, string $method): mixed
    {
        return $service->{$method}(); // Deliberately ambiguous dynamic call.
    }
}
`);
  commits.initialConsumer = commit(repository, "Add store override and shared package v1");

  const aliasedComposer = {
    name: "client/store",
    type: "project",
    autoload: { "psr-4": { "Client\\Store\\": "src/" } },
    repositories: [
      { type: "path", url: "../shared-commerce", canonical: true, options: { symlink: false, versions: { "company/commerce": "dev-feature/pricing" } } },
      { type: "vcs", url: "https://code.example.invalid/forks/commerce-fork.git", canonical: false },
      { type: "composer", url: "https://packages.example.invalid/custom", canonical: false },
    ],
    require: { php: ">=8.1", "company/commerce": "dev-feature/pricing as 2.1.x-dev" },
    "minimum-stability": "dev",
    "prefer-stable": true,
  };
  await write(repository, "composer.json", `${JSON.stringify(aliasedComposer, null, 2)}\n`);
  await write(repository, "composer.lock", lockFile(references.current, "dev-feature/pricing", { pathUrl: "../shared-commerce", alias: "2.1.x-dev" }));
  await write(repository, "src/Order.php", `<?php

declare(strict_types=1);

namespace Client\\Store;

use Company\\Commerce\\BaseOrder as SharedOrder;

final class Order extends SharedOrder
{
    public function calculateTotal(bool $includeTax = true): int
    {
        return parent::calculateTotal($includeTax);
    }
}
`);
  commits.dependencyUpdate = commit(repository, "Update company commerce dependency to v2");

  await write(repository, "src/CheckoutService.php", `<?php

declare(strict_types=1);

namespace Client\\Store;

use Company\\Commerce\\BaseOrder;
use Company\\Commerce\\Value\\Money;
use Company\\Commerce\\Value\\PriceContext;

/** Coordinates the fictional storefront checkout flow. */
final class CheckoutService
{
    public function total(Order $order): int
    {
        return $order->calculateTotal(); // Confirmed typed direct caller.
    }

    /** Return a typed monetary quote for the supplied order. */
    public function quote(BaseOrder $order, PriceContext $context): Money
    {
        return $order->price($context); // Confirmed typed direct caller.
    }

    public function dynamic(object $service, string $method): mixed
    {
        // Negative-scope example: the dynamic method name cannot form a precise edge.
        return $service->{$method}();
    }

    public function unresolved(object $service, PriceContext $context): mixed
    {
        // Negative-scope example: the receiver type cannot resolve price precisely.
        return $service->price($context);
    }
}
`);
  await write(repository, "src/CheckoutController.php", `<?php

declare(strict_types=1);

namespace Client\\Store;

use Company\\Commerce\\Value\\Money;
use Company\\Commerce\\Value\\PriceContext;

/** Entry point used to demonstrate transitive impact. */
final class CheckoutController
{
    public function summary(CheckoutService $checkout, Order $order, PriceContext $context): Money
    {
        return $checkout->quote($order, $context);
    }
}
`);
  commits.impactSurface = commit(repository, "Add typed checkout impact examples");
  await write(repository, "src/ReceiverInferenceShowcase.php", receiverInferenceSource());
  commits.receiverInference = commit(repository, "Add receiver inference showcase");
  return { commits, tags: {}, head: git(repository, ["rev-parse", "HEAD"]) };
}

async function buildDependencyOnlyConsumer(repository: string, references: { old: string; current: string }): Promise<{ commits: FixtureCommitMap; tags: Record<string, string>; head: string }> {
  await initialise(repository);
  const composer = {
    name: "client/reporting",
    type: "project",
    autoload: { "psr-4": { "Client\\Reporting\\": "src/" } },
    require: { php: ">=8.1", "company/commerce": "^1.0" },
  };
  await write(repository, "composer.json", `${JSON.stringify(composer, null, 2)}\n`);
  await write(repository, "composer.lock", lockFile(references.old, "1.0.0"));
  await write(repository, "src/Report.php", `<?php

declare(strict_types=1);

namespace Client\\Reporting;

final class Report
{
    public function title(): string
    {
        return 'Orders';
    }
}
`);
  const commits: FixtureCommitMap = { dependencyOnly: commit(repository, "Install commerce package without symbol usage") };
  const updatedComposer = {
    ...composer,
    require: { php: ">=8.1", "company/commerce": "^2.0" },
  };
  await write(repository, "composer.json", `${JSON.stringify(updatedComposer, null, 2)}\n`);
  await write(repository, "composer.lock", lockFile(references.current, "2.0.0"));
  commits.dependencyUpdate = commit(repository, "Evaluate commerce v2 without adding symbol usage");
  await write(repository, "composer.json", `${JSON.stringify(composer, null, 2)}\n`);
  await write(repository, "composer.lock", lockFile(references.old, "1.0.0"));
  commits.legacyTrackRestore = commit(repository, "Restore reporting to the legacy commerce track");

  const forkComposer = {
    ...composer,
    repositories: [
      { type: "vcs", url: "https://code.example.invalid/forks/commerce-fork.git", canonical: false },
      { type: "composer", url: "https://packages.example.invalid/custom", canonical: false },
    ],
    require: { php: ">=8.1", "company/commerce": "dev-fork/maintenance as 1.0.x-dev" },
    "minimum-stability": "dev",
  };
  await write(repository, "composer.json", `${JSON.stringify(forkComposer, null, 2)}\n`);
  await write(repository, "composer.lock", lockFile(references.current, "dev-fork/maintenance", { sourceUrl: "https://code.example.invalid/forks/commerce-fork.git", alias: "1.0.x-dev" }));
  commits.customForkEvaluation = commit(repository, "Record custom fork identity evidence");
  await write(repository, "composer.json", `${JSON.stringify(composer, null, 2)}\n`);
  await write(repository, "composer.lock", lockFile(references.old, "1.0.0"));
  commits.customForkRestore = commit(repository, "Restore reporting after fork identity example");
  return { commits, tags: {}, head: git(repository, ["rev-parse", "HEAD"]) };
}

function comparisonSelection(repositoryPath: string, commit: string): FixtureComparisonSelection {
  return {
    repositoryPath,
    relativePath: "src/BaseOrder.php",
    revision: { repositoryId: "company-commerce", commit, dirty: false },
    // The API resolves selectedText when this neutral file-start range is not a declaration.
    range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 0 },
    selectedText: "BaseOrder",
  };
}

async function assertEmptyDestination(destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(destination);
  if (entries.length > 0) {
    throw new Error(`Fixture destination must be empty: ${destination}`);
  }
}

export async function generateFixtures(destination: string): Promise<FixtureManifest> {
  commitSequence = 0;
  const resolved = path.resolve(destination);
  await assertEmptyDestination(resolved);

  try {
    const sharedPath = path.join(resolved, "shared-commerce");
    const usagePath = path.join(resolved, "consumer-store");
    const dependencyOnlyPath = path.join(resolved, "consumer-reporting");

    const shared = await buildSharedPackage(sharedPath);
    const usage = await buildUsageConsumer(usagePath, {
      old: shared.tags["v1.0.0"]!,
      current: shared.head,
    });
    const dependencyOnly = await buildDependencyOnlyConsumer(dependencyOnlyPath, {
      old: shared.tags["v1.0.0"]!,
      current: shared.head,
    });
    const originalPatchId = stablePatchId(sharedPath, shared.commits.implementation!);
    const equivalentPatchId = stablePatchId(sharedPath, shared.commits.equivalentCherryPick!);
    if (!originalPatchId || originalPatchId !== equivalentPatchId || shared.commits.implementation === shared.commits.equivalentCherryPick) {
      throw new Error("Fixture cherry-pick must have a distinct commit SHA and the same stable patch ID");
    }

    const manifest: FixtureManifest = {
      generatedAt: "2024-01-31T00:00:00.000Z",
      repositories: [
        { id: "company-commerce", path: sharedPath, packageName: "company/commerce", remoteUrl: "https://code.example.invalid/company/commerce.git", head: shared.head, commits: shared.commits, tags: shared.tags },
        { id: "client-store", path: usagePath, packageName: "client/store", remoteUrl: "https://code.example.invalid/apps/store.git", head: usage.head, commits: usage.commits, tags: usage.tags },
        { id: "client-reporting", path: dependencyOnlyPath, packageName: "client/reporting", remoteUrl: "https://code.example.invalid/apps/reporting.git", head: dependencyOnly.head, commits: dependencyOnly.commits, tags: dependencyOnly.tags },
      ],
      expectations: {
        packageName: "company/commerce",
        focusSymbol: "Company\\Commerce\\BaseOrder::calculateTotal",
        dependencyOnlyConsumer: "client-reporting",
        confirmedUsageConsumer: "client-store",
        olderConsumerReference: shared.tags["v1.0.0"]!,
        newerConsumerReference: shared.head,
        revertedCommit: shared.revertedCommit,
        examples: {
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
        },
        historyCategories: ["introduction", "implementation", "documentation", "formatting", "signature"],
        historicalComparison: {
          id: "commerce-v1-to-v2-adoption",
          description: "Compare the exact v1 and v2 package/consumer graph bases without substituting any repository head.",
          protocolVersion: "1.0",
          mode: "impact",
          before: {
            revisions: {
              "company-commerce": shared.commits.introduction!,
              "client-store": usage.commits.initialConsumer!,
              "client-reporting": dependencyOnly.commits.dependencyOnly!,
            },
            selection: comparisonSelection(sharedPath, shared.commits.introduction!),
            packageReferences: {
              "client-store": { "company/commerce": shared.commits.introduction! },
              "client-reporting": { "company/commerce": shared.commits.introduction! },
            },
          },
          after: {
            revisions: {
              "company-commerce": shared.head,
              "client-store": usage.commits.impactSurface!,
              "client-reporting": dependencyOnly.commits.dependencyUpdate!,
            },
            selection: comparisonSelection(sharedPath, shared.head),
            packageReferences: {
              "client-store": { "company/commerce": shared.head },
              "client-reporting": { "company/commerce": shared.head },
            },
          },
          expectedRelationships: {
            added: [
              { identity: "edge|uses-trait|symbol|company-commerce|class|Company\\Commerce\\BaseOrder|symbol|company-commerce|trait|Company\\Commerce\\Support\\PricingMath", type: "uses-trait", source: "Company\\Commerce\\BaseOrder", target: "Company\\Commerce\\Support\\PricingMath" },
              { identity: "edge|declares|symbol|company-commerce|class|Company\\Commerce\\BaseOrder|symbol|company-commerce|method|Company\\Commerce\\BaseOrder::price", type: "declares", source: "Company\\Commerce\\BaseOrder", target: "Company\\Commerce\\BaseOrder::price" },
              { identity: "edge|implements-method|symbol|company-commerce|method|Company\\Commerce\\BaseOrder::price|symbol|company-commerce|method|Company\\Commerce\\Contracts\\PricedOrder::price", type: "implements-method", source: "Company\\Commerce\\BaseOrder::price", target: "Company\\Commerce\\Contracts\\PricedOrder::price" },
              { identity: "edge|calls|symbol|client-store|method|Client\\Store\\CheckoutService::quote|symbol|company-commerce|method|Company\\Commerce\\BaseOrder::price", type: "calls", source: "Client\\Store\\CheckoutService::quote", target: "Company\\Commerce\\BaseOrder::price" },
              { identity: "edge|calls|symbol|client-store|method|Client\\Store\\CheckoutController::summary|symbol|client-store|method|Client\\Store\\CheckoutService::quote", type: "calls", source: "Client\\Store\\CheckoutController::summary", target: "Client\\Store\\CheckoutService::quote" },
              { identity: "edge|declares|symbol|company-commerce|class|Company\\Commerce\\BaseOrder|symbol|company-commerce|method|Company\\Commerce\\BaseOrder::fixtureMarker", type: "declares", source: "Company\\Commerce\\BaseOrder", target: "Company\\Commerce\\BaseOrder::fixtureMarker" },
            ],
            removed: [
              { identity: "edge|uses-trait|symbol|company-commerce|class|Company\\Commerce\\BaseOrder|symbol|company-commerce|trait|Company\\Commerce\\Support\\PricingRules", type: "uses-trait", source: "Company\\Commerce\\BaseOrder", target: "Company\\Commerce\\Support\\PricingRules" },
            ],
            changed: [
              {
                identity: "edge|requires|project|client-store|package|company/commerce",
                type: "requires",
                source: "client-store",
                target: "company/commerce",
                changedFields: ["evidence", "resolvedSourceCommit"],
                before: { sourceCommit: usage.commits.initialConsumer!, targetCommit: shared.commits.introduction! },
                after: { sourceCommit: usage.commits.impactSurface!, targetCommit: shared.head },
              },
              {
                identity: "edge|requires|project|client-reporting|package|company/commerce",
                type: "requires",
                source: "client-reporting",
                target: "company/commerce",
                changedFields: ["evidence", "resolvedSourceCommit"],
                before: { sourceCommit: dependencyOnly.commits.dependencyOnly!, targetCommit: shared.commits.introduction! },
                after: { sourceCommit: dependencyOnly.commits.dependencyUpdate!, targetCommit: shared.head },
              },
            ],
          },
          limitations: [
            "Relationship changes describe static indexed evidence, not runtime execution.",
            "The trait rename is represented as a removed edge plus an added edge; complete rename lineage is not inferred.",
            "Every listed Git object is required. An unavailable revision must fail comparison rather than fall back to an active or latest generation.",
          ],
        },
        historyEvidence: {
          lineage: {
            commit: shared.commits.moveRename!,
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
                    commit: shared.commits.moveRename!,
                    path: "src/Support/PricingMath.php",
                    resolutionMethod: "git-rename-diff",
                    confidence: "confirmed",
                    detail: "Git rename detection maps src/Support/PricingRules.php to src/Support/PricingMath.php",
                    limitations: [],
                  },
                  {
                    repositoryId: "company-commerce",
                    commit: shared.commits.moveRename!,
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
                  commit: shared.commits.moveRename!,
                  path: "src/Support/PricingMath.php",
                  resolutionMethod: "syntax-fingerprint-and-git-change",
                  confidence: "possible",
                  detail: "A unique method preserved its syntax-aware implementation fingerprint and structural contract in a Git-changed file",
                  limitations: ["Static equivalence establishes continuity but cannot prove the author's naming intent"],
                }],
                limitations: ["Static equivalence establishes continuity but cannot prove the author's naming intent"],
              },
            ],
          },
          equivalence: {
            originalCommit: shared.commits.implementation!,
            cherryPickCommit: shared.commits.equivalentCherryPick!,
            branch: "equivalent/discount",
            patchId: originalPatchId,
            expected: {
              state: "likely-equivalent",
              activeBehaviour: "likely-active",
              basisCommit: shared.commits.equivalentCherryPick!,
              equivalentCommit: shared.commits.equivalentCherryPick!,
              lastMatchingCommit: shared.commits.equivalentCherryPick!,
              evidenceResolutionMethods: ["git-commit-ancestry", "git-patch-id-stable", "git-patch-id-reachable-order"],
              limitations: [],
            },
            expectedReleaseAssessment: {
              release: "v1.1.0-equivalent",
              revision: shared.commits.equivalentCherryPick!,
              state: "likely-equivalent",
              activeBehaviour: "likely-active",
              basisCommit: shared.commits.equivalentCherryPick!,
              equivalentCommit: shared.commits.equivalentCherryPick!,
              lastMatchingCommit: shared.commits.equivalentCherryPick!,
              evidenceResolutionMethods: ["git-commit-ancestry", "git-patch-id-stable", "git-patch-id-reachable-order"],
              limitations: [],
            },
            limitations: ["Patch equivalence does not prove identical surrounding context"],
          },
          activity: [
            {
              name: "regression-reverted-at-head",
              selectedChangeCommit: shared.commits.revertedChange!,
              basisCommit: shared.head,
              activeBehaviour: "reverted",
              revertCommit: shared.commits.revert!,
              lastMatchingCommit: shared.commits.revert!,
              evidenceResolutionMethods: ["git-commit-ancestry", "git-patch-id-reachable-order"],
              limitations: [],
            },
            {
              name: "marker-originally-active",
              selectedChangeCommit: shared.commits.activityChange!,
              basisCommit: shared.commits.activityChange!,
              activeBehaviour: "likely-active",
              lastMatchingCommit: shared.commits.activityChange!,
              evidenceResolutionMethods: ["git-commit-ancestry", "git-patch-id-reachable-order"],
              limitations: [],
            },
            {
              name: "marker-reverted",
              selectedChangeCommit: shared.commits.activityChange!,
              basisCommit: shared.commits.activityRevert!,
              activeBehaviour: "reverted",
              revertCommit: shared.commits.activityRevert!,
              lastMatchingCommit: shared.commits.activityRevert!,
              evidenceResolutionMethods: ["git-commit-ancestry", "git-patch-id-reachable-order"],
              limitations: [],
            },
            {
              name: "marker-reapplied-at-head",
              selectedChangeCommit: shared.commits.activityChange!,
              basisCommit: shared.head,
              activeBehaviour: "likely-active",
              lastMatchingCommit: shared.commits.activityReapply!,
              evidenceResolutionMethods: ["git-commit-ancestry", "git-patch-id-reachable-order"],
              limitations: [],
            },
            {
              name: "unavailable-basis",
              selectedChangeCommit: shared.commits.activityChange!,
              basisCommit: "ffffffffffffffffffffffffffffffffffffffff",
              activeBehaviour: "unknown",
              evidenceResolutionMethods: [],
              limitations: ["The selected change or exact target revision is unavailable"],
            },
          ],
          unavailableCommit: "ffffffffffffffffffffffffffffffffffffffff",
        },
        composerResolution: {
          packageName: "company/commerce",
          branchAliases: { "dev-main": "2.0.x-dev", "dev-feature/pricing": "2.1.x-dev" },
          identities: [
            { kind: "indexed-repository", repositoryId: "company-commerce", packageName: "company/commerce", repositoryUrl: "https://code.example.invalid/company/commerce.git", indexed: true },
            { kind: "consumer-repository", repositoryId: "client-store", packageName: "client/store", repositoryUrl: "https://code.example.invalid/apps/store.git", indexed: true },
            { kind: "consumer-repository", repositoryId: "client-reporting", packageName: "client/reporting", repositoryUrl: "https://code.example.invalid/apps/reporting.git", indexed: true },
            { kind: "declared-custom-repository", repositoryId: "declared-fork:commerce-fork", packageName: "company/commerce", repositoryUrl: "https://code.example.invalid/forks/commerce-fork.git", indexed: false },
          ],
          pathRepository: {
            consumerRepositoryId: "client-store",
            consumerCommit: usage.head,
            declaredConstraint: "dev-feature/pricing as 2.1.x-dev",
            declaredConstraintBase: "dev-feature/pricing",
            declaredAlias: "2.1.x-dev",
            resolvedVersion: "dev-feature/pricing",
            resolvedDistReference: shared.head,
            resolvedDistUrl: "../shared-commerce",
            resolvedPath: sharedPath,
            repositoryCandidates: [
              { type: "path", url: "../shared-commerce", resolvedPath: sharedPath, canonical: true },
              { type: "vcs", url: "https://code.example.invalid/forks/commerce-fork.git", normalizedUrl: "code.example.invalid/forks/commerce-fork", canonical: false },
              { type: "composer", url: "https://packages.example.invalid/custom", normalizedUrl: "packages.example.invalid/custom", canonical: false },
            ],
            expected: {
              resolution: "path",
              resolutionMethod: "path",
              indexedRepositoryId: "company-commerce",
              indexedRevision: shared.head,
              resolutionEvidence: [`Canonical path ${sharedPath} was used as repository identity`],
            },
          },
          customFork: {
            consumerRepositoryId: "client-reporting",
            consumerCommit: dependencyOnly.commits.customForkEvaluation!,
            declaredConstraint: "dev-fork/maintenance as 1.0.x-dev",
            declaredConstraintBase: "dev-fork/maintenance",
            declaredAlias: "1.0.x-dev",
            resolvedVersion: "dev-fork/maintenance",
            resolvedSourceReference: shared.head,
            resolvedSourceUrl: "https://code.example.invalid/forks/commerce-fork.git",
            normalizedSourceUrl: "code.example.invalid/forks/commerce-fork",
            resolvedSourceCommit: shared.head,
            repositoryCandidates: [
              { type: "vcs", url: "https://code.example.invalid/forks/commerce-fork.git", normalizedUrl: "code.example.invalid/forks/commerce-fork", canonical: false },
              { type: "composer", url: "https://packages.example.invalid/custom", normalizedUrl: "packages.example.invalid/custom", canonical: false },
            ],
            expected: {
              resolution: "declared-only",
              resolutionMethod: "unresolved",
              resolutionEvidence: [
                "Normalized source URL code.example.invalid/forks/commerce-fork was used as repository identity",
                "No indexed repository matched the available identity evidence",
              ],
            },
            limitations: [
              "A declared custom VCS repository is a candidate source, not proof that it was selected or that it is the indexed upstream repository.",
              "A matching commit hash does not identify a fork; repository identity requires path, normalized URL, or explicit mapping evidence.",
            ],
          },
        },
        githubAssociations: {
          sourceRepositoryUrl: "https://code.example.invalid/company/commerce.git",
          localInclusionPreserved: true,
          expectedWithoutCredentials: {
            pullRequests: [],
            releases: [],
            limitations: ["GitHub associations were not queried because no GitHub token is configured"],
          },
          expectedWithUnsupportedHost: {
            pullRequests: [],
            releases: [],
            limitations: ["GitHub associations were not queried because the source repository URL is not a normalized GitHub repository"],
          },
          evidenceRequirements: {
            pullRequest: {
              confidence: "confirmed",
              evidence: ["exact repository identity", "exact selected commit", "GitHub commit-to-pull-request API response"],
              limitations: ["Commit association does not by itself prove that the pull request was merged"],
            },
            release: {
              confidence: "possible",
              evidence: ["exact repository identity", "exact local tag name and tag commit", "same-tag-name GitHub release API response"],
              limitations: ["The remote tag object or commit was not independently verified", "Release publication does not prove deployment"],
            },
          },
          partialFailure: {
            expected: "Return successful local inclusion evidence and any successful GitHub associations while recording failed or bounded GitHub lookups as association limitations.",
            limitations: ["A pull-request association does not prove merge or deployment", "A GitHub release does not prove deployment"],
          },
        },
        receiverInference: receiverInferenceExpectation(usage.commits.receiverInference!),
      },
    };
    await writeFile(path.join(resolved, "fixture-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  } catch (error) {
    // The destination was required to be empty, so only this invocation's partial output can exist.
    await rm(resolved, { recursive: true, force: true });
    throw error;
  }
}
