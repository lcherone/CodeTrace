# Trace visual feature guide

These captures come from the current built Trace webview and companion using deterministic fixture repositories. They contain no customer source, credentials, client tokens, personal data, or private remote URLs.

The primary webview captures use a 1380 × 749 CSS-pixel viewport. The compact capture uses 800 × 800. Screenshots show synthetic repository identities and intentionally fictional GitHub association data.

## Feature coverage

| Surface | Capture |
| --- | --- |
| Relationship graph, tree, evidence, history, confidence, search and modes | [Overview](#relationship-overview) |
| VS Code light/dark theme integration | [Overview](#relationship-overview) |
| Responsive compact layout | [Compact layout](#compact-layout) |
| Native, ambiguous, container and dynamic receiver evidence | [Receiver inference](#receiver-inference) |
| Composer constraint, alias, source, path and indexed identity | [Composer resolution](#composer-resolution) |
| Exact before/after graph bases and relationship diff | [Historical comparison](#historical-comparison) |
| Consumer/release active behaviour and optional GitHub associations | [Release and pull-request association](#release-and-pull-request-association) |
| Repositories, generations, jobs, mappings and optional GitHub setup | [Companion dashboard](#companion-dashboard) |

## Relationship overview

The overview brings the accessible relationship tree, directed graph, evidence inspector, history timeline, confidence filter, and freshness/partial status into one editor surface.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/trace-overview-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/readme/trace-overview-light.png">
  <img src="assets/readme/trace-overview-light.png" alt="Trace relationship overview in a VS Code-compatible light theme" width="100%">
</picture>

## Compact layout

Below 960 px, the relationship and detail rails collapse behind labelled controls while the graph and history remain available.

![Trace compact layout with collapsed Relationships and Details panels](assets/readme/trace-compact-layout.png)

## Receiver inference

The inspector distinguishes precise native/local candidates from branch ambiguity and runtime-only behaviour. It states why no precise target was claimed instead of manufacturing a graph edge.

![Trace receiver analysis with resolved, ambiguous and runtime-limited receiver cards](assets/readme/trace-receiver-inference.png)

## Composer resolution

The package inspector keeps a dependency's declared constraint, base branch, inline alias, locked source/dist identity, installed path, indexed repository and selected resolution evidence separate.

![Trace Composer resolution inspector showing path evidence and exact package metadata](assets/readme/trace-composer-resolution.png)

## Historical comparison

Each side is reconstructed from an explicit repository-to-commit map. The view preserves the bases and filters added, removed, changed, and unchanged relationships.

![Trace historical graph comparison with changed repository bases and relationship](assets/readme/trace-historical-comparison.png)

## Release and pull-request association

Local inclusion and revert-aware active behaviour remain primary. Optional GitHub pull-request and release associations are separate, bounded metadata with their own confidence and limitations.

![Trace history assessment showing consumers, releases and optional GitHub association limitations](assets/readme/trace-release-associations.png)

## Companion dashboard

The authenticated loopback dashboard exposes repository generations, bounded scanner jobs, Composer dependency coverage, explicit mappings, optional GitHub access, and the read-only security boundary.

![Trace companion dashboard populated with three deterministic fixture repositories](assets/readme/trace-companion-dashboard.png)

## Capture boundary

The native CodeLens and automatic cursor-follow behaviours were verified through the extension tests and installed extension workflow, but no full-editor screenshot is committed here. The available full VS Code windows contained private workspace context, and fabricating a replacement would misrepresent the running application. Safe fixture procedures for CodeLens and cursor following are documented in the [manual verification guide](manual-verification.md#12-codelens-counts-and-query-benchmark) and [Extension Development Host tour](manual-verification.md#3-extension-development-host).
