import { PROTOCOL_VERSION, type CodeLensCountItem, type CodeLensCountsRequest } from "@trace/contracts";
import { execFile } from "node:child_process";
import { relative } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { CompanionClient } from "./client";
import { configuredRepositoryId, DebouncedLensRequests, LensResultCache, lensLabels, RepositoryIdentityCache } from "./codeLensSupport";
import { parsePhpCodeLensSymbols } from "./phpCodeLensSymbols";
import { repositoryRootForPath } from "./repositoryDiscovery";

const execFileAsync = promisify(execFile);
const supportedKinds = new Set([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Constructor,
]);

type LensSymbol = { id: string; name: string; range: vscode.Range; position: vscode.Position; item: CodeLensCountItem };

export class TraceCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly cache = new LensResultCache<vscode.CodeLens[]>();
  private readonly requests = new DebouncedLensRequests();
  private readonly repositoryIdentities = new RepositoryIdentityCache();
  private disposed = false;

  constructor(private readonly client: CompanionClient) {}

  async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    const configuration = vscode.workspace.getConfiguration("trace");
    const documentKey = document.uri.toString();
    if (this.disposed || !configuration.get<boolean>("codeLens.enabled", true) || !isEligibleDocument(document) || this.cache.isBlocked(documentKey)) return [];
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    try {
      const context = await repositoryContext(document, controller.signal, (root, signal) => this.repositoryId(root, signal));
      if (!context || token.isCancellationRequested || document.isDirty || this.cache.isBlocked(documentKey)) return [];
      const cached = this.cache.get(documentKey, document.version, context.repositoryId, context.commit);
      if (cached) return cached;
      const maximum = Math.min(200, Math.max(1, configuration.get<number>("codeLens.maxSymbolsPerDocument", 120)));
      const symbols = (await documentSymbols(document, context.relativePath, token)).slice(0, maximum);
      if (!symbols.length || token.isCancellationRequested || document.isDirty || this.cache.isBlocked(documentKey)) return [];
      const request: CodeLensCountsRequest = {
        protocolVersion: PROTOCOL_VERSION,
        repository: { repositoryId: context.repositoryId, commit: context.commit },
        items: symbols.map((symbol) => symbol.item),
      };
      const delay = Math.max(0, configuration.get<number>("codeLens.delayMs", 0));
      const response = await this.requests.schedule(documentKey, delay, controller.signal, (signal) => this.client.lensCounts(request, signal));
      if (token.isCancellationRequested || document.isDirty || document.version !== context.documentVersion || this.cache.isBlocked(documentKey)) return [];
      if (response.repository.repositoryId !== context.repositoryId || response.repository.commit !== context.commit) return [];
      const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
      const lenses = response.counts.flatMap((count) => {
        const symbol = byId.get(count.id);
        if (!symbol) return [];
        return lensLabels(count).map(({ mode, title }) => new vscode.CodeLens(symbol.range, {
          title,
          command: "trace.exploreCodeLens",
          arguments: [document.uri, symbol.position, mode],
        }));
      });
      const generationChanged = this.cache.set(documentKey, document.version, response, lenses);
      if (generationChanged) this.emitter.fire();
      return lenses;
    } catch (error) {
      if (controller.signal.aborted || token.isCancellationRequested || (error instanceof Error && error.name === "AbortError")) return [];
      return [];
    } finally {
      cancellation.dispose();
    }
  }

  invalidateDocument(document: vscode.TextDocument): void {
    if (document.languageId !== "php") return;
    const key = document.uri.toString();
    this.requests.cancel(key);
    this.cache.blockDocument(key);
    this.emitter.fire();
  }

  forgetDocument(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    this.requests.cancel(key);
    this.cache.forgetDocument(key);
  }

  releaseAfterGenerationChange(): void {
    this.requests.cancelAll();
    this.cache.releaseAfterGenerationChange();
    this.repositoryIdentities.clear();
    this.emitter.fire();
  }

  refresh(): void {
    this.requests.cancelAll();
    this.cache.clearValues();
    this.repositoryIdentities.clear();
    this.emitter.fire();
  }

  dispose(): void {
    this.disposed = true;
    this.requests.cancelAll();
    this.cache.clear();
    this.repositoryIdentities.clear();
    this.emitter.dispose();
  }

  private async repositoryId(root: string, signal: AbortSignal): Promise<string | undefined> {
    return this.repositoryIdentities.resolve(root, async () => configuredRepositoryId(await this.client.repositories(signal), root));
  }
}

function isEligibleDocument(document: vscode.TextDocument): boolean {
  return document.languageId === "php"
    && document.uri.scheme === "file"
    && !document.isDirty
    && Boolean(vscode.workspace.getWorkspaceFolder(document.uri));
}

async function repositoryContext(document: vscode.TextDocument, signal: AbortSignal, resolveRepositoryId: (root: string, signal: AbortSignal) => Promise<string | undefined>): Promise<{ repositoryId: string; commit: string; documentVersion: number; relativePath: string } | undefined> {
  const root = await repositoryRootForPath(document.uri.fsPath, signal);
  if (!root || signal.aborted) return undefined;
  const repositoryId = await resolveRepositoryId(root, signal);
  if (!repositoryId || signal.aborted) return undefined;
  const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    signal,
  });
  const relativePath = relative(root, document.uri.fsPath).replaceAll("\\", "/");
  if (relativePath === ".." || relativePath.startsWith("../")) return undefined;
  return { repositoryId, commit: stdout.trim(), documentVersion: document.version, relativePath };
}

async function documentSymbols(document: vscode.TextDocument, relativePath: string, token: vscode.CancellationToken): Promise<LensSymbol[]> {
  const raw = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>("vscode.executeDocumentSymbolProvider", document.uri) ?? [];
  if (token.isCancellationRequested) return [];
  const flattened: Array<{ name: string; kind: vscode.SymbolKind; range: vscode.Range; selectionRange: vscode.Range }> = [];
  const visit = (symbol: vscode.DocumentSymbol): void => {
    flattened.push({ name: symbol.name, kind: symbol.kind, range: symbol.range, selectionRange: symbol.selectionRange });
    symbol.children.forEach(visit);
  };
  for (const symbol of raw) {
    if ("selectionRange" in symbol) visit(symbol);
    else if (symbol.location.uri.toString() === document.uri.toString()) flattened.push({ name: symbol.name, kind: symbol.kind, range: symbol.location.range, selectionRange: symbol.location.range });
  }
  const supported = flattened.filter((symbol) => supportedKinds.has(symbol.kind));
  if (!supported.length) {
    return parsePhpCodeLensSymbols(document.getText(), relativePath).map((symbol, index) => {
      const range = new vscode.Range(symbol.range.startLine, symbol.range.startColumn, symbol.range.endLine, symbol.range.endColumn);
      const position = new vscode.Position(symbol.selection.line, symbol.selection.column);
      const id = `lens:${position.line}:${position.character}:${index}`;
      return {
        id,
        name: symbol.name,
        range,
        position,
        item: {
          id,
          path: relativePath,
          range: {
            startLine: symbol.range.startLine + 1,
            startColumn: symbol.range.startColumn,
            endLine: symbol.range.endLine + 1,
            endColumn: symbol.range.endColumn,
          },
          symbol: symbol.name,
        },
      };
    });
  }
  let index = 0;
  return supported.map((symbol) => {
    const id = `lens:${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character}:${index++}`;
    return {
      id,
      name: symbol.name,
      range: symbol.selectionRange,
      position: symbol.selectionRange.start,
      item: {
        id,
        path: relativePath,
        range: {
          startLine: symbol.range.start.line + 1,
          startColumn: symbol.range.start.character,
          endLine: symbol.range.end.line + 1,
          endColumn: symbol.range.end.character,
        },
        symbol: symbol.name,
      },
    };
  });
}
