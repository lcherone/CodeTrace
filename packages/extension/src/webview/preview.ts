import { PROTOCOL_VERSION, type ChangeInclusionResponse, type GraphEdge, type GraphNode, type GraphResponse, type TemporalGraphComparisonResponse } from "@trace/contracts";

const previewTheme = new URLSearchParams(window.location.search).get("theme") === "light" ? "light" : "dark";
document.body.classList.add(`vscode-${previewTheme}`);
window.__TRACE_INITIAL_SELECTION__ = "overrides";

const oid = (prefix: string) => prefix.padEnd(40, "0");
const repository = { repositoryId: "/fixtures/client", commit: oid("8f2a91c7d48b"), branch: "main", dirty: true };
const range = { startLine: 45, startColumn: 4, endLine: 48, endColumn: 5 };
const evidence = (detail: string, confidence: "confirmed" | "possible" | "dependency-only" = "confirmed", path = "src/Store/Order.php", limitations = confidence === "possible" ? ["Receiver type has more than one compatible target."] : [], resolutionMethod = "position-aware PHP AST") => [{ repositoryId: repository.repositoryId, commit: repository.commit, path, range, resolutionMethod, confidence, detail, limitations }];
const graph: GraphResponse = {
  protocolVersion: PROTOCOL_VERSION,
  queryId: "preview-query",
  mode: "origin",
  focusNodeId: "client-total",
  nodes: [
    { id: "client-project", kind: "project", label: "Client Store", subtitle: "Project", metadata: { repository: "acme/client" } },
    { id: "client-total", kind: "method", label: "Client\\Store\\Order::calculateTotal", subtitle: "Local override", focused: true, occurrence: { id: "client-total@8f2a91c", logical: { kind: "method", fullyQualifiedName: "Client\\Store\\Order", memberName: "calculateTotal" }, revision: repository, path: "src/Store/Order.php", range, overlayId: "overlay:42" }, metadata: {
      visibility: "public",
      signature: "public function calculateTotal(PriceContext $context): static",
      description: "Calculate the payable total for the current order.",
      documentationDetails: "Applies active promotions before returning a currency-safe total. Implementations must preserve the pricing context supplied by the caller.",
      parameters: [{ name: "context", declaredType: "PriceContext", resolvedTypes: ["Client\\Store\\Contract\\PriceContext"], typeSource: "native", nullable: false, lateStatic: false, description: "Rules and currency used for this calculation." }],
      returnType: { declaredType: "static", resolvedTypes: ["Client\\Store\\Order"], typeSource: "native", nullable: false, lateStatic: true, phpDocType: "static", description: "A priced copy of the runtime order type." },
      contractSources: [{ relationship: "implements-method", symbol: "Client\\Store\\Contract\\PricesOrder::calculateTotal", signature: "public function calculateTotal(PriceContext $context): Money", parameters: [{ name: "context", declaredType: "PriceContext", resolvedTypes: ["Client\\Store\\Contract\\PriceContext"], typeSource: "native", nullable: false, lateStatic: false }], returnType: { declaredType: "Money", resolvedTypes: ["Client\\Store\\Money"], typeSource: "native", nullable: false, lateStatic: false } }],
      lateStaticBindings: [{ kind: "return-type", detail: "The static return type follows the runtime called class.", range: { startLine: 45, startColumn: 61, endLine: 45, endColumn: 67 } }, { kind: "instantiation", detail: "new static() instantiates the runtime called class.", range: { startLine: 47, startColumn: 15, endLine: 47, endColumn: 27 } }],
    } },
    { id: "price-contract", kind: "interface", label: "Client\\Store\\Contract\\PricesOrder", subtitle: "Implemented contract", metadata: { description: "Defines the order pricing contract." } },
    { id: "price-context", kind: "class", label: "Client\\Store\\Contract\\PriceContext", subtitle: "Parameter type", metadata: { description: "Immutable pricing rules and currency context." } },
    { id: "client-order", kind: "class", label: "Client\\Store\\Order", subtitle: "Runtime called class", metadata: { interfaces: ["Client\\Store\\Contract\\PricesOrder"] } },
    { id: "package-total", kind: "method", label: "Company\\Commerce\\BaseOrder::calculateTotal", subtitle: "Package implementation", occurrence: { id: "package-total@41a8c22", logical: { kind: "method", fullyQualifiedName: "Company\\Commerce\\BaseOrder", memberName: "calculateTotal" }, revision: { repositoryId: "/fixtures/commerce", commit: oid("41a8c2290be1"), branch: "2.x", dirty: false }, path: "src/BaseOrder.php", range: { startLine: 31, startColumn: 4, endLine: 39, endColumn: 5 } }, metadata: { package: "company/commerce", installedRevision: oid("41a8c2290be1"), declaredConstraint: "dev-fix-total as 2.4.x-dev", declaredConstraintBase: "dev-fix-total", declaredAlias: "2.4.x-dev", resolvedVersion: "dev-fix-total", resolvedSourceReference: oid("41a8c2290be1"), resolvedSourceUrl: "https://github.com/client-fork/commerce.git", normalizedSourceUrl: "github.com/client-fork/commerce", resolvedDistReference: oid("41a8c2290be1"), resolvedDistUrl: "https://api.github.com/repos/client-fork/commerce/zipball/41a8c2290be1", resolvedPath: "/fixtures/client/vendor/company/commerce", indexedRepositoryId: "/fixtures/commerce", indexedRevision: oid("41a8c2290be1"), resolution: "path", resolutionMethod: "path", branchAliases: { "dev-main": "2.x-dev" }, repositoryCandidates: [{ type: "path", resolvedPath: "/fixtures/client/vendor/company/commerce", canonical: true, packageName: "company/commerce" }, { type: "source", url: "https://github.com/client-fork/commerce.git", normalizedUrl: "github.com/client-fork/commerce", canonical: false, packageName: "company/commerce" }], resolutionEvidence: ["Canonical installed path maps the package to /fixtures/commerce", "The normalized source URL identifies the client-fork/commerce fork"], symbolAnalysis: "available" } },
    { id: "caller-checkout", kind: "method", label: "CheckoutService::priceOrder", subtitle: "Receiver inference examples", metadata: { project: "client", receiverAnalysis: [
      { id: "receiver-native-property", status: "resolved", expression: "$this->gateway->charge($order)", methodName: "charge", candidateTypes: ["Client\\Checkout\\PaymentGateway"], resolutionMethod: "native-property", confidence: "confirmed", range: { startLine: 18, startColumn: 8, endLine: 18, endColumn: 38 }, limitations: [] },
      { id: "receiver-local-new", status: "resolved", expression: "$calculator->calculateTotal()", methodName: "calculateTotal", candidateTypes: ["Client\\Store\\OrderCalculator"], resolutionMethod: "local-new", confidence: "confirmed", range: { startLine: 22, startColumn: 8, endLine: 22, endColumn: 37 }, limitations: [] },
      { id: "receiver-union", status: "ambiguous", expression: "$processor->process($order)", methodName: "process", candidateTypes: ["Client\\Checkout\\CardProcessor", "Client\\Checkout\\InvoiceProcessor"], resolutionMethod: "branch-merge", confidence: "possible", range: { startLine: 29, startColumn: 8, endLine: 29, endColumn: 35 }, limitations: ["Control-flow branches assign more than one compatible receiver type."] },
      { id: "receiver-container", status: "unresolved", expression: "$container->get($service)->process($order)", methodName: "process", candidateTypes: [], resolutionMethod: "container-lookup", confidence: "unresolved", range: { startLine: 34, startColumn: 8, endLine: 34, endColumn: 50 }, limitations: ["The container key is runtime data.", "Container bindings are not executed during static analysis."] },
      { id: "receiver-dynamic", status: "dynamic", expression: "$processor->{$method}($order)", candidateTypes: [], resolutionMethod: "dynamic-method", confidence: "unresolved", range: { startLine: 39, startColumn: 8, endLine: 39, endColumn: 39 }, limitations: ["The method name is computed at runtime."] },
      { id: "receiver-reflection", status: "unresolved", expression: "$reflection->invoke($service, $order)", methodName: "invoke", candidateTypes: [], resolutionMethod: "reflection", confidence: "unresolved", range: { startLine: 43, startColumn: 8, endLine: 43, endColumn: 47 }, limitations: ["Reflection can select a receiver and member at runtime."] },
      { id: "receiver-magic", status: "unresolved", expression: "$proxy->calculateTotal()", methodName: "calculateTotal", candidateTypes: [], resolutionMethod: "magic-call", confidence: "unresolved", range: { startLine: 47, startColumn: 8, endLine: 47, endColumn: 34 }, limitations: ["The proxy handles the call through __call; no declared target is available."] },
    ] } },
    { id: "caller-dynamic", kind: "method", label: "$processor->{$method}()", subtitle: "Possible dynamic caller", metadata: { project: "client", limitation: "dynamic method name" } },
    { id: "consumer-a", kind: "project", label: "Web Storefront", subtitle: "Confirmed usage", metadata: { resolvedVersion: "2.4.0", sourceCommit: "41a8c2290be1" } },
    { id: "consumer-b", kind: "project", label: "Operations Portal", subtitle: "Dependency only", metadata: { resolvedVersion: "2.2.1", sourceCommit: "12c87a8e7bf0" } },
    { id: "commit", kind: "commit", label: "8f2a91c", subtitle: "Refactor total calculation", metadata: { author: "A. Developer" } },
    { id: "release", kind: "release", label: "v2.4.0", subtitle: "Includes implementation change", metadata: { ancestry: "contains original commit" } },
  ],
  edges: [
    { id: "declares", source: "client-project", target: "client-total", type: "declares", label: "Declares", confidence: "confirmed", evidence: evidence("The method declaration belongs to this repository revision.") },
    { id: "overrides", source: "client-total", target: "package-total", type: "overrides", label: "Overrides", confidence: "confirmed", evidence: evidence("Resolved through the declared parent class and matching method signature.") },
    { id: "implements-method", source: "client-total", target: "price-contract", type: "implements-method", label: "Implements method", confidence: "confirmed", evidence: evidence("The method satisfies the PricesOrder interface declaration.") },
    { id: "parameter-type", source: "client-total", target: "price-context", type: "parameter-type", label: "Parameter type", confidence: "confirmed", evidence: evidence("$context is declared as PriceContext and resolves through the namespace import.") },
    { id: "late-static", source: "client-total", target: "client-order", type: "late-static-binding", label: "Late static binding", confidence: "possible", evidence: evidence("The static return type follows the runtime called class.", "possible", "src/Store/Order.php", ["The runtime called class can be a subclass of the declaring class."]) },
    { id: "parent-call", source: "client-total", target: "package-total", type: "calls-parent", label: "Calls parent", confidence: "confirmed", evidence: evidence("Explicit parent::calculateTotal() call in the local override.") },
    { id: "call-a", source: "caller-checkout", target: "client-total", type: "calls", label: "Calls", confidence: "confirmed", evidence: evidence("Receiver type resolves uniquely to Client\\Store\\Order.", "confirmed", "src/Service/CheckoutService.php") },
    { id: "call-dynamic", source: "caller-dynamic", target: "client-total", type: "calls", label: "Possible call", confidence: "possible", evidence: evidence("Dynamic call may target calculateTotal; static analysis cannot prove it.", "possible", "src/Service/Processor.php") },
    { id: "consume-a", source: "consumer-a", target: "package-total", type: "requires", label: "Uses symbol", confidence: "confirmed", evidence: evidence("Consumer lock source reference and indexed call both match.") },
    { id: "consume-b", source: "consumer-b", target: "package-total", type: "requires", label: "Requires package", confidence: "dependency-only", evidence: evidence("composer.lock installs the package; no symbol usage was identified in indexed scope.", "dependency-only", "composer.lock") },
    { id: "changed", source: "client-total", target: "commit", type: "changed-in", label: "Changed in", confidence: "confirmed", evidence: evidence("Syntax-aware implementation fingerprint changed.") },
    { id: "released", source: "commit", target: "release", type: "included-in-release", label: "Included in", confidence: "confirmed", evidence: evidence("The release tag contains this commit by Git ancestry.") },
  ],
  history: [
    { id: "h1", symbolId: "client-total", commit: "a1b2c3d49ee0", category: "introduction", summary: "Initial implementation", authorName: "A. Developer", authorEmail: "dev@example.test", authoredAt: "2024-01-12T09:30:00.000Z", afterSource: "public function calculateTotal(): Money\n{\n    return $this->subtotal;\n}", limitations: [] },
    { id: "h2", symbolId: "client-total", commit: "4e5f6a7c81bd", parentCommit: "a1b2c3d49ee0", category: "implementation", summary: "Add discounts", authorName: "A. Developer", authorEmail: "dev@example.test", authoredAt: "2024-02-03T15:12:00.000Z", beforeSource: "return $this->subtotal;", afterSource: "return $this->subtotal->minus($this->discounts);", limitations: [] },
    { id: "h3", symbolId: "client-total", commit: "8f2a91c7d48b", parentCommit: "4e5f6a7c81bd", category: "move", summary: "Move and possible rename of order total calculation", authorName: "B. Developer", authorEmail: "bdev@example.test", authoredAt: "2024-03-19T14:22:11.000Z", beforeSource: "return $this->subtotal->minus($this->discounts);", afterSource: "return parent::calculateTotal();", lineage: { fromPath: "src/Legacy/Order.php", toPath: "src/Store/Order.php", fromSymbol: "Client\\Legacy\\Order::total", toSymbol: "Client\\Store\\Order::calculateTotal", confidence: "possible", evidence: [...evidence("Git rename detection confirms that the source path moved.", "confirmed", "src/Store/Order.php", [], "Git rename detection"), ...evidence("Matching PHP signatures suggest, but do not prove, continuity across the symbol rename.", "possible", "src/Store/Order.php", ["Path evidence alone cannot confirm renamed symbol continuity."], "PHP signature similarity")], limitations: ["The intermediate formatting-only commit is omitted from this condensed lineage.", "The path move is confirmed; renamed symbol continuity remains possible."] }, limitations: [] },
    { id: "h4", symbolId: "client-total", commit: "9bb77d008ac2", parentCommit: "8f2a91c7d48b", category: "signature", summary: "Narrow return contract", authorName: "B. Developer", authorEmail: "bdev@example.test", authoredAt: "2024-04-05T08:10:00.000Z", beforeSource: "public function calculateTotal()", afterSource: "public function calculateTotal(): Money", limitations: [] },
  ],
  freshness: {
    generation: 7,
    indexedAt: new Date().toISOString(),
    repositories: [repository, { repositoryId: "/fixtures/commerce", commit: oid("41a8c2290be1"), branch: "2.x", dirty: false }, { repositoryId: "/fixtures/ops", commit: oid("12c87a8e7bf0"), branch: "main", dirty: false }],
    partial: true,
    limitations: ["Dynamic dispatch is reported as possible", "Single-file local overlay"],
  },
};

const node = (id: string): GraphNode => graph.nodes.find((candidate) => candidate.id === id)!;
const edge = (id: string): GraphEdge => graph.edges.find((candidate) => candidate.id === id)!;
const legacyNode: GraphNode = { id: "legacy-caller", kind: "method", label: "LegacyCheckout::total", subtitle: "Removed caller", metadata: { project: "client" } };
const legacyEdge: GraphEdge = { id: "legacy-call", source: "legacy-caller", target: "client-total", type: "calls", label: "Calls", confidence: "confirmed", evidence: evidence("The legacy checkout called the order total before the refactor.") };
const beforeOverride: GraphEdge = { ...edge("overrides"), confidence: "possible", evidence: evidence("The earlier parent relationship was inferred from an incomplete dependency index.", "possible") };
const beforePackage: GraphNode = { ...node("package-total"), subtitle: "Earlier package implementation", metadata: { ...node("package-total").metadata, installedRevision: oid("12c87a8e7bf0") } };
const beforeGraph: GraphResponse = {
  ...structuredClone(graph),
  queryId: "preview-before-query",
  nodes: graph.nodes.filter((candidate) => candidate.id !== "client-order").map((candidate) => candidate.id === "package-total" ? beforePackage : candidate).concat(legacyNode),
  edges: graph.edges.filter((candidate) => candidate.id !== "late-static" && candidate.id !== "overrides").concat(beforeOverride, legacyEdge),
  freshness: { ...graph.freshness, repositories: graph.freshness.repositories.map((revision) => ({ ...revision, commit: oid(revision.repositoryId === "/fixtures/client" ? "4e5f6a7c81bd" : revision.repositoryId === "/fixtures/commerce" ? "12c87a8e7bf0" : "12c87a8e7bf0") })) },
};
const comparison: TemporalGraphComparisonResponse = {
  protocolVersion: PROTOCOL_VERSION,
  basis: {
    policy: "explicit-revisions-only",
    complete: true,
    before: beforeGraph.freshness.repositories.map((revision) => ({ repositoryId: revision.repositoryId, requestedCommit: revision.commit, resolvedCommit: revision.commit, status: "resolved" as const })),
    after: graph.freshness.repositories.map((revision) => ({ repositoryId: revision.repositoryId, requestedCommit: revision.commit, resolvedCommit: revision.commit, status: "resolved" as const })),
  },
  before: beforeGraph,
  after: { ...graph, queryId: "preview-after-query" },
  basisChanges: [
    { repositoryId: "/fixtures/client", kind: "changed", beforeCommit: beforeGraph.freshness.repositories[0]!.commit, afterCommit: graph.freshness.repositories[0]!.commit },
    { repositoryId: "/fixtures/commerce", kind: "changed", beforeCommit: beforeGraph.freshness.repositories[1]!.commit, afterCommit: graph.freshness.repositories[1]!.commit },
  ],
  changes: {
    nodes: {
      added: [node("client-order")],
      removed: [legacyNode],
      changed: [{ identity: "method:Company\\Commerce\\BaseOrder::calculateTotal", before: beforePackage, after: node("package-total"), changedFields: ["subtitle", "metadata.installedRevision"] }],
    },
    edges: {
      added: [edge("late-static")],
      removed: [legacyEdge],
      changed: [{ identity: "overrides:Client\\Store\\Order::calculateTotal", before: beforeOverride, after: edge("overrides"), changedFields: ["confidence", "evidence"] }],
    },
  },
};

const inclusion: ChangeInclusionResponse = {
  protocolVersion: PROTOCOL_VERSION,
  symbolId: "client-total",
  commit: oid("8f2a91c7d48b"),
  releases: ["v2.4.0", "v2.5.0", "v2.6.0"],
  releaseAssessments: [
    {
      release: "v2.4.0",
      revision: oid("9bb77d008ac2"),
      state: "contains-original",
      activeBehaviour: "likely-active",
      basisCommit: oid("9bb77d008ac2"),
      lastMatchingCommit: oid("9bb77d008ac2"),
      evidence: evidence("The release contains the original change and the symbol fingerprint still matches."),
      limitations: [],
    },
    {
      release: "v2.5.0",
      revision: oid("aa51e7b9c120"),
      state: "likely-equivalent",
      activeBehaviour: "likely-active",
      basisCommit: oid("aa51e7b9c120"),
      equivalentCommit: oid("f42ce9013a77"),
      lastMatchingCommit: oid("f42ce9013a77"),
      evidence: evidence("The original commit was rebased, but a commit with the same stable Git patch-id is present.", "confirmed", "src/Store/Order.php", [], "stable Git patch-id"),
      limitations: ["Equivalence is based on stable Git patch-id rather than identical Git ancestry."],
    },
    {
      release: "v2.6.0",
      revision: oid("cc719e04b001"),
      state: "contains-original",
      activeBehaviour: "reverted",
      basisCommit: oid("cc719e04b001"),
      revertCommit: oid("d17ab8100f33"),
      lastMatchingCommit: oid("d17ab8100f33"),
      evidence: evidence("The release contains the original change, followed by a reverse patch that restores the earlier implementation.", "confirmed", "src/Store/Order.php", [], "stable Git patch-id and reverse patch"),
      limitations: [],
    },
  ],
  consumers: [
    {
      consumerRepositoryId: "/fixtures/storefront",
      packageName: "company/commerce",
      declaredConstraint: "^2.5",
      resolvedVersion: "2.5.3",
      resolvedSourceCommit: oid("aa51e7b9c120"),
      resolutionEvidence: ["The normalized source URL selects the indexed package repository."],
      indexedSourceCommit: oid("01c0ff33b778"),
      selectedChangeCommit: oid("8f2a91c7d48b"),
      state: "likely-equivalent",
      activeBehaviour: "likely-active",
      basisCommit: oid("01c0ff33b778"),
      equivalentCommit: oid("f42ce9013a77"),
      lastMatchingCommit: oid("f42ce9013a77"),
      reason: "The lock resolves an equivalent rebased implementation and the indexed call still reaches it.",
      evidence: evidence("composer.lock resolves a commit with the same stable Git patch-id as the selected change.", "confirmed", "composer.lock", [], "stable Git patch-id"),
      limitations: ["Runtime feature flags are outside the indexed static assessment."],
    },
    {
      consumerRepositoryId: "/fixtures/ops",
      packageName: "company/commerce",
      declaredConstraint: "2.6.*",
      resolvedVersion: "2.6.0",
      resolvedSourceCommit: oid("cc719e04b001"),
      resolutionEvidence: ["The exact locked source revision selects the indexed package repository."],
      indexedSourceCommit: oid("12c87a8e7bf0"),
      selectedChangeCommit: oid("8f2a91c7d48b"),
      state: "contains-original",
      activeBehaviour: "reverted",
      basisCommit: oid("12c87a8e7bf0"),
      revertCommit: oid("d17ab8100f33"),
      lastMatchingCommit: oid("d17ab8100f33"),
      reason: "The selected change is in ancestry, but a later revert restores the earlier behaviour.",
      evidence: evidence("The consumer lock includes the reverse patch commit that reverts the selected change.", "confirmed", "composer.lock", [], "stable Git patch-id and reverse patch"),
      limitations: [],
    },
  ],
  githubAssociations: {
    pullRequests: [
      {
        repository: "company/commerce",
        repositoryUrl: "https://github.com/company/commerce",
        commit: oid("8f2a91c7d48b"),
        number: 418,
        url: "https://github.com/company/commerce/pull/418",
        title: "Preserve late-static order totals",
        state: "closed",
        mergedAt: "2024-03-20T10:15:00.000Z",
        headRepository: "client-fork/commerce",
        headRepositoryUrl: "https://github.com/client-fork/commerce",
        headCommit: oid("41a8c2290be1"),
        confidence: "confirmed",
        evidence: evidence("The merged pull request head commit matches the indexed fork commit.", "confirmed", "src/BaseOrder.php", [], "GitHub commit association"),
        limitations: [],
      },
      {
        repository: "company/commerce",
        repositoryUrl: "https://github.com/company/commerce",
        commit: oid("f42ce9013a77"),
        number: 429,
        url: "https://github.com/company/commerce/pull/429",
        title: "Forward-port total calculation",
        state: "open",
        headRepository: "client-fork/commerce",
        headRepositoryUrl: "https://github.com/client-fork/commerce",
        headCommit: oid("f42ce9013a77"),
        confidence: "confirmed",
        evidence: evidence("The GitHub commit-to-PR association reports this exact head commit on the pull request.", "confirmed", "src/BaseOrder.php", [], "GitHub commit-to-PR association"),
        limitations: ["Association does not imply that the open pull request is deployed or released."],
      },
    ],
    releases: [
      {
        repository: "company/commerce",
        repositoryUrl: "https://github.com/company/commerce",
        tagName: "v2.4.0",
        tagCommit: oid("9bb77d008ac2"),
        url: "https://github.com/company/commerce/releases/tag/v2.4.0",
        name: "Commerce 2.4",
        publishedAt: "2024-04-06T09:00:00.000Z",
        draft: false,
        prerelease: false,
        targetCommitish: "2.x",
        confidence: "possible",
        evidence: evidence("The local v2.4.0 tag resolves to this exact local commit; the same-name GitHub release was found without resolving its remote tag object.", "possible", "composer.lock", ["Remote and local tag commit equality is unverified."], "local tag plus GitHub release name"),
        limitations: ["The GitHub release tag name matches, but remote and local commit equality is unverified."],
      },
    ],
    limitations: ["GitHub associations describe repository metadata; they do not prove deployment.", "Release enrichment is bounded to 25 tags, 5 concurrent requests and 30 seconds; API limits or timeouts degrade to partial results."],
  },
  limitations: ["Active behaviour is a static assessment at each listed basis commit, not runtime execution proof."],
};

let state: unknown;
window.acquireVsCodeApi = () => ({
  postMessage(message: unknown) {
    const typed = message as { type?: string; mode?: GraphResponse["mode"]; eventId?: string; url?: string };
    if (typed.type === "ready") queueMicrotask(() => window.postMessage({ type: "graph", graph }, "*"));
    if (typed.type === "changeMode" && typed.mode) {
      graph.mode = typed.mode;
      window.postMessage({ type: "graph", graph }, "*");
    }
    if (typed.type === "compare") queueMicrotask(() => window.postMessage({ type: "comparison", result: comparison }, "*"));
    if (typed.type === "checkInclusion" && typed.eventId) queueMicrotask(() => window.postMessage({ type: "inclusion", eventId: typed.eventId, result: inclusion }, "*"));
    if (typed.type === "openGitHub" && typed.url) document.body.dataset.previewGitHubUrl = typed.url;
    if (typed.type === "expand") window.postMessage({ type: "error", message: "Preview expansion is fixture-only.", detail: "Production expansion is served by the companion." }, "*");
  },
  getState: () => state,
  setState: (value: unknown) => { state = value; },
});
