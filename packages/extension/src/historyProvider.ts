import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { HistoryEvent } from "@trace/contracts";

export class HistoricalDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = "trace-history";
  private readonly documents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.toString()) ?? "Historical source is unavailable for this event.";
  }

  async open(event: HistoryEvent, side: "before" | "after" | "diff"): Promise<void> {
    const before = this.create(event, "before", event.beforeSource ?? "Historical source is unavailable.");
    const after = this.create(event, "after", event.afterSource ?? "Historical source is unavailable.");
    if (side === "diff") {
      await vscode.commands.executeCommand("vscode.diff", before, after, `${event.commit.slice(0, 8)} — ${event.summary}`);
      return;
    }
    const document = await vscode.workspace.openTextDocument(side === "before" ? before : after);
    await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
  }

  async openSource(repositoryId: string, path: string, commit: string | null, source: string, range?: { startLine: number; startColumn: number; endLine: number; endColumn: number }): Promise<void> {
    const uri = vscode.Uri.from({ scheme: HistoricalDocumentProvider.scheme, path: `/${encodeURIComponent(repositoryId)}/${encodeURIComponent(commit ?? "working-tree")}/${path}` });
    this.documents.set(uri.toString(), source);
    this.emitter.fire(uri);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: true });
    if (range) {
      const selection = new vscode.Selection(range.startLine - 1, range.startColumn, range.endLine - 1, range.endColumn);
      editor.selection = selection;
      editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  private create(event: HistoryEvent, side: string, content: string): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: HistoricalDocumentProvider.scheme,
      path: `/${encodeURIComponent(event.symbolId)}/${event.commit.slice(0, 12)}-${side}-${randomUUID()}.php`,
      query: `category=${encodeURIComponent(event.category)}`,
    });
    this.documents.set(uri.toString(), content);
    this.emitter.fire(uri);
    return uri;
  }

  dispose(): void {
    this.documents.clear();
    this.emitter.dispose();
  }
}
