# Architecture

## System shape

Trace is a small npm-workspace monorepo with one long-running local companion rather than a fleet of services.

```text
VS Code extension
  workspace discovery + scan status + active editor position/revision
           │ versioned authenticated loopback HTTP (no source text)
           ▼
Node.js companion
  repository adapters → PHP/Composer indexer → SQLite generation
           │                         │
           ├─ graph/history queries  └─ isolated remote cache
           ▼
Authenticated browser UI
  graph + relationship tree + evidence + timeline
```

### `@trace/contracts`

Runtime-validated contracts distinguish a logical symbol, an occurrence at a repository revision, and an ephemeral local overlay. Every graph edge must include evidence and confidence. A protocol version mismatch fails explicitly instead of being interpreted as a malformed graph.

### `@trace/companion`

The companion owns GitHub credentials, Git operations, Composer resolution, PHP parsing, indexing, persistence, history, inclusion queries, jobs, browser sessions, and the primary browser UI. Multiple VS Code windows may share it. It remains running when an editor window closes.

HTTP binds to loopback. The protocol-checked status probe exposes no repository data; repository, index, graph, source and mutation routes require a bearer token. Repository, ref, and path data are passed to process APIs as arguments rather than interpolated into shell commands. Local worktrees are read-only inputs; remote caches are separate directories.

### `trace-vscode`

The extension discovers eligible workspace repositories, publishes scanner status, retains settings and the client token, and publishes the active local PHP editor context. The browser context is deliberately narrower than a trace selection: repository root/identity, relative path, exact indexed commit, dirty flag, selected word range, a validated PHP identifier hint, and a bounded light/dark/high-contrast theme kind only. Import aliases are resolved locally to their fully qualified identifier before publication. It omits raw selected-text contents, document text and document version. Unsupported editors publish a cleared context, and rapid cursor/editor changes cancel stale resolution and publication.

Status and legacy exploration commands request a short-lived, single-use launch ticket over authenticated loopback HTTP, validate that its URL remains on the configured loopback origin, and open the primary browser UI. The ticket is exchanged once for an HttpOnly, SameSite session cookie. The browser polls the current context and requests graphs from published index generations; graph responses exposed to it omit before/after source bodies. Repository paths, symbol labels, evidence details and revision metadata remain potentially sensitive local data even without source text.

### `@trace/fixtures`

The generator creates three independent Git repositories: one Composer library, a consumer with confirmed symbol relationships, and a dependency-only consumer. Deterministic authorship dates and a manifest make history, ancestry and Composer identity assertions reproducible. The store consumer has a canonical path repository plus non-canonical custom alternatives; a dedicated reporting history commit records a fork URL and inline branch alias that deliberately cannot be attached to the indexed upstream by commit equality alone.

## Index model

SQLite stores repositories, revisions, packages, declared dependencies, resolved versions, source commits, symbols, relationships, evidence, history events, jobs, versioned file-analysis cache entries, and index generations. Release tags and ancestry are queried lazily from Git. These package states are intentionally separate:

1. declared Composer constraint;
2. declared base constraint/branch and inline alias;
3. resolved package version, source/dist references and URLs;
4. canonical resolved package path;
5. indexed repository identity and revision.

### Composer repository resolution

Package records retain their owning repository path, sanitized repository URL, normalized repository URL and `extra.branch-alias` map. Dependency records retain configured repository candidates separately from the selected identity. Candidate metadata includes type, sanitized display URL, normalized URL or resolved path where applicable, package name when declared, and Composer's canonical flag. URL credentials, query strings and fragments are stripped before persistence.

Resolution is deterministic and evidence-producing: explicit package mapping (including an optional package root) takes precedence over an exact canonical installed/path location, then normalized source URL, then a unique package name. A path match can therefore identify the local package even when lower-priority custom VCS and Composer candidates are present. A custom repository declaration only proves that Composer was allowed to consider it; the lock's source URL is the stronger repository-identity evidence. An inline alias affects constraint compatibility only and is never substituted for a source reference or indexed revision.

If a tier yields multiple indexed candidates, resolution remains `ambiguous`. If URL/path evidence selects none, Trace does not fall through to a conflicting package-name guess; it retains `declared-only` or `unavailable` plus the failed identity evidence. Equal source object IDs across repositories do not identify a fork because Git objects can be shared across forks. Explicit mapping is the operator-controlled way to resolve otherwise indistinguishable package-name candidates.

Files are cached by versioned content fingerprint. An unchanged inventory reuses its published generation without rewriting graph rows; changed revision-sensitive relationships are recomputed for a new generation. A generation is published transactionally only after its required records are complete; queries continue using the last published generation if a refresh is cancelled or interrupted. Superseded generation rows and old cache/job history are bounded, while an active graph snapshot is cached until the generation signature changes so cursor-follow reports avoid repeatedly decoding the full index.

CodeLens counts use a separate, bounded read cache. One request contains at most 200 items for one exact active repository commit. A generation-wide snapshot indexes symbols by path and pre-aggregates distinct callers plus exact Composer consumer repositories; per-symbol values are then cached. Cache identity includes every active generation ID and package mappings, so publication or mapping changes rebuild the snapshot and clear item values. Responses carry the requested repository generation/commit and distinguish callers from consumers. Snapshot database reads and item processing yield for cancellation, and a disconnected HTTP request aborts remaining work.

The `/v1/lenses/counts` cache remains a bounded companion API and benchmark surface, but the browser-primary extension does not register a CodeLens provider or contribute CodeLens settings. Active editor publication is independently debounced by `trace.followDelayMs` and cancelled when superseded.

Repository work enters a bounded scheduler with separate repository and global file-analysis concurrency. Duplicate requests coalesce, filesystem changes are debounced, automatic Composer discovery waits for capacity, cancellation propagates to analysis slots, and job snapshots/stages are persisted for diagnosis. Composer expansion is limited to packages that are both locked and installed; GitHub discovery alone never authorizes indexing. Completed generations publish atomically, interrupted jobs are marked failed on restart, and history remains lazy. Operational details and the anonymized load harness are documented in [large-workspace scanning, queues and privacy](performance-privacy.md).

## PHP resolution

`php-parser` provides a position-aware AST. The indexer resolves namespaces, imports and aliases before recording declarations, inheritance, interfaces, traits and calls. Parent implementation lookup walks the effective ancestor chain rather than assuming the immediate parent declares the method.

Receiver inference is local and flow-aware. It seeds native and PHPDoc parameters, native/promoted properties and simple constructor assignments; then tracks local `new`, variable aliases, simple branch merges and native method returns. Reassignment replaces or invalidates prior knowledge instead of allowing a stale parameter type to leak into a later call. Imported class aliases are normalized before candidate lookup.

Each method retains receiver-analysis diagnostics independently of graph edges: status (`resolved`, `ambiguous`, `unresolved` or `dynamic`), exact receiver expression, method name when static, candidate types, resolution method, confidence, source range and limitations. One deterministic native candidate can form a confirmed call. Union/intersection or branch candidates form possible calls to actual declared targets; a single PHPDoc candidate is also possible because PHP does not enforce it.

Dynamic method names, service-container `get`/`make`/`resolve` results, runtime class strings, reflection factories and magic fallback keep diagnostic-only candidate context where available but create no invented call target. Their resolution methods (`dynamic-method`, `container-lookup`, `runtime-class-string`, `reflection`, `magic-call` or `invalidated`) make the boundary inspectable. Analysis does not execute constructors, containers, reflection, magic methods or repository code, and does not infer arbitrary interprocedural return values.

## History and inclusion

History reads Git objects without checking out commits. Method fingerprints separate signature, normalized implementation, documentation, and formatting where the syntax and available history allow it. “Earliest observed” is used when clones are shallow or history crosses a repository boundary.

Release inclusion and consumer adoption start with exact Git ancestry, then use stable patch IDs to identify a different reachable apply as **likely equivalent**. Active behaviour is assessed separately by walking the exact basis revision's bounded history for matching apply and reverse patches: the newest ancestry-comparable apply is **likely active**, the newest reverse is **reverted**, and bounded or competing incomparable tips are **unknown**. Evidence records the basis, equivalent, revert and last-matching commits where available. This is textual Git evidence; it does not execute the code, prove deployment, or establish semantic equivalence in a different surrounding context.

GitHub association is a separate optional enrichment step after local inclusion. Pull requests are requested for the exact selected commit in the normalized GitHub repository and can be confirmed as commit associations. Releases are requested by local tag names already assessed at exact local tag commits, but remain possible because the remote tag object/commit is not independently verified. Successful associations carry their repository, URL, exact local commit/tag basis, confidence, evidence and limitations. Release lookups are bounded to 25 tags, run with concurrency five and share a 30-second enrichment budget. Missing credentials, a non-GitHub source URL, bounded results, timeout or an individual API failure adds an association limitation; it does not erase local release/consumer inclusion or successful results from another association request. Neither association proves merge, execution or deployment.

History lineage also keeps its proof explicit. A pure file move with unchanged logical identity can be confirmed by Git rename-diff evidence. When a path move and method/type rename occur together, Git confirms only the path mapping; overall symbol continuity remains possible and additionally requires one unique method with the same syntax-aware implementation fingerprint and structural contract. The event records from/to paths and symbols, overall confidence, full evidence and limitations. Similar names or bodies, multiple matches, unavailable/shallow history, and traversal beyond the configured bound are not silently linked.

## Temporal boundary

A revision-qualified graph answers what a repository contained at one commit. A consumer-adoption query compares the consumers' latest indexed lock state with a selected historical package change. Trace labels these as separate operations. Cross-repository date views must resolve and display a commit for each repository; commit timestamps are not treated as a perfectly synchronized global snapshot.

The authenticated `POST /v1/trace/compare` operation accepts independent `before` and `after` bases. Each basis contains an explicit `Record<repositoryId, fullCommit>` and a clean selection whose repository/commit pair must equal its map entry. The companion resolves every listed Git object and reconstructs each graph from that basis; missing or abbreviated objects, dirty selections and selection mismatches fail the request. A repository omitted from one side is absent on that side and may produce an added/removed basis entry; it is never filled from an active generation. Working-tree contents, default branches and repository HEAD are not fallback sources for a historical side. The extension's comparison dialog is stricter for its current workflow and requires both commits for every repository visible in the graph.

The response returns both complete `GraphResponse` values, explicit per-repository basis changes, and logical node/edge diffs. Diff identity is logical symbol or logical source/type/target relationship identity rather than a commit-scoped database ID. Occurrence, evidence, confidence or metadata differences remain field changes. A trait rename remains a removed old graph edge plus an added new edge; separately recorded history-lineage evidence may connect those occurrences without rewriting the temporal diff. Static graph comparison does not prove runtime execution, deployment or semantic equivalence after a rewrite.
