# Analysis confidence and limitations

Trace explains why every meaningful relationship exists. Confidence is an evidence classification, not a probability score.

| Classification | Meaning | Typical evidence |
| --- | --- | --- |
| Confirmed | Deterministic static evidence establishes the indexed relationship. | AST declaration, resolved parent call, typed receiver call, exact lock source reference, Git ancestry. |
| Possible | Static evidence identifies candidates but cannot choose one target reliably. | Union/ambiguous receiver type, inferred move or rename. |
| Dependency only | The project resolves a package revision, with no symbol-use evidence in indexed scope. | `composer.json` plus exact `composer.lock` entry. |
| Unresolved | Trace cannot inspect or resolve the target accurately. | Missing source commit, dynamic method name, unavailable repository. |

Evidence includes repository identity, indexed commit, path and source range when available, relationship type, resolution method, and known limitations. Repository-controlled labels are display data, never executable markup.

## Supported practical PHP cases

- Namespace/import and alias resolution
- Classes, abstract classes, interfaces and traits
- Parent classes and effective inherited implementations
- Visibility, static declarations and method signatures
- Overrides and explicit `parent::method()` calls
- Trait use and straightforward adaptations/aliases where the parser exposes them
- `$this->method()`, `self::method()`, `parent::method()` and explicit static class calls
- Calls on native or PHPDoc parameters with explicit confidence differences
- Native properties, constructor-promoted properties and simple typed-constructor assignments
- Local `new` expressions, imported class aliases, simple variable aliases and native method-return factories
- Union/intersection and simple branch-merge candidates when each actual target method is indexed
- Reassignment invalidation that prevents stale parameter/property evidence from producing a target

## Deliberate uncertainty

Receiver diagnostics and call edges are separate. A resolved single native candidate can be confirmed. PHPDoc, union/intersection and branch-merge candidates are possible and retain the reason. Reassignment to an unknown expression becomes `invalidated`/unresolved even when the variable originally had a native type.

Dynamic method names, dependency-injection container results, runtime class strings, reflection factories and magic dispatch are not assigned invented precise targets. Their caller metadata records a `dynamic` or `unresolved` status, exact expression, any diagnostic-only upper-bound candidate, resolution method and limitation; `expectedCallTargets` remains empty in the fixture. Late static binding and generated code remain similarly qualified. “No callers found” means no callers were identified in the indexed scope; it does not mean the method is unused.

A descendant that inherits a method is not evidence that the method executes. A package dependency is not evidence that the selected symbol is called or overridden.

## Composer resolution evidence

Composer metadata is presented as a chain of distinct observations rather than one synthetic “installed version”:

- `declaredConstraint` is retained verbatim; `declaredConstraintBase` and `declaredAlias` explain an inline alias without treating either string as a commit.
- `resolvedVersion`, source reference/URL, distribution reference/URL and canonical resolved path come from lock, installed-package and repository metadata. The compatibility `resolvedSourceCommit` field is populated only when the source reference is an exact object ID; it never contains the alias.
- `indexedRepositoryId` and `indexedRevision` identify what Trace actually analysed. They can be absent or differ from the lock evidence, and that disagreement is shown rather than repaired from a branch tip.
- `repositoryCandidates` show configured alternatives and canonical flags. They are candidate evidence, not proof that Composer selected any one entry.

The resolution order is explicit mapping, canonical installed/path identity, normalized source URL, then unique package name. Exact path/URL/mapping matches can be confirmed as repository identity. A unique name is weaker fallback evidence. Multiple matching repositories are `ambiguous`; no identity match remains `declared-only` or `unavailable`. Two repositories containing the same commit are still different identities, so commit equality cannot resolve a fork. A custom VCS/Composer declaration and a dev/inline alias likewise do not prove selection.

## Symbol and history identity

A fully qualified name is only the logical part of an identity. An occurrence also contains repository, exact revision, file and source range; an unsaved overlay has a separate overlay identity. Forks and concurrently installed versions therefore stay distinct.

A pure path move with unchanged logical identity can be confirmed by Git rename-diff evidence. When the logical type or method name also changes, Git confirms the path evidence but overall symbol continuity remains possible; it additionally requires one unique method in the changed file with the same syntax-aware implementation fingerprint and structural contract. The event preserves from/to path and symbol identities plus its evidence and limitations; similar names, multiple matches or a body match outside the Git change do not merge symbols.

History categories are:

- **Implementation:** normalized executable body changed.
- **Signature or contract:** name, parameters, types, visibility, static/abstract/final state or return type changed.
- **Documentation:** attached comments/docblocks changed without code changes.
- **Formatting only:** tokens normalize to the same signature/body/doc content.
- **Relationship:** ancestry, interface, trait or resolved call relationships changed.

History uses path-limited Git observations and records each commit's parent metadata. Traversal is bounded and cancellation-aware. It does not reconstruct a separate first-parent-only timeline or infer continuity when rename evidence is ambiguous. Shallow clones, unavailable revisions and a reached bound are labelled incomplete, and results say “earliest observed,” not “original introduction.”

Historical graph comparison requires an explicit repository-to-commit basis for both sides. Node identity is logical while occurrences remain revision-qualified; relationship identity is logical source/type/target while evidence and occurrence changes are reported separately. Trace rejects unavailable objects, dirty selections and selection/basis mismatches instead of substituting an active generation, working tree or repository HEAD. An omitted repository is absent from that side, not implicitly current. A removed-plus-added relationship may represent a rename, but it is not labelled as continuous lineage without separate evidence.

## Release and consumer semantics

- **Contains original commit:** the selected commit is an ancestor of the exact assessed revision.
- **Likely equivalent:** the original is not an ancestor, but a different reachable commit has the same stable patch ID.
- **Does not contain original commit:** bounded history contains neither the original nor a matching apply patch.
- **Unknown:** the exact source reference, stable textual patch or required history is unavailable.

The separate active-behaviour field is **likely active** when the last ancestry-comparable matching patch is an apply, **reverted** when it is a reverse, and **unknown** when traversal is bounded or competing matching tips cannot be ordered. `basisCommit`, `equivalentCommit`, `revertCommit` and `lastMatchingCommit` make that decision inspectable.

Stable patch identity is textual evidence, not semantic proof; changed surrounding code can change runtime meaning. Active-behaviour inference does not execute code. A lock file describes an indexed repository state and does not prove what is deployed. Version strings and commit messages alone are not used as ancestry, equivalence or revert proof.

GitHub associations do not strengthen local Git inclusion beyond their own evidence. A pull request is confirmed only as an association returned for the exact repository and commit; it is not thereby confirmed merged. A release association is possible evidence that same-tag-name release metadata exists; the exact local tag commit remains the assessment basis, while remote tag object/commit equality is not independently verified. It is not deployment proof. Missing credentials, unsupported hosts, bounded pages/tags, timeouts, rate limits and per-request failures are reported as association limitations. Local inclusion remains usable, and partial GitHub success remains visible, when another association lookup fails.

## CodeLens count semantics

CodeLens callers are distinct indexed `calls`/`calls-parent` source symbols for the exact active generation. Package consumers are distinct repositories whose Composer dependency resolves exactly to the indexed package/revision. They are separate counts: dependency is not a call, and a call does not prove deployment or runtime execution. Ambiguous, declared-only, unavailable or revision-mismatched dependencies are excluded and make the consumer count partial with a limitation. A missing/ambiguous symbol range is also partial rather than silently counted as zero.

Requests are accepted only for the active repository commit and responses carry its generation. Editing suppresses lenses until a saved document has a refreshed ready generation. Cached values improve latency but do not widen evidence scope; generation or package-mapping changes invalidate them.

## Local overlays

Only the selected unsaved document is overlaid initially. The result visibly combines local overlay evidence with the published repository generation. Edits invalidate and debounce the overlay request; cancellation prevents stale results from replacing a newer query. Cross-file local completeness is never implied.
