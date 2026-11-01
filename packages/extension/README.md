# Trace for VS Code

Select a PHP class or method, then run **Trace: Explore Selected Symbol**. The extension sends revision-qualified editor context to the loopback Trace companion and renders its evidence-backed result.

After closing the Trace tab, run **Trace: Open Trace** or click the primary Trace status item to restore the last graph, selected mode and comparison. If there is no previous graph, the command traces the symbol at the active PHP cursor.

While the Trace tab remains visible, it follows the active PHP editor and cursor selection automatically. Rapid cursor movement is debounced, in-flight requests are cancelled, and the current exploration mode is preserved. Set `trace.followActiveEditor` to `false` to disable this behaviour or tune `trace.followDelayMs` when working with a slower companion.

Workspace indexing is automatic and independent of cursor following. Trace discovers local Git roots from workspace folders and a bounded set of Composer manifests, then feeds a deduplicated repository queue to the companion with at most two active repository generations at once. PHP and Composer saves schedule an incremental refresh after `trace.scanChangeDelayMs`; workspace changes are coalesced using `trace.scanDiscoveryDelayMs`. The status bar reports queue and indexing progress without posting repeated progress messages into the graph. Set `trace.autoScanWorkspace` to `false` to disable automatic discovery, or tune `trace.scanMaxComposerManifests` for unusually large workspaces.

Saved PHP documents show separate CodeLens links for non-zero caller and exact package-consumer counts. Trace batches up to `trace.codeLens.maxSymbolsPerDocument` symbols after `trace.codeLens.delayMs`, caches results by repository revision and index generation, and cancels superseded requests. The default delay is zero because VS Code already coalesces CodeLens requests; a configurable delay remains available for unusually noisy hosts. If the active PHP language extension has not produced document symbols yet, Trace uses the same bundled static PHP parser to derive declaration ranges locally. Editing removes lenses immediately; they remain hidden after save until the refreshed repository generation is ready, so stale counts are never presented. Zero counts are intentionally suppressed to keep the editor quiet. Set `trace.codeLens.enabled` to `false` to disable this feature.

Trace inherits VS Code's active light, dark or high-contrast theme. Changing the colour theme repaints the webview and relationship graph without reopening Trace or losing the current graph viewport.

1. Start the companion (`npm run dev:companion` from the monorepo root).
2. Run **Trace: Set Companion Client Token** and enter the token printed by the companion.
3. Press `F5` from this extension folder, or install the generated VSIX.
4. Open a PHP file and use its editor context menu.

The webview never receives the companion token. Unsaved content is sent only as an ephemeral single-file overlay and is not persisted as history.
