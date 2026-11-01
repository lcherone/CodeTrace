import type { GraphResponse } from "@trace/contracts";
import { basename, relative } from "node:path";
import * as vscode from "vscode";
import { CompanionClient, CompanionError } from "./client";
import { createSelection, OverlayInvalidator } from "./editorContext";
import { GraphPanel } from "./graphPanel";
import { HistoricalDocumentProvider } from "./historyProvider";
import { canFollowEditor, LiveFollowScheduler } from "./liveFollow";
import type { TraceMode } from "./messages";
import { discoverWorkspaceRepositories, repositoryRootForPath } from "./repositoryDiscovery";
import { ScanCoordinator, type ScanSummary } from "./scanner";
import { TraceCodeLensProvider } from "./codeLens";

let activeRequest: AbortController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const client = new CompanionClient(context.secrets);
  const history = new HistoricalDocumentProvider();
  const panel = new GraphPanel(context.extensionUri, client, history);
  const invalidator = new OverlayInvalidator();
  const liveFollow = new LiveFollowScheduler();
  const codeLenses = new TraceCodeLensProvider(client);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.name = "Trace";
  status.command = "trace.openTrace";
  status.text = "$(debug-disconnect) Trace";
  status.tooltip = "Trace companion connection is not checked yet";
  status.show();
  const scanStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  scanStatus.name = "Trace workspace index";
  scanStatus.command = "trace.openCompanion";
  let previousScanPhase: ScanSummary["phase"] = "idle";
  let restoringEditorFocus = false;
  let scheduleLiveFollow: (editor: vscode.TextEditor | undefined) => void = () => undefined;

  const renderScanSummary = (summary: ScanSummary): void => {
    const percent = summary.totalFiles ? Math.min(100, Math.floor((summary.completedFiles / summary.totalFiles) * 100)) : undefined;
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**Trace workspace index**\n\n`);
    tooltip.appendMarkdown(`${summary.discoveredRepositories} repositories discovered; ${summary.readyRepositories} ready; ${summary.runningRepositories} running; ${summary.queuedRepositories} queued.`);
    if (summary.discoveryTruncated) tooltip.appendMarkdown("\n\nComposer discovery reached its configured limit. Increase `trace.scanMaxComposerManifests` to inspect more of this workspace.");
    if (summary.failedRepositories) tooltip.appendMarkdown(`\n\n${summary.failedRepositories} indexing job${summary.failedRepositories === 1 ? "" : "s"} failed. Open the companion for details and retry controls.`);
    switch (summary.phase) {
      case "discovering": scanStatus.text = "$(search~spin) Trace discovering"; break;
      case "queued": scanStatus.text = `$(clock) Trace index queued${summary.queuedRepositories ? ` (${summary.queuedRepositories})` : ""}`; break;
      case "indexing": scanStatus.text = `$(sync~spin) Trace indexing${percent === undefined ? "" : ` ${percent}%`}`; break;
      case "ready": scanStatus.text = "$(database) Trace index ready"; break;
      case "degraded": scanStatus.text = "$(warning) Trace index issue"; break;
      case "paused": scanStatus.text = summary.blockedCode === "TOKEN_REQUIRED" || summary.blockedCode === "UNAUTHORIZED" ? "$(key) Trace scan paused" : "$(debug-disconnect) Trace scan paused"; break;
      default: scanStatus.text = "$(database) Trace index idle";
    }
    scanStatus.tooltip = tooltip;
    scanStatus.show();
    if (summary.phase === "ready" && (previousScanPhase === "indexing" || previousScanPhase === "queued") && panel.visible) {
      scheduleLiveFollow(vscode.window.activeTextEditor);
    }
    if (summary.phase === "ready" && (previousScanPhase === "indexing" || previousScanPhase === "queued")) codeLenses.releaseAfterGenerationChange();
    previousScanPhase = summary.phase;
  };

  const scanner = new ScanCoordinator({
    discover: (signal) => discoverWorkspaceRepositories(vscode.workspace.getConfiguration("trace").get<number>("scanMaxComposerManifests", 250), signal),
    snapshot: (signal) => client.scanSnapshot(signal),
    enqueue: (root, signal) => client.refresh(root, signal),
    jobs: (signal) => client.jobs(signal),
    errorCode: (error) => error instanceof CompanionError ? error.code : undefined,
    onSummary: renderScanSummary,
  });

  const explore = async (mode: TraceMode, options: { editor?: vscode.TextEditor; automatic?: boolean } = {}): Promise<void> => {
    const editor = options.editor ?? vscode.window.activeTextEditor;
    if (!editor) {
      if (!options.automatic) await vscode.window.showInformationMessage("Open a PHP file to trace a symbol.");
      return;
    }
    activeRequest?.abort();
    const controller = new AbortController();
    activeRequest = controller;
    try {
      const selection = await createSelection(editor);
      status.text = "$(sync~spin) Trace";
      status.tooltip = `Tracing ${selection.relativePath}`;
      await panel.loading(`Tracing ${selection.selectedText || "the symbol at the cursor"}…`, !options.automatic);
      const run = async (nextMode: TraceMode): Promise<GraphResponse> => client.trace(selection, nextMode, controller.signal);
      const graph = await run(mode);
      if (controller.signal.aborted) return;
      const presented = await panel.show(graph, async (nextMode) => {
        activeRequest?.abort();
        const next = new AbortController();
        activeRequest = next;
        return client.trace(selection, nextMode, next.signal);
      }, async (before, after) => {
        activeRequest?.abort();
        const next = new AbortController();
        activeRequest = next;
        return client.compare(selection, panel.mode, before, after, next.signal);
      }, !options.automatic);
      if (!presented) return;
      if (!options.automatic && editor.viewColumn) {
        restoringEditorFocus = true;
        try {
          await vscode.window.showTextDocument(editor.document, editor.viewColumn, false);
        } finally {
          restoringEditorFocus = false;
        }
      }
      status.text = graph.freshness.partial ? "$(warning) Trace" : "$(pass-filled) Trace";
      status.tooltip = `${graph.nodes.length} nodes · generation ${graph.freshness.generation}${graph.freshness.partial ? " · partial" : ""}`;
    } catch (error) {
      if (controller.signal.aborted) return;
      status.text = "$(error) Trace";
      status.tooltip = error instanceof Error ? error.message : String(error);
      if (options.automatic) {
        await panel.error("Live follow could not update Trace.", error instanceof Error ? error.message : String(error));
      } else {
        await panel.error("Trace could not load the graph.", error instanceof Error ? error.message : String(error));
        await showError(error, client);
      }
    } finally {
      if (activeRequest === controller) activeRequest = undefined;
    }
  };

  scheduleLiveFollow = (editor: vscode.TextEditor | undefined): void => {
    if (restoringEditorFocus) return;
    const configuration = vscode.workspace.getConfiguration("trace");
    const enabled = configuration.get<boolean>("followActiveEditor", true);
    const inWorkspace = Boolean(editor && vscode.workspace.getWorkspaceFolder(editor.document.uri));
    if (!editor || !canFollowEditor({
      enabled,
      panelVisible: panel.visible,
      languageId: editor.document.languageId,
      scheme: editor.document.uri.scheme,
      inWorkspace,
    })) {
      liveFollow.cancel();
      return;
    }

    activeRequest?.abort();
    const targetUri = editor.document.uri.toString();
    const delayMs = configuration.get<number>("followDelayMs", 300);
    liveFollow.schedule(delayMs, () => {
      const current = vscode.window.activeTextEditor;
      if (!current || current.document.uri.toString() !== targetUri || !panel.visible) return;
      void explore(panel.mode, { editor: current, automatic: true });
    });
  };

  const scheduleWorkspaceDiscovery = (delay?: number): void => {
    const configuration = vscode.workspace.getConfiguration("trace");
    if (!configuration.get<boolean>("autoScanWorkspace", true)) {
      scanner.cancelScheduled();
      scanStatus.hide();
      return;
    }
    scanner.scheduleDiscovery(delay ?? configuration.get<number>("scanDiscoveryDelayMs", 800));
  };

  const scheduleDocumentScan = async (document: vscode.TextDocument): Promise<void> => {
    if (document.uri.scheme !== "file" || !vscode.workspace.getWorkspaceFolder(document.uri)) return;
    const name = basename(document.uri.fsPath).toLocaleLowerCase();
    if (document.languageId !== "php" && name !== "composer.json" && name !== "composer.lock") return;
    const root = await repositoryRootForPath(document.uri.fsPath);
    if (!root) return;
    const delay = vscode.workspace.getConfiguration("trace").get<number>("scanChangeDelayMs", 1_500);
    scanner.scheduleRepository(root, delay, true);
    if (name === "composer.json" || name === "composer.lock") scheduleWorkspaceDiscovery(delay);
  };

  const register = (command: string, callback: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  register("trace.openTrace", async () => {
    if (await panel.reopen()) return;
    await explore("impact");
  });
  register("trace.exploreSelectedSymbol", () => explore("impact"));
  register("trace.showParentImplementation", () => explore("origin"));
  register("trace.showOverrides", () => explore("inheritance"));
  register("trace.findCallers", () => explore("callers"));
  register("trace.findConsumerProjects", () => explore("consumers"));
  register("trace.exploreCodeLens", async (uri, position, mode) => {
    if (!(uri instanceof vscode.Uri) || !(position instanceof vscode.Position) || (mode !== "callers" && mode !== "consumers")) return;
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.languageId !== "php" || document.isDirty) return vscode.window.showInformationMessage("Save this PHP document before using Trace CodeLens counts.");
    restoringEditorFocus = true;
    let editor: vscode.TextEditor;
    try {
      editor = await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } finally {
      restoringEditorFocus = false;
    }
    await explore(mode, { editor });
  });
  register("trace.showSymbolHistory", () => explore("history"));
  register("trace.setClientToken", async () => {
    if (await client.setToken()) {
      scanner.resume();
      scheduleWorkspaceDiscovery(0);
      await vscode.window.showInformationMessage("Trace companion token saved in VS Code Secret Storage. Workspace scanning resumed.");
    }
  });
  register("trace.openCompanion", async () => {
    try {
      await vscode.env.openExternal(client.dashboardUrl());
    } catch (error) {
      await showError(error, client);
    }
  });
  register("trace.refreshCurrentRepository", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return vscode.window.showInformationMessage("Open a file in the repository to refresh.");
    if (!vscode.workspace.getWorkspaceFolder(editor.document.uri)) return vscode.window.showWarningMessage("The active file is not in a workspace folder.");
    const root = await repositoryRootForPath(editor.document.uri.fsPath);
    if (!root) return vscode.window.showWarningMessage("The active file is not inside a Git repository.");
    scanner.requestRepository(root, true);
    await vscode.window.showInformationMessage("Trace repository refresh added to the indexing queue.");
  });

  invalidator.onDidInvalidate((document) => {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (folder) panel.invalidateOverlay(relative(folder.uri.fsPath, document.uri.fsPath).replaceAll("\\", "/"));
    activeRequest?.abort();
    if (vscode.window.activeTextEditor?.document === document) scheduleLiveFollow(vscode.window.activeTextEditor);
  });
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: "php", scheme: "file" }, codeLenses),
    vscode.workspace.onDidChangeTextDocument(({ document }) => codeLenses.invalidateDocument(document)),
    vscode.workspace.onDidCloseTextDocument((document) => codeLenses.forgetDocument(document)),
    vscode.window.onDidChangeTextEditorSelection(({ textEditor }) => scheduleLiveFollow(textEditor)),
    vscode.window.onDidChangeActiveTextEditor((editor) => scheduleLiveFollow(editor)),
    vscode.workspace.onDidSaveTextDocument((document) => {
      codeLenses.invalidateDocument(document);
      void scheduleDocumentScan(document);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleWorkspaceDiscovery(250)),
    vscode.workspace.onDidCreateFiles(({ files }) => {
      if (files.some((uri) => basename(uri.fsPath).toLocaleLowerCase() === "composer.json")) scheduleWorkspaceDiscovery(250);
    }),
    vscode.workspace.onDidDeleteFiles(({ files }) => {
      if (files.some((uri) => basename(uri.fsPath).toLocaleLowerCase() === "composer.json")) scheduleWorkspaceDiscovery(250);
    }),
    vscode.workspace.onDidRenameFiles(({ files }) => {
      if (files.some(({ oldUri, newUri }) => [oldUri, newUri].some((uri) => basename(uri.fsPath).toLocaleLowerCase() === "composer.json"))) scheduleWorkspaceDiscovery(250);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("trace.autoScanWorkspace") || event.affectsConfiguration("trace.scanMaxComposerManifests")) scheduleWorkspaceDiscovery(0);
      if (event.affectsConfiguration("trace.codeLens")) codeLenses.refresh();
    }),
    panel.onDidChangeVisibility((visible) => {
      if (visible) scheduleLiveFollow(vscode.window.activeTextEditor);
      else {
        liveFollow.cancel();
        activeRequest?.abort();
      }
    }),
    vscode.workspace.registerTextDocumentContentProvider(HistoricalDocumentProvider.scheme, history),
    invalidator,
    history,
    panel,
    liveFollow,
    scanner,
    codeLenses,
    status,
    scanStatus,
  );

  void client.status().then((result) => {
    status.text = result.state === "ready" ? "$(pass-filled) Trace" : "$(sync~spin) Trace";
    status.tooltip = `Trace companion ${result.state}${result.fixtureMode ? " · fixture mode" : ""}`;
  }).catch(() => {
    status.text = "$(debug-disconnect) Trace";
    status.tooltip = "Trace companion is offline";
  });
  scheduleWorkspaceDiscovery();
}

export function deactivate(): void {
  activeRequest?.abort();
}

async function showError(error: unknown, client: CompanionClient): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof CompanionError && error.code === "TOKEN_REQUIRED") {
    const choice = await vscode.window.showErrorMessage(message, "Set token");
    if (choice === "Set token") await client.setToken();
    return;
  }
  await vscode.window.showErrorMessage(`Trace: ${message}`);
}
