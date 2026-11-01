import type { TraceMode } from "@trace/contracts";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import * as vscode from "vscode";
import { ActiveContextPublisher, editorContextRequest, editorThemeKind } from "./activeContextSupport";
import { CompanionClient, CompanionError } from "./client";
import { EditorContextResolver } from "./editorContext";
import { discoverWorkspaceRepositories, repositoryRootForPath } from "./repositoryDiscovery";
import { ScanCoordinator, type ScanSummary } from "./scanner";

const CLIENT_ID_KEY = "trace.editorContextClientId";
let clearPublishedContext: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const client = new CompanionClient(context.secrets);
  const clientId = context.globalState.get<string>(CLIENT_ID_KEY) ?? randomUUID();
  void context.globalState.update(CLIENT_ID_KEY, clientId);
  const resolver = new EditorContextResolver(client);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.name = "Trace";
  status.command = "trace.openCompanion";
  status.text = "$(debug-disconnect) Trace";
  status.tooltip = "Trace companion connection is not checked yet";
  status.show();
  const scanStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  scanStatus.name = "Trace workspace index";
  scanStatus.command = "trace.openCompanion";
  let connected = false;
  let publisher: ActiveContextPublisher<ReturnType<typeof editorContextRequest>>;
  const setConnected = (next: boolean): void => {
    connected = next;
    publisher.setConnected(next);
  };
  clearPublishedContext = async () => {
    if (!connected) return;
    await client.updateEditorContext(editorContextRequest(clientId, undefined), AbortSignal.timeout(1_000)).then(() => undefined);
  };
  publisher = new ActiveContextPublisher(
    (request, signal) => client.updateEditorContext(request, signal).then(() => undefined),
    (error) => {
      if (error instanceof CompanionError && ["OFFLINE", "UNAUTHORIZED", "TOKEN_REQUIRED"].includes(error.code)) {
        setConnected(false);
        status.text = error.code === "TOKEN_REQUIRED" || error.code === "UNAUTHORIZED" ? "$(key) Trace" : "$(debug-disconnect) Trace";
        status.tooltip = error.message;
      }
    },
  );
  const followEnabled = (): boolean => vscode.workspace.getConfiguration("trace").get<boolean>("followActiveEditor", true);
  publisher.setEnabled(followEnabled());
  const scheduleEditorContext = (editor: vscode.TextEditor | undefined, mode: TraceMode = "impact", delay?: number): void => {
    const delayMs = delay ?? vscode.workspace.getConfiguration("trace").get<number>("followDelayMs", 300);
    publisher.update(delayMs, async (signal) => editorContextRequest(
      clientId,
      await resolver.resolve(editor, signal),
      mode,
      editorThemeKind(vscode.window.activeColorTheme.kind),
    ));
  };
  const refreshConnection = async (): Promise<void> => {
    try {
      const [companionStatus, hasToken] = await Promise.all([client.status(), client.hasToken()]);
      if (hasToken) await client.repositories();
      const wasConnected = connected;
      setConnected(hasToken);
      status.text = !hasToken ? "$(key) Trace" : companionStatus.state === "ready" ? "$(pass-filled) Trace" : "$(sync~spin) Trace";
      status.tooltip = !hasToken ? "Trace companion is reachable; set the client token to publish editor context" : `Trace companion ${companionStatus.state}${companionStatus.fixtureMode ? " · fixture mode" : ""}`;
      if (hasToken && !wasConnected) scheduleEditorContext(vscode.window.activeTextEditor);
    } catch (error) {
      setConnected(false);
      status.text = "$(debug-disconnect) Trace";
      status.tooltip = error instanceof Error ? error.message : "Trace companion is offline";
    }
  };
  const openCompanion = async (mode: TraceMode = "impact"): Promise<void> => {
    try {
      if (!connected) await refreshConnection();
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== "php" || editor.document.uri.scheme !== "file" || !vscode.workspace.getWorkspaceFolder(editor.document.uri)) {
        await vscode.window.showInformationMessage("Open a PHP file inside the current workspace before tracing.");
        return;
      }
      await publisher.publishNow(async (signal) => {
        const position = await resolver.resolve(editor, signal);
        if (!position) throw new Error("Trace could not match the active PHP file to a published repository index. Wait for indexing to finish, then try again.");
        return editorContextRequest(clientId, position, mode, editorThemeKind(vscode.window.activeColorTheme.kind));
      });
      const launchUrl = await client.browserLaunch();
      setConnected(true);
      await vscode.env.openExternal(launchUrl);
    } catch (error) {
      await showError(error, client);
    }
  };
  const renderScanSummary = (summary: ScanSummary): void => {
    const percent = summary.totalFiles ? Math.min(100, Math.floor((summary.completedFiles / summary.totalFiles) * 100)) : undefined;
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown("**Trace workspace index**\n\n");
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
    if (summary.phase === "ready") {
      resolver.clear();
      scheduleEditorContext(vscode.window.activeTextEditor);
    }
  };
  const scanner = new ScanCoordinator({
    discover: (signal) => discoverWorkspaceRepositories(vscode.workspace.getConfiguration("trace").get<number>("scanMaxComposerManifests", 250), signal),
    snapshot: (signal) => client.scanSnapshot(signal),
    enqueue: (root, signal) => client.refresh(root, signal),
    jobs: (signal) => client.jobs(signal),
    errorCode: (error) => error instanceof CompanionError ? error.code : undefined,
    onSummary: renderScanSummary,
  });
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
  const register = (command: string, callback: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  };
  register("trace.openTrace", () => openCompanion("impact"));
  register("trace.openCompanion", () => openCompanion("impact"));
  register("trace.exploreSelectedSymbol", () => openCompanion("impact"));
  register("trace.showParentImplementation", () => openCompanion("origin"));
  register("trace.showOverrides", () => openCompanion("inheritance"));
  register("trace.findCallers", () => openCompanion("callers"));
  register("trace.findConsumerProjects", () => openCompanion("consumers"));
  register("trace.showSymbolHistory", () => openCompanion("history"));
  register("trace.exploreCodeLens", () => openCompanion("impact"));
  register("trace.setClientToken", async () => {
    if (!await client.setToken()) return;
    scanner.resume();
    await refreshConnection();
    scheduleWorkspaceDiscovery(0);
    await vscode.window.showInformationMessage("Trace companion token saved in VS Code Secret Storage. Workspace scanning and editor context resumed.");
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
  const connectionTimer = setInterval(() => void refreshConnection(), 15_000);
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(({ textEditor }) => {
      if (vscode.window.activeTextEditor === textEditor) scheduleEditorContext(textEditor);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => scheduleEditorContext(editor)),
    vscode.window.onDidChangeActiveColorTheme(() => scheduleEditorContext(vscode.window.activeTextEditor)),
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      if (vscode.window.activeTextEditor?.document === document) scheduleEditorContext(vscode.window.activeTextEditor);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      resolver.clear();
      if (vscode.window.activeTextEditor?.document === document) scheduleEditorContext(vscode.window.activeTextEditor);
      void scheduleDocumentScan(document);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      resolver.clear();
      scheduleWorkspaceDiscovery(250);
      scheduleEditorContext(vscode.window.activeTextEditor);
    }),
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
      if (event.affectsConfiguration("trace.followActiveEditor")) {
        const enabled = followEnabled();
        if (!enabled && connected) void client.updateEditorContext(editorContextRequest(clientId, undefined)).catch(() => undefined);
        publisher.setEnabled(enabled);
        if (enabled) scheduleEditorContext(vscode.window.activeTextEditor);
      }
    }),
    { dispose: () => clearInterval(connectionTimer) },
    publisher,
    scanner,
    status,
    scanStatus,
  );
  void refreshConnection();
  scheduleWorkspaceDiscovery();
}

export async function deactivate(): Promise<void> {
  const clear = clearPublishedContext;
  clearPublishedContext = undefined;
  await clear?.().catch(() => undefined);
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
