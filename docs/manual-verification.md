# Manual verification guide

Record every check as passed, failed, blocked or not run. Keep source/test evidence separate from a running companion, rendered extension, and external GitHub evidence.

## 1. Automated baseline

```sh
npm install
npm run build
npm run check
npm test
npm run fixture
```

Expected: all workspaces build; contract/parser/persistence/history/extension helper/fixture tests pass; the fixture manifest lists three repositories, exact commits and the deterministic `commerce-v1-to-v2-adoption` comparison. A TypeScript build does not prove the running companion or rendered webview.

## 2. Companion runtime

```sh
TRACE_FIXTURE_MODE=1 npm run dev:companion
```

Verify:

1. The process binds only to loopback and prints a dashboard URL.
2. An unauthenticated API call returns 401.
3. `GET /health` works without a token. `/v1/status` requires `X-Trace-Protocol: 1.0` but is deliberately a no-data public probe; repository, index, graph, source and mutation routes also require `Authorization: Bearer …`.
4. A wrong protocol header returns the documented mismatch error and `/v1/status` reports fixture mode and protocol `1.0`.
5. The dashboard labels fixture data and shows all three repositories.
6. Refresh the shared package. Confirm a new generation is published and unchanged file analyses are reused.
7. Cancel a refresh. Confirm the previous complete generation remains queryable.
8. Restart the companion. Confirm the published generation survives.
9. Submit two refreshes for one repository and confirm `/v1/jobs` reports one job with a coalesced request count rather than two concurrent scans.
10. With a disposable fixture scan queued, call `POST /v1/index/cancel`; confirm it becomes cancelled and the last published generation remains active.
11. Edit a PHP file with watching enabled; confirm one debounced filesystem job appears. Repeat with `TRACE_WATCH=0` and confirm only manual refresh schedules work.
12. Inspect the scanner snapshot and job fields for queue/active counts, capacity, stage, cache hits/misses, filesystem fallback, duration and throughput.

## 3. Extension development host

Build and open an Extension Development Host on the generated fixtures:

```sh
npm run build
code --extensionDevelopmentPath="$PWD/packages/extension" "$PWD/packages/fixtures/generated"
```

If the extension asks for authentication, run **Trace: Set Companion Client Token** and paste the token from the file path printed by the companion. Wait for the VS Code status bar to move through discovery/queue/index progress to **Trace index ready**. **Trace: Refresh Current Repository** must queue, not synchronously run, a rescan for the active repository; **Trace: Open Companion** must open the loopback dashboard.

After loading any graph, switch to a non-default mode, close the Trace tab, and run **Trace: Open Trace**. The tab must be recreated with the last graph and mode without requiring another trace request. Close it again and click the primary Trace status item; it must reopen the same way. In a fresh Extension Development Host with no previous graph, **Trace: Open Trace** must trace the active PHP symbol, or show the existing “Open a PHP file” guidance when no editor is active.

With a PHP editor active, confirm all six exploration commands below appear in the Command Palette and **Trace: Explore Selected Symbol** also appears in the editor context menu. The exploration commands should not be offered by those PHP-gated menus for a non-PHP editor.

### Fixture click-through tour

Use the files below relative to `packages/fixtures/generated`. Put the cursor on the named declaration before running a command. The matching top tab should become active; clicking the same tab after the first trace exercises the equivalent webview action.

| File and symbol | Command / tab | Expected evidence |
| --- | --- | --- |
| `consumer-store/src/Order.php` — `Order::calculateTotal` | **Trace: Explore Selected Symbol** / **Impact** | Focus is `Client\Store\Order::calculateTotal`. The inspector shows its `bool $includeTax = true` parameter, `int` return and the overridden `BaseOrder` contract provenance. The graph includes the confirmed override, explicit `parent::calculateTotal` call, typed caller and Composer consumer nodes. |
| `consumer-store/src/Order.php` — `Order::calculateTotal` | **Trace: Show Parent Implementation** / **Origin** | The alias `SharedOrder` resolves to `Company\Commerce\BaseOrder`; the override and calls-parent edges both reach `BaseOrder::calculateTotal`. The wider lineage reaches `PricedOrder`, `PricingMath`, `RegionalOrder`, `StandardOrder` and `WholesaleOrder`. |
| `shared-commerce/src/BaseOrder.php` — `BaseOrder::calculateTotal` | **Trace: Show Overrides** / **Inheritance** | `PricedOrder::calculateTotal` supplies the interface contract. `WholesaleOrder::calculateTotal` and `Client\Store\Order::calculateTotal` are confirmed overrides. `StandardOrder` inherits through `RegionalOrder`; neither class redeclares the method, so effective ancestor lookup must skip the intermediate parent. |
| `consumer-store/src/Order.php` — `Order::calculateTotal` | **Trace: Find Callers** / **Callers** | `CheckoutService::total` is a confirmed typed caller and the explicit parent call continues to `BaseOrder::calculateTotal`. The deliberately dynamic invocation in `CheckoutService::dynamic` has no statically provable target and therefore must not be shown as a relationship. |
| `shared-commerce/src/BaseOrder.php` — `BaseOrder::calculateTotal` | **Trace: Find Consumer Projects** / **Consumers** | `client-store` is confirmed symbol usage and resolves `company/commerce` at the indexed current source commit. `client-reporting` is dependency-only, resolves the older `v1.0.0` source commit, and reports exact-revision symbol analysis as unavailable rather than borrowing current-head results. |
| `shared-commerce/src/BaseOrder.php` — `BaseOrder::price` | **Trace: Explore Selected Symbol** / **Impact** | The inspector shows the native `PriceContext $context` parameter, `Money` return, summaries and parameter/return descriptions. Provenance reaches `PricedOrder::price`; implementation reaches `PricingMath::priceSubtotal` and the late-static `static::currencyCode()` call. |
| `shared-commerce/src/BaseOrder.php` — `BaseOrder::create` | **Trace: Explore Selected Symbol** / **Origin** | The declaration returns `static` and constructs `new static($subtotal)`, preserving late-static binding evidence without claiming a single runtime subclass. |
| `shared-commerce/src/Legacy/LegacyPriceAdapter.php` — `LegacyPriceAdapter::copy` | **Trace: Explore Selected Symbol** / **Origin** | With no native parameter or return declarations, the inspector falls back to PHPDoc descriptions and shows `PriceContext`/`Money` as PHPDoc-derived object type evidence. |
| `consumer-store/src/CheckoutService.php` — `CheckoutService::quote` | **Trace: Find Callers** / **Impact** | The `BaseOrder`-typed call to `BaseOrder::price` is confirmed, and `CheckoutController::summary` is the upstream typed caller that demonstrates the transitive impact path. |
| `consumer-store/src/CheckoutService.php` — `CheckoutService::dynamic` and `unresolved` | **Trace: Find Callers** / **Callers** | These are negative-scope examples: a variable method name and an `object` receiver do not produce a precise relationship. Their absence is expected and must not be relabelled as confirmed, possible or unresolved edges. |
| `consumer-store/src/ReceiverInferenceShowcase.php` — the three `*PropertyCheckout::quote` methods | **Trace: Explore Selected Symbol** / **Callers** | Native property, promoted property and typed-constructor assignment each resolve a confirmed call to `BaseOrder::price`, with distinct `native-property`, `promoted-property` and `constructor-assignment` diagnostics. |
| `consumer-store/src/ReceiverInferenceShowcase.php` — `localNew`, `variableAlias`, `factoryReturn` | **Trace: Explore Selected Symbol** / **Callers** | The imported `DefaultOrder` alias resolves to `StandardOrder`; the variable alias preserves it; the simple native `BaseOrder` factory return resolves. Each produces a confirmed effective call to `BaseOrder::price`. |
| `consumer-store/src/ReceiverInferenceShowcase.php` — `unionReceiver`, `phpDocReceiver` | **Trace: Explore Selected Symbol** / **Callers** | The union exposes possible `RetailPriceGateway::price` and `WholesalePriceGateway::price` targets. PHPDoc supplies one possible `BaseOrder::price` target with the not-enforced-by-PHP limitation. Neither is promoted to confirmed. |
| `consumer-store/src/ReceiverInferenceShowcase.php` — `reassignedReceiver`, `dynamicMethod` | **Trace: Explore Selected Symbol** / **Callers** | Reassignment invalidates the earlier native `BaseOrder` type. The dynamic method retains `BaseOrder` only as diagnostic context. Both have empty target lists and no invented call edge. |
| `consumer-store/src/ReceiverInferenceShowcase.php` — `containerGet`, `containerMake`, `containerResolve` | **Trace: Explore Selected Symbol** / **Callers** | Each chained `price` receiver is unresolved via `container-lookup`; configured runtime bindings are not guessed. Calls to the container API itself may be independently resolved and must not be confused with resolving its returned service. |
| `consumer-store/src/ReceiverInferenceShowcase.php` — `runtimeClassString`, `reflectionFactory`, `magicFallback` | **Trace: Explore Selected Symbol** / **Callers** | Class-string/PHPDoc and magic-proxy types remain diagnostic-only candidates; reflection retains its documented upper bound. Resolution methods are `runtime-class-string`, `reflection` and `magic-call`, all with empty target lists. |
| `shared-commerce/src/BaseOrder.php` — `BaseOrder::calculateTotal` | **Trace: Show Symbol History** / **History** | The timeline shows introduction, discount implementation, documentation-only, formatting-only, signature and later change/revert observations. Select an event to inspect author/date/category, open its read-only before/after diff, then **Check releases and consumers** for exact inclusion and active-behaviour evidence. |
| `shared-commerce/src/Support/PricingMath.php` — `PricingMath::discountedSubtotal` | **Trace: Show Symbol History** / **History** | The timeline follows the old `PricingRules.php::applyDiscount` occurrence. `git-rename-diff` confirms the path mapping and `syntax-fingerprint-and-git-change` supplies possible method continuity; because both path and logical identity change, overall symbol lineage remains possible. |

### Receiver diagnostic matrix

Use `expectations.receiverInference` in `fixture-manifest.json` as the exact oracle. For every listed caller, focus the caller method and compare its receiver-analysis metadata field by field: `expression`, optional `methodName`, `status`, ordered `candidateTypes`, `resolutionMethod`, `confidence` and `limitations`. Then compare graph call targets to `expectedCallTargets`.

| Expected class | Cases | Required result |
| --- | --- | --- |
| Confirmed resolved | `native-property`, `promoted-property`, `constructor-assignment`, `local-new-import-alias`, `variable-alias`, `typed-factory-return` | One exact target; confirmed confidence; no limitation. Imported alias/variable/factory provenance must remain visible through the distinct resolution method. |
| Possible resolved/ambiguous | `native-union`, `phpdoc-only` | The union is ambiguous with two actual candidate targets. PHPDoc is resolved to one candidate but possible. Candidate order and limitations match the manifest. |
| Invalidated | `reassignment-invalidation` | `$order` has no remaining candidate after assignment from `object`; status/confidence are unresolved and no stale `BaseOrder::price` edge exists. |
| Dynamic | `dynamic-method-name` | `$order` retains `BaseOrder` as diagnostic context, but status is dynamic, method name/targets are absent and confidence is unresolved. |
| Runtime lookup | `container-get`, `container-make`, `container-resolve` | Exact chained expressions are recorded with `container-lookup`, no candidates and no target edge. |
| Runtime construction/dispatch | `runtime-class-string`, `reflection-factory`, `magic-fallback` | Diagnostic candidates may preserve the declared upper bound/proxy type, but status/confidence remain unresolved and target lists stay empty. |

A pass requires both halves: supported cases produce only the expected confirmed/possible edges, while blocked cases remain discoverable in receiver metadata without an edge. Do not treat an empty target list as evidence that the call cannot happen at runtime.

### Top-to-bottom PHP call flow

For PHP `calls` and `calls-parent` relationships, read the graph from top to bottom: the caller is above the callee and the arrowhead points downward toward the called method. Vertical position is not an execution-order claim for inheritance, interface, trait, type, Composer, release or history relationships; use those edges' labels and arrowheads.

| Focus and mode | Required vertical order | Verify |
| --- | --- | --- |
| `CheckoutService::quote` — **Impact** | `CheckoutController::summary` → `CheckoutService::quote` → `BaseOrder::price` | Each caller is above its callee, both arrowheads point downward, and the focused `quote` node remains visually distinct in the middle of the chain. |
| `Order::calculateTotal` — **Impact** | `CheckoutService::total` → `Order::calculateTotal` → `BaseOrder::calculateTotal` | The typed call enters the focused override from above; the explicit `parent::calculateTotal` edge leaves it downward. The edge labels remain readable without crossing their nodes. |
| `BaseOrder::price` — **Callers** | `CheckoutService::quote` → `BaseOrder::price` | The confirmed cross-repository call points from the consumer caller to the package callee. PHPDoc/type/trait neighbours must not invert the call edge or be described as runtime steps. |
| Expand `CheckoutService::quote` in either direction | Existing call chain remains caller → callee from top to bottom | Newly merged nodes do not reverse an existing call edge, overlap its arrowhead, or move the selected node off-screen. **Fit** restores the complete chain without changing its direction. |

Repeat the first two rows after resizing to a narrow editor column. A pass requires the call direction to remain readable without relying on colour or node selection. Record reversed arrows, same-rank caller/callee placement, clipped arrowheads or unstable direction after expansion as failures, even when the relationship data itself is correct.

On any populated graph, complete this UI pass:

1. Select a node in the graph, then the same node in the synchronized **Relationships** tree. Confirm the details panel shows kind, repository/revision/path, metadata and **Open source** when source exists.
2. Select an edge. Confirm the collapsible Source, Evidence, Repository and Context sections show from/to, relationship type, confidence, repository, commit, source range, resolution method and limitations. **Open evidence** and **Open in VS Code** must select the recorded file/range.
3. Search for `calculateTotal`; non-matches should dim in the graph and disappear from the relationship list. Change **Confidence** between **All**, **Confirmed**, **Possible** and **Dependency only**. `LegacyPriceAdapter::copy` and `BaseOrder::create` provide possible PHPDoc/late-static evidence; the reporting project provides dependency-only evidence. The fixture has no positive **Unresolved** edge, so that filter should produce no matching relationship rather than relabel confirmed evidence.
4. Select several nodes and edges, then use the selection breadcrumbs to return to an earlier selection. Double-click a node or use **Expand relationships** and confirm new relationships merge without losing the focus node.
5. Exercise zoom in, zoom out, fit, pan and the minimap (clicking it fits the graph). Confirm the legend uses node labels/icons and confirmed/dashed/dotted line patterns in addition to colour.
6. Resize Trace to a narrow editor column. Use the **Relationships** and **Details** toggles; pressing Escape should close either drawer without horizontal overflow.
7. Confirm the footer reports indexed revision, indexed source versus local overlay, repository scope and partial/up-to-date state.

Fixture coverage limits: **Possible** is positively demonstrated by union/PHPDoc receiver candidates, PHPDoc type references, late-static and method-rename evidence. **Unresolved** and **Dynamic** are positively demonstrated as receiver diagnostics, not call edges, by invalidation, container lookup, runtime construction, reflection, magic and dynamic method cases. The fixture does not execute a container, reflection or magic method and does not create a false “possible” edge for them. It positively covers confirmed Git path-move evidence, possible combined symbol lineage, different-SHA stable-patch equivalence, revert, reapply and unavailable-basis activity. It does not create competing incomparable merge tips or exhaust the history bound; those remain explicit negative/limitation checks. The intermediate ancestor, PHPDoc object types/descriptions, native types, interface/trait provenance, late-static binding and impact chain are also positive examples.

Verify live editor following:

1. Leave the Trace tab visible and return focus to the PHP editor beside it.
2. Move from `CheckoutService::total` to `Order::calculateTotal`; confirm the existing Trace tab updates without rerunning a command or stealing editor focus.
3. Move from the method declaration to the `Order` class declaration; confirm the focus node changes from the method to the class.
4. Switch Trace to another exploration mode, move the cursor again, and confirm that mode is preserved.
5. Move rapidly across several lines and confirm only the final debounced selection becomes visible.
6. Hide or close Trace, then move the cursor; confirm no follow request opens or reveals the panel.
7. Run **Trace: Open Trace** and confirm the retained graph and current mode return; closing the tab must not make the view permanently unavailable.
8. Set `trace.followActiveEditor` to `false` and confirm the graph remains fixed until a Trace command is run manually.

Tab through the mode buttons, search, confidence selector, graph controls, relationship tree, inspector actions and timeline. Confirm visible focus states and that selecting a relationship in the tree updates the same inspector as selecting its graph edge.

Switch between a built-in light theme, dark theme and a high-contrast theme while Trace remains open. Confirm all chrome, text, controls, graph nodes, edge labels, semantic colours, notifications and focus states inherit VS Code tokens immediately. The selected node must remain distinguishable, graph zoom/pan must not jump, and resizing the editor column must refit the graph without clipping nodes.

## 4. Local overlay

Edit the return expression in `consumer-store/src/Order.php` without saving.

1. Trace again and confirm **Local overlay** is visible.
2. Edit rapidly and confirm live follow refreshes the current selection and only the latest debounced request becomes visible.
3. Save or revert the edit and confirm overlay evidence is invalidated.
4. Confirm no unsaved source was added to history or persisted after companion restart.
5. Confirm the UI says cross-file working-tree analysis is partial.

## 5. Symbol history

Trace `Company\Commerce\BaseOrder::calculateTotal` and open **History**.

Verify:

- Earliest observed introduction matches the fixture manifest.
- The discount commit is an implementation change.
- The docblock-only commit is documentation, with the implementation body unchanged.
- The currency commit does not become the method's last implementation change.
- The whitespace commit is formatting only.
- The tax option is a signature/contract change.
- The trait call-site change remains a `BaseOrder::calculateTotal` implementation observation; trait lineage is shown on the trait method's own history rather than inferred from this caller.
- Before/after source and accessible diff match the selected event.
- For a selected event, **Check releases and consumers** shows containing tags from both `main` and `release/1.x` without claiming one globally linear “first release.”

Then trace `Company\Commerce\Support\PricingMath::discountedSubtotal` and verify the two lineage events at `historyEvidence.lineage.commit`:

1. **Move** records `PricingRules.php` → `PricingMath.php` and old/new symbols. Overall lineage confidence is possible because logical identity also changed; it carries confirmed `git-rename-diff` path evidence and possible `syntax-fingerprint-and-git-change` symbol evidence.
2. **Rename** records `applyDiscount` → `discountedSubtotal`, both old/new paths, possible confidence and `syntax-fingerprint-and-git-change` evidence.
3. The rename limitation says structural equivalence cannot prove author naming intent. Similar or duplicate candidates must not be linked.
4. A bounded-history test reports its limit; shallow or unavailable history must not be presented as complete.

## 6. Commit/release/consumer inclusion

Use `expectations.historyEvidence` from `fixture-manifest.json` and verify each exact basis independently:

| Case | Expected inclusion/activity evidence |
| --- | --- |
| `regression-reverted-at-head` | Original ancestry is **contains original**, while active behaviour is **reverted**. `revertCommit` and `lastMatchingCommit` identify the exact reverse patch. |
| `marker-originally-active` | At the apply commit, active behaviour is **likely active** and `lastMatchingCommit` is that apply. |
| `marker-reverted` | At the revert commit, active behaviour is **reverted** with the exact reverse commit. |
| `marker-reapplied-at-head` | The original remains included, but the later reapply is the `lastMatchingCommit`, so active behaviour returns to **likely active**. |
| Equivalent discount branch/release | The original implementation SHA is absent, the branch cherry-pick has a different SHA and the same stable patch ID, so inclusion is **likely equivalent**, `equivalentCommit` identifies it and activity is **likely active**. Tag `v1.1.0-equivalent` points at that exact commit and its release assessment reports the same basis/state/activity fields. |
| `unavailable-basis` | Inclusion/activity are **unknown** with an unavailable-revision limitation and no latest-branch fallback. |

Also confirm release assessments carry the same state, basis and active-behaviour fields. **Likely equivalent** and **likely active** are deliberately qualified: patch identity does not prove identical runtime context, code execution or deployment. Force a small traversal bound and confirm activity becomes **unknown**; create competing apply/reverse tips only in a disposable repository and confirm incomparable maxima also produce **unknown**, not a timestamp-based guess.

## 7. Arbitrary historical graph comparison

Generate a request payload from the deterministic fixture scenario. This deliberately omits manifest-only expectations and package-reference assertions from the API body:

```sh
jq '.expectations.historicalComparison
  | {protocolVersion, mode,
     before: {revisions: .before.revisions, selection: .before.selection},
     after: {revisions: .after.revisions, selection: .after.selection}}' \
  packages/fixtures/generated/fixture-manifest.json \
  > /tmp/trace-historical-comparison.json
```

Send that JSON to authenticated `POST /v1/trace/compare` and record it as companion API evidence. Then verify the same basis through the extension as a separate rendered-webview layer: trace `BaseOrder` in **Impact**, choose **Compare**, enter all six full commits from the manifest's before/after maps, and choose **Compare relationships**.

| Check | Expected result |
| --- | --- |
| Repository basis | `before` and `after` freshness each list exactly `company-commerce`, `client-store` and `client-reporting` at the commits supplied on that side. All three `basisChanges` entries are `changed`; no commit comes from an active generation or branch name. |
| Added relationships | The diff includes the new `PricingMath` trait edge, `BaseOrder::price` declaration/interface edge, `CheckoutService::quote` → `BaseOrder::price`, and `CheckoutController::summary` → `CheckoutService::quote`. |
| Removed relationships | `BaseOrder` → `PricingRules` is removed. Treat the trait rename as remove-plus-add unless independent lineage evidence exists. |
| Changed relationships | The two consumer `requires` relationships report `evidence` and `resolvedSourceCommit` changes. Stable logical `overrides` and `calls-parent` relationships remain unchanged when only their commit basis changes; the corresponding method nodes carry signature/implementation changes instead of duplicating edge identities. |
| No latest fallback | The comparison-after reporting commit is `commits.dependencyUpdate`, whose lock points at the new package commit. Reporting repository HEAD is the later `legacyTrackRestore`, whose lock points back to v1. The after graph must use the former; using HEAD must fail this check. |
| Selection identity | Each clean selection's repository/commit pair exactly equals its own side's revision-map entry. Both graphs retain the same logical `BaseOrder` focus while occurrences remain revision-specific. |

In the rendered comparison, confirm the explicit basis table lists all three repositories and both resolved commits. Switch between **Added**, **Removed**, **Changed** and **Unchanged**; counts and graph contents must agree with the API response, changed-field details must remain inspectable, and **Close comparison** must restore the original graph. The dialog must reject abbreviated commits and must require both sides for every listed repository before sending a request.

Run these negative cases against a disposable copy of the request:

1. Replace one full commit with an unavailable 40-character hash. Expect a hard revision-not-found response and no partial comparison.
2. Make a selection commit differ from its side's revision map. Expect validation failure; the companion must not repair it from the map or active index.
3. At the API boundary, remove the same non-selected repository from one side. Confirm it is absent from that graph and appears as an added/removed basis change; it must not be filled from the active generation. Separately confirm the extension dialog prevents an incomplete pair for its visible repositories.
4. Set either selection to `dirty: true` or add overlay source. Expect rejection because historical comparison accepts clean Git-object selections only.

The fixture's expected relationship diff is static-analysis evidence. It does not prove runtime execution, deployment, semantic equivalence, or complete rename lineage.

## 8. Composer repository identity and aliases

Read the exact fixture paths/commits from the manifest rather than checking out a historical revision:

```sh
manifest=packages/fixtures/generated/fixture-manifest.json
store=$(jq -r '.repositories[] | select(.id == "client-store") | .path' "$manifest")
reporting=$(jq -r '.repositories[] | select(.id == "client-reporting") | .path' "$manifest")
fork_commit=$(jq -r '.expectations.composerResolution.customFork.consumerCommit' "$manifest")

jq '.expectations.composerResolution' "$manifest"
git -C "$store" show HEAD:composer.json
git -C "$store" show HEAD:composer.lock
git -C "$reporting" show "$fork_commit:composer.json"
git -C "$reporting" show "$fork_commit:composer.lock"
```

Verify every field independently; do not infer one column from another:

| Scenario | Declared and resolved fields | Repository identity result |
| --- | --- | --- |
| Shared package | `branchAliases` contains `dev-main` → `2.0.x-dev` and `dev-feature/pricing` → `2.1.x-dev`. | These are package compatibility metadata, not Git refs selected for a consumer and not indexed revisions. |
| Store path repository | Constraint is exactly `dev-feature/pricing as 2.1.x-dev`; base is `dev-feature/pricing`; alias is `2.1.x-dev`; locked version is `dev-feature/pricing`. Source reference/URL/commit are absent. Distribution type is `path`, its reference equals the shared HEAD, URL is `../shared-commerce`, and `resolvedPath` is the canonical shared fixture path. | Resolution is `path` by method `path`; indexed repository is `company-commerce` at the manifest's exact shared HEAD. The path candidate is canonical. The custom VCS and Composer candidates remain visible with `canonical: false` but do not override it. |
| Reporting custom-fork commit | Constraint is exactly `dev-fork/maintenance as 1.0.x-dev`; base and alias remain separate; locked version is `dev-fork/maintenance`. Source reference/compatibility source commit equal the shared HEAD, while source URL normalizes to `code.example.invalid/forks/commerce-fork`. Dist/path fields are absent. | Resolution remains `declared-only` with method `unresolved`; indexed repository/revision are absent. The equal object ID does not identify the fork, and the non-canonical VCS/Composer declarations do not prove selection. |
| Multiple indexed candidates (focused test only) | Create two disposable indexed package records with the same Composer name and no stronger mapping/path/URL match. | Expect `ambiguous`, no selected indexed repository/revision, and evidence naming the candidate count. Add an explicit package mapping and expect it to win. The generated three-repository tour intentionally stays stable and does not add this duplicate. |

Also inspect every `repositoryCandidates` entry separately: type, sanitized URL, normalized URL or resolved path, canonical flag, and optional package name. A custom VCS entry is candidate evidence only. Confirm no alias is copied into `resolvedSourceReference`, `resolvedSourceCommit` or `indexedRevision`, and no active/default branch is used to fill a missing exact field.

The manifest and generated-file checks above are source/fixture evidence. To claim companion resolution, inspect the corresponding dependency metadata from a graph response reconstructed at that exact consumer commit and compare all fields to `expectations.composerResolution`; do not substitute reporting HEAD, which was deliberately restored to the legacy dependency.

## 9. Real GitHub boundary (optional)

First run without a GitHub credential. `expectations.githubAssociations.expectedWithoutCredentials` requires empty association arrays plus the explicit no-token limitation while local release and consumer inclusion remain present. With a credential but the fixture's fictional `code.example.invalid` source URL, expect the unsupported/non-normalized-GitHub limitation from `expectedWithUnsupportedHost`; Trace must not infer a GitHub owner/repository from the Composer package name.

With a least-privilege credential, add one explicitly selected GitHub repository and verify discovery filters, private access, manual refresh and remote-link opening. For a pull request, verify the result records the exact repository/repository URL, selected commit, PR URL, confirmed confidence, evidence and limitations; the evidence method must be the commit-to-pull-request API and must not claim merge from association alone. For a release, verify the exact local tag name/tag commit remain the basis, confidence is possible, and the limitation says the remote tag object/commit was not independently verified; same-tag-name publication must not be described as exact commit equality or deployment.

Exercise partial failure without changing local Git evidence: make one association request fail or exceed its configured bound while another succeeds. The response must retain local release/consumer inclusion, retain successful associations, and append a sanitized association-level limitation for the failure/bound. Verify release enrichment considers at most 25 exact local tags, uses no more than five concurrent lookups and returns within the 30-second overall budget with unfinished work represented as limitations. Confirm the token never appears in the dashboard HTML, extension webview, logs, clone URL display, evidence, limitation text or API response.

This is separate external-integration evidence. If no credential/network is available, report it as **not run**, not passed from fixture results.

## 10. Package and clean-install smoke

```sh
npm run package:extension
code --install-extension packages/extension/trace-vscode-*.vsix
```

Launch a normal VS Code window, repeat the origin and consumer flows, then inspect the extension-host and webview developer consoles. Record product errors separately from unrelated extension/third-party noise.

## 11. Large-workspace scanner benchmark

Use a repository you are authorised to read and keep the output under `/tmp`:

```sh
npm run benchmark:scanner -w @trace/fixtures -- \
  --root /absolute/path/to/workspace \
  --source auto \
  --concurrency 1,2,4 \
  --warmup 1 \
  --iterations 3 \
  > /tmp/trace-scanner-benchmark.json
```

Verify:

1. The report parses as JSON and contains `pathDisclosure`, `contentDisclosure` and `rawErrors` set to `suppressed`.
2. Searching the report for the input root basename and a known file/package/symbol name returns no matches.
3. `auto` discovers the root Composer files and installed package roots even if the root Git repository tracks very little.
4. The selected/readable/skip/error aggregates are plausible before using timings for tuning.
5. Median and p95 duration/throughput are present for every requested concurrency.
6. Re-run with `--source git-tracked` and explain the difference rather than treating either scope as a complete application index.

This is scanner I/O/hash evidence. PHP parsing, SQLite publication, queue cancellation/retry, cache reuse, and end-to-end companion performance remain separate checks.

## 12. CodeLens counts and query benchmark

Start a fresh fixture-mode companion, then create a private request workload from the exact active shared-package commit:

```sh
shared_commit=$(jq -r '.repositories[] | select(.id == "company-commerce") | .head' packages/fixtures/generated/fixture-manifest.json)
jq -n --arg commit "$shared_commit" '{requests:[{
  repository:{repositoryId:"company-commerce",commit:$commit},
  items:[
    {id:"total",path:"src/BaseOrder.php",range:{startLine:1,startColumn:0,endLine:1,endColumn:0},symbol:"Company\\Commerce\\BaseOrder::calculateTotal"},
    {id:"price",path:"src/BaseOrder.php",range:{startLine:1,startColumn:0,endLine:1,endColumn:0},symbol:"Company\\Commerce\\BaseOrder::price"},
    {id:"factory",path:"src/BaseOrder.php",range:{startLine:1,startColumn:0,endLine:1,endColumn:0},symbol:"Company\\Commerce\\BaseOrder::create"}
  ]
}]}' > /tmp/trace-codelens-workload.json

npm run --silent benchmark:codelens -w @trace/fixtures -- \
  --base-url http://127.0.0.1:47173 \
  --token-file "$HOME/.trace/client-token" \
  --workload /tmp/trace-codelens-workload.json \
  --iterations 20 \
  --warmup 1 \
  --cancellation-attempts 3 \
  --cancel-after-ms 1 \
  > /tmp/trace-codelens-benchmark.json
```

Verify:

1. Every response basis equals the requested active repository/commit and generation. Replacing the commit with a different exact hash returns a revision conflict; it must not fall back to HEAD.
2. A genuinely cold sample reports cache misses and `rebuilt: true`; repeated batches report hits with no rebuild. Classifications in the aggregate report must match those counters.
3. Callers and consumers remain separate. A direct call increments callers; only distinct exact indexed Composer package consumers increment consumers. Excluded ambiguous/revision-mismatched dependencies set `partial` with a limitation.
4. No request contains more than 200 items. A 201-item batch or `../` path fails validation before query work.
5. Cancellation is **passed** only when a client abort or HTTP 499 is observed within 100 ms. If all fixture requests finish before the timer, record **not observed** and repeat on the synthetic high-scale corpus.
6. The default gates are cold p95 ≤ 5,000 ms, warm p95 ≤ 20 ms and observed cancellation p95 ≤ 100 ms. `--enforce-thresholds` must exit 2 on a failed or unobserved gate.
7. Search the report and stderr for the workload's repository ID, commit, path and symbol. None may appear. The workload itself remains sensitive and must stay under `/tmp`.
8. Publish a new generation or change a package mapping, then repeat. The first following request must rebuild; old item values must not leak across the new cache identity.

Then verify the rendered extension layer separately:

1. With `trace.codeLens.enabled` true, open a saved fixture PHP file in the local workspace. With the default zero additional delay, confirm the extension sends one VS Code-coalesced batch for the document, never more than the default 120 symbols or hard maximum 200.
2. Confirm zero values are hidden. Non-zero **callers** and **package consumers** render as separate labels, and a partial result includes an explicit partial suffix.
3. Edit the document. Lenses must disappear immediately and the in-flight request must abort. Save it; lenses remain suppressed while the refreshed repository generation is queued/running and return only after that generation is ready.
4. Change `trace.codeLens.delayMs` and `trace.codeLens.maxSymbolsPerDocument`, then confirm debounce and cap behavior change without exceeding 200. Disable `trace.codeLens.enabled` and confirm no requests/lenses remain.
5. Move the active cursor elsewhere before clicking a lens. The command must still use the lens's recorded document URI and symbol position.
6. Publish another generation and confirm the repository's extension-side cache clears; an old-generation response must not reappear after the new one.

For deterministic high-scale evidence, run the synthetic backend comparison with peak-RSS capture:

```sh
TRACE_LENS_BENCH_SYMBOLS=200000 \
TRACE_LENS_BENCH_RELATIONSHIPS=600000 \
/usr/bin/time -l npm run bench:lenses -w @trace/companion \
  > /tmp/trace-codelens-200k.json \
  2> /tmp/trace-codelens-200k.time
```

This synthetic benchmark contains no project source or identity. Record the exact legacy batch, cached cold/warm, cancellation and peak-RSS results for the current build. Do not treat same-process RSS as the incremental cache cost: it also contains the generated corpus, SQLite state and any legacy graph snapshot retained by the comparison.
