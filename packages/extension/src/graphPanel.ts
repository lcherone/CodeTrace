import type { Evidence, GraphResponse, RepositoryRevisionMap, TemporalGraphComparisonResponse } from "@trace/contracts";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import * as vscode from "vscode";
import { CompanionClient } from "./client";
import { HistoricalDocumentProvider } from "./historyProvider";
import { parseWebviewMessage, type ExtensionOutboundMessage, type TraceMode } from "./messages";
import { isWithin } from "./paths";
import { isAllowedGitHubUrl } from "./externalLinks";
import { initialPanelMessages, type TransientPanelMessage } from "./panelMessages";

type ModeHandler = (mode: TraceMode) => Promise<GraphResponse>;
type ComparisonHandler = (before: RepositoryRevisionMap, after: RepositoryRevisionMap) => Promise<TemporalGraphComparisonResponse>;

export class GraphPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private graph: GraphResponse | undefined;
  private comparison: TemporalGraphComparisonResponse | undefined;
  private modeHandler: ModeHandler | undefined;
  private comparisonHandler: ComparisonHandler | undefined;
  private transientMessage: TransientPanelMessage | undefined;
  private disposables: vscode.Disposable[] = [];
  private readonly visibilityEmitter = new vscode.EventEmitter<boolean>();
  readonly onDidChangeVisibility = this.visibilityEmitter.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: CompanionClient,
    private readonly historicalDocuments: HistoricalDocumentProvider,
  ) {}

  get visible(): boolean {
    return this.panel?.visible ?? false;
  }

  get mode(): TraceMode {
    return this.graph?.mode ?? "impact";
  }

  async reopen(): Promise<boolean> {
    const messages = initialPanelMessages(this.graph, this.comparison, this.transientMessage);
    if (!messages.length) return false;
    if (!this.panel) await this.createPanel();
    this.panel?.reveal(vscode.ViewColumn.Beside, true);
    for (const message of messages) await this.post(message);
    return true;
  }

  async show(graph: GraphResponse, modeHandler: ModeHandler, comparisonHandler: ComparisonHandler, reveal = true): Promise<boolean> {
    this.graph = graph;
    this.comparison = undefined;
    this.modeHandler = modeHandler;
    this.comparisonHandler = comparisonHandler;
    this.transientMessage = undefined;
    if (!this.panel) {
      if (!reveal) return false;
      await this.createPanel();
    }
    if (reveal) this.panel?.reveal(vscode.ViewColumn.Beside, true);
    await this.post({ type: "graph", graph });
    return true;
  }

  async loading(message: string, reveal = false): Promise<void> {
    this.transientMessage = { type: "loading", message };
    if (!this.panel && reveal) await this.createPanel();
    if (reveal) this.panel?.reveal(vscode.ViewColumn.Beside, true);
    if (this.panel) await this.post(this.transientMessage);
  }

  async error(message: string, detail?: string): Promise<void> {
    this.transientMessage = { type: "error", message, ...(detail ? { detail } : {}) };
    if (this.panel) await this.post(this.transientMessage);
  }

  invalidateOverlay(relativePath: string): void {
    if (!this.graph?.nodes.some((node) => node.occurrence?.path === relativePath && node.occurrence.overlayId)) return;
    void this.post({ type: "error", message: "The local overlay changed.", detail: "Run Trace again to refresh single-file local analysis." });
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposePanelResources();
    this.visibilityEmitter.dispose();
  }

  private async createPanel(): Promise<void> {
    const panel = vscode.window.createWebviewPanel("trace.graph", "Trace", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "out")],
    });
    this.panel = panel;
    panel.iconPath = new vscode.ThemeIcon("references");
    this.disposables.push(
      panel.onDidDispose(() => {
        this.panel = undefined;
        this.disposePanelResources();
        this.visibilityEmitter.fire(false);
      }),
      panel.onDidChangeViewState(({ webviewPanel }) => this.visibilityEmitter.fire(webviewPanel.visible)),
      panel.webview.onDidReceiveMessage((raw) => void this.handleMessage(raw)),
    );
    try {
      panel.webview.html = await this.html(panel.webview);
    } catch (error) {
      panel.dispose();
      throw error;
    }
  }

  private async html(webview: vscode.Webview): Promise<string> {
    const shellPath = vscode.Uri.joinPath(this.extensionUri, "out", "shell.html").fsPath;
    const template = await readFile(shellPath, "utf8");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "out", "webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "out", "webview.css"));
    const nonce = randomNonce();
    const csp = `default-src 'none'; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;
    return template
      .replaceAll("{{CSP}}", escapeAttribute(csp))
      .replaceAll("{{STYLE_URI}}", escapeAttribute(style.toString()))
      .replaceAll("{{SCRIPT_URI}}", escapeAttribute(script.toString()))
      .replaceAll("{{PRELUDE}}", "")
      .replaceAll("{{NONCE}}", nonce);
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const message = parseWebviewMessage(raw);
    if (!message) {
      await this.error("Trace ignored an invalid webview message.");
      return;
    }
    if (message.type === "ready") {
      for (const initialMessage of initialPanelMessages(this.graph, this.comparison, this.transientMessage)) {
        await this.post(initialMessage);
      }
      return;
    }
    if (!this.graph) return;
    try {
      switch (message.type) {
        case "changeMode": {
          if (!this.modeHandler) return;
          await this.loading(`Loading ${message.mode} relationships…`);
          const graph = await this.modeHandler(message.mode);
          this.graph = graph;
          this.comparison = undefined;
          await this.post({ type: "graph", graph });
          break;
        }
        case "compare": {
          if (!this.comparisonHandler) return;
          await this.loading("Comparing explicit repository revisions…");
          this.comparison = await this.comparisonHandler(message.beforeRevisions, message.afterRevisions);
          await this.post({ type: "comparison", result: this.comparison });
          break;
        }
        case "expand": {
          if (this.comparison) throw new Error("Exit revision comparison before expanding relationships.");
          const graph = await this.client.expand(this.graph.queryId, message.nodeId, message.direction);
          this.graph = mergeGraphs(this.graph, graph);
          await this.post({ type: "graph", graph: this.graph });
          break;
        }
        case "navigate": {
          const node = this.graph.nodes.find((candidate) => candidate.id === message.nodeId)
            ?? this.comparison?.after.nodes.find((candidate) => candidate.id === message.nodeId)
            ?? this.comparison?.before.nodes.find((candidate) => candidate.id === message.nodeId);
          if (node?.occurrence) await this.openOccurrence(node.occurrence.revision.repositoryId, node.occurrence.path, node.occurrence.revision.commit, node.occurrence.range);
          break;
        }
        case "openSource": {
          const node = this.graph.nodes.find((candidate) => candidate.id === message.nodeId)
            ?? this.comparison?.after.nodes.find((candidate) => candidate.id === message.nodeId)
            ?? this.comparison?.before.nodes.find((candidate) => candidate.id === message.nodeId);
          if (!node?.occurrence) throw new Error("This node has no indexed source occurrence.");
          await this.openOccurrence(node.occurrence.revision.repositoryId, node.occurrence.path, node.occurrence.revision.commit, node.occurrence.range);
          break;
        }
        case "openEvidence": {
          const edge = this.graph.edges.find((candidate) => candidate.id === message.edgeId)
            ?? this.comparison?.after.edges.find((candidate) => candidate.id === message.edgeId)
            ?? this.comparison?.before.edges.find((candidate) => candidate.id === message.edgeId);
          const evidence = edge?.evidence[message.evidenceIndex];
          if (!evidence) throw new Error("Evidence is no longer present in this graph.");
          await this.openEvidence(evidence);
          break;
        }
        case "openHistory": {
          const event = this.graph.history.find((candidate) => candidate.id === message.eventId);
          if (!event) throw new Error("History event is no longer present in this graph.");
          await this.historicalDocuments.open(event, message.side);
          break;
        }
        case "checkInclusion": {
          const event = this.graph.history.find((candidate) => candidate.id === message.eventId);
          if (!event) throw new Error("History event is no longer present in this graph.");
          const result = await this.client.inclusion(event.symbolId, event.commit);
          await this.post({ type: "inclusion", eventId: event.id, result });
          break;
        }
        case "openGitHub": {
          if (!isAllowedGitHubUrl(message.url)) throw new Error("Trace refused to open a non-GitHub external URL.");
          await vscode.env.openExternal(vscode.Uri.parse(message.url, true));
          break;
        }
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "CANCELLED") return;
      await this.error(error instanceof Error ? error.message : String(error));
    }
  }

  private async openEvidence(evidence: Evidence): Promise<void> {
    if (!evidence.path) throw new Error("This evidence has no source path.");
    await this.openOccurrence(evidence.repositoryId, evidence.path, evidence.commit, evidence.range);
  }

  private async openOccurrence(repositoryId: string, path: string, commit: string, range?: { startLine: number; startColumn: number; endLine: number; endColumn: number }): Promise<void> {
    try {
      const root = await resolveRepositoryRoot(repositoryId);
      const candidate = await realpath(resolve(root, path));
      await assertTrustedPath(candidate);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(candidate));
      const editor = await vscode.window.showTextDocument(document, { preview: true });
      if (range) {
        const selection = new vscode.Selection(range.startLine - 1, range.startColumn, range.endLine - 1, range.endColumn);
        editor.selection = selection;
        editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    } catch {
      const source = await this.client.source(repositoryId, path, commit);
      await this.historicalDocuments.openSource(source.repositoryId, source.path, source.commit, source.source, range);
    }
  }

  private async post(message: ExtensionOutboundMessage): Promise<void> {
    await this.panel?.webview.postMessage(message);
  }

  private disposePanelResources(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}

async function resolveRepositoryRoot(repositoryId: string): Promise<string> {
  if (isAbsolute(repositoryId)) return realpath(repositoryId);
  const matching = vscode.workspace.workspaceFolders?.find((folder) => folder.name === repositoryId || folder.uri.fsPath.endsWith(`/${repositoryId}`));
  if (!matching) throw new Error(`Repository '${repositoryId}' is not an open or trusted local repository.`);
  return realpath(matching.uri.fsPath);
}

async function assertTrustedPath(candidate: string): Promise<void> {
  const configured = vscode.workspace.getConfiguration("trace").get<string[]>("trustedSourceRoots", []);
  const roots = [...(vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? []), ...configured];
  for (const root of roots) {
    if (!isAbsolute(root)) continue;
    const canonicalRoot = await realpath(root).catch(() => undefined);
    if (canonicalRoot && isWithin(canonicalRoot, candidate)) return;
  }
  throw new Error("Trace refused to open source outside the workspace or configured trusted roots.");
}

export function mergeGraphs(current: GraphResponse, expanded: GraphResponse): GraphResponse {
  const nodes = new Map(current.nodes.map((node) => [node.id, node]));
  const edges = new Map(current.edges.map((edge) => [edge.id, edge]));
  for (const node of expanded.nodes) nodes.set(node.id, node);
  for (const edge of expanded.edges) edges.set(edge.id, edge);
  const events = new Map(current.history.map((event) => [event.id, event]));
  for (const event of expanded.history) events.set(event.id, event);
  return { ...expanded, focusNodeId: current.focusNodeId, nodes: [...nodes.values()], edges: [...edges.values()], history: [...events.values()] };
}

function randomNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
