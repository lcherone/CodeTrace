import { PROTOCOL_VERSION, type EditorContextState, type GraphResponse, type RepositoryRevisionMap, type TemporalGraphComparisonResponse, type TraceMode } from "@trace/contracts";
import { pastedClientToken } from "./clientToken.js";
import type { ExplorerDetails, CompatibilityResult } from "../exploration.js";
import { sameEditorSymbol } from "./editorSelection.js";
import type { MethodImpactResult } from "../method-impact.js";

type UiMessage = { type: string; [key: string]: unknown };
type HostMessage = { type: string; [key: string]: unknown };
let contextVersion = 0;
let initialized = false;
let editorContext: EditorContextState | null = null;
let graph: GraphResponse | undefined;
let activeRequest: AbortController | undefined;
let detailRequest: AbortController | undefined;
let explorationRequest: AbortController | undefined;
let tracedContextKey: string | undefined;
let originalOccurrence: GraphResponse["nodes"][number]["occurrence"];
let tracedMode: TraceMode | undefined;
let tracedDirty: boolean | undefined;

const send = (message: HostMessage): void => { window.dispatchEvent(new MessageEvent("message", { data: message })); };
const api = async <T>(route: string, options: RequestInit = {}): Promise<T> => {
  const headers = new Headers(options.headers);
  headers.set("X-Trace-Protocol", PROTOCOL_VERSION);
  headers.set("Accept", "application/json");
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(route, { ...options, headers, credentials: "same-origin" });
  const value = await response.json() as { error?: { message?: string } };
  if (!response.ok) { const error = new Error(value.error?.message ?? `Trace request failed (${response.status})`); Object.assign(error, { status: response.status }); throw error; }
  return value as T;
};

const indexedGraph = (value: GraphResponse): GraphResponse => {
  if (!editorContext?.selection.revision.dirty) return value;
  const limitation = "Unsaved changes are not indexed; this browser graph uses the last published Git basis.";
  return { ...value, freshness: { ...value.freshness, partial: true, limitations: [...new Set([...value.freshness.limitations, limitation])] } };
};

async function trace(mode: TraceMode): Promise<void> {
  if (!editorContext) return send({ type: "loading", message: "Waiting for an active PHP editor context…" });
  activeRequest?.abort(); activeRequest = new AbortController();
  detailRequest?.abort(); explorationRequest?.abort();
  const request = activeRequest;
  const selection = { ...editorContext.selection, selectedText: editorContext.selection.symbolHint ?? "" };
  tracedMode = mode;
  tracedDirty = selection.revision.dirty;
  let overviewShown = false;
  send({ type: "progress", message: null });
  send({ type: "loading", message: `Loading ${mode} relationships…` });
  try {
    const load = (stage: "overview" | "complete") => api<GraphResponse>("/v1/trace", { method: "POST", signal: request.signal, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, mode, stage, limit: 180, selection }) });
    if (mode === "impact") {
      try {
        const overview = await load("overview");
        if (request.signal.aborted) return;
        graph = indexedGraph(overview);
        originalOccurrence = graph.nodes.find((node) => node.id === graph!.focusNodeId)?.occurrence;
        send({ type: "graph", graph });
        overviewShown = true;
        const method = graph.nodes.find((node) => node.id === graph!.focusNodeId && node.kind === "method");
        if (method) return await handle({ type: "methodImpact", itemId: method.id, methodName: method.occurrence?.logical.memberName });
        send({ type: "progress", message: "Adding wider impact relationships…" });
        // Allow the browser to paint the usable overview before starting enrichment.
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      } catch (error) {
        if (request.signal.aborted) return;
        // Imported references may need the wider resolver before a focus is available.
      }
    }
    const complete = await load("complete");
    if (request.signal.aborted) return;
    graph = indexedGraph(complete);
    originalOccurrence = graph.nodes.find((node) => node.id === graph!.focusNodeId)?.occurrence;
    send({ type: "graph", graph });
    send({ type: "progress", message: null });
  } catch (error) {
    if (request.signal.aborted) return;
    send({ type: "progress", message: null });
    send({ type: "error", message: overviewShown ? `Overview remains available. Wider relationships could not be loaded: ${error instanceof Error ? error.message : String(error)}` : error instanceof Error ? error.message : String(error), trace: !overviewShown });
  }
}

async function handle(message: UiMessage): Promise<void> {
  try {
    if (message.type === "ready") return void startPolling();
    if (message.type === "changeMode") return void trace(message.mode as TraceMode);
    if (message.type === "restoreGraph") {
      activeRequest?.abort(); detailRequest?.abort(); explorationRequest?.abort();
      graph = message.graph as GraphResponse;
      send({ type: "progress", message: null });
      return;
    }
    if (message.type === "inspect" && graph) {
      detailRequest?.abort();
      const request = new AbortController(); detailRequest = request;
      const details = await api<ExplorerDetails>("/v1/graph/details", { method: "POST", signal: request.signal, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, queryId: graph.queryId, itemId: message.itemId }) });
      if (!request.signal.aborted) send({ type: "details", details });
      return;
    }
    if (message.type === "navigate" && graph) {
      activeRequest?.abort(); detailRequest?.abort(); explorationRequest?.abort();
      const request = new AbortController(); explorationRequest = request;
      const queryId = graph.queryId;
      send({ type: "progress", message: "Loading selected relationships…" });
      const load = (stage: "overview" | "complete") => api<GraphResponse>("/v1/graph/explore", { method: "POST", signal: request.signal, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, queryId, nodeId: message.nodeId, stage }) });
      const initial = await load("overview");
      if (request.signal.aborted) return;
      graph = indexedGraph(initial); send({ type: "graph", graph, exploration: true });
      send({ type: "progress", message: "Adding inherited contracts and wider relationships…" });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const next = await load("complete");
      if (!request.signal.aborted) { graph = indexedGraph(next); send({ type: "graph", graph }); send({ type: "progress", message: null }); }
      return;
    }
    if (message.type === "loadHistory" && graph) {
      const queryId = graph.queryId;
      const result = await api<{ events: GraphResponse["history"] }>("/v1/history", { method: "POST", body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, symbolId: message.nodeId, queryId: graph.queryId }) });
      if (graph?.queryId !== queryId) return;
      graph.history = result.events;
      return void handle({ type: "inspect", itemId: message.nodeId });
    }
    if (message.type === "assessCompatibility" && graph) {
      const queryId = graph.queryId;
      const result = await api<CompatibilityResult>("/v1/graph/compatibility", { method: "POST", body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, queryId, itemId: message.itemId, ...(message.targetRef ? { targetRef: message.targetRef } : {}) }) });
      if (graph.queryId === queryId) send({ type: "compatibility", queryId, result });
      return;
    }
    if (message.type === "methodImpact" && graph) {
      activeRequest?.abort(); detailRequest?.abort(); explorationRequest?.abort();
      const request = new AbortController(); explorationRequest = request;
      send({ type: "progress", message: "Resolving parent contracts and exact consumer locks…" });
      const response = await fetch("/v1/method-impact", { method: "POST", credentials: "same-origin", signal: request.signal, headers: { "X-Trace-Protocol": PROTOCOL_VERSION, "Content-Type": "application/json" }, body: JSON.stringify({ ...message, protocolVersion: PROTOCOL_VERSION, queryId: graph.queryId }) });
      if (!response.ok || !response.body) throw new Error(`Method analysis failed (${response.status})`);
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      for (;;) {
        const chunk = await reader.read(); buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as { type: string; message?: string; result?: MethodImpactResult };
          if (event.type === "error") throw new Error(event.message ?? "Method analysis failed");
          if (event.result && !request.signal.aborted) { graph = event.result.graph; send({ type: "methodImpact", result: event.result }); send({ type: "progress", message: event.result.complete ? null : `${event.result.rows.length} consumer findings available · continuing analysis…` }); }
        }
        if (chunk.done) break;
      }
      return;
    }
    if (message.type === "openLocation" && typeof message.url === "string" && /^vscode:\/\/file\//.test(message.url)) { location.assign(message.url); return; }
    if (message.type === "expand" && graph) {
      graph = indexedGraph(await api<GraphResponse>("/v1/graph/expand", { method: "POST", body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, queryId: graph.queryId, nodeId: message.nodeId, direction: message.direction }) }));
      return send({ type: "graph", graph });
    }
    if (message.type === "checkInclusion" && graph) {
      const event = graph.history.find((item) => item.id === message.eventId); if (!event) throw new Error("History event is no longer present in this graph.");
      const result = await api<unknown>("/v1/inclusion", { method: "POST", body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, symbolId: event.symbolId, commit: event.commit, queryId: graph.queryId }) });
      return send({ type: "inclusion", eventId: event.id, result });
    }
    if (message.type === "compare" && editorContext) {
      const beforeRevisions = message.beforeRevisions as RepositoryRevisionMap, afterRevisions = message.afterRevisions as RepositoryRevisionMap, repositoryId = editorContext.selection.revision.repositoryId;
      const selection = editorContext.selection;
      const request = { protocolVersion: PROTOCOL_VERSION, mode: graph?.mode ?? editorContext.mode, limit: 180, before: { revisions: beforeRevisions, selection: { ...selection, selectedText: selection.symbolHint ?? "", revision: { ...selection.revision, commit: beforeRevisions[repositoryId], dirty: false } } }, after: { revisions: afterRevisions, selection: { ...selection, selectedText: selection.symbolHint ?? "", revision: { ...selection.revision, commit: afterRevisions[repositoryId], dirty: false } } } };
      send({ type: "loading", message: "Comparing explicit repository revisions…" });
      const result = await api<TemporalGraphComparisonResponse>("/v1/trace/compare", { method: "POST", body: JSON.stringify(request) }); return send({ type: "comparison", result });
    }
    if (message.type === "openGitHub" && typeof message.url === "string" && /^https:\/\/github\.com\//i.test(message.url)) return void window.open(message.url, "_blank", "noopener,noreferrer");
    if (["openSource", "openEvidence"].includes(message.type) && graph) return void handle({ type: "inspect", itemId: message.nodeId ?? message.edgeId });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    send({ type: "progress", message: null });
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

let polling = false;
async function startPolling(): Promise<void> {
  if (polling) return; polling = true;
  for (;;) {
    try {
      const response = await api<{ version: number; context: EditorContextState | null }>(`/v1/editor-context?after=${contextVersion}&waitMs=25000`);
      if (!initialized || response.version !== contextVersion) {
        initialized = true; contextVersion = response.version; editorContext = response.context;
        if (editorContext) {
          applyTheme(editorContext.theme);
          const key = JSON.stringify([editorContext.selection, editorContext.mode]);
          const preservedSymbol = tracedMode === editorContext.mode && tracedDirty === editorContext.selection.revision.dirty && sameEditorSymbol(editorContext.selection, originalOccurrence);
          if (!graph || key !== tracedContextKey && !preservedSymbol) {
            tracedContextKey = key;
            send({ type: "context", relativePath: editorContext.selection.relativePath, line: editorContext.selection.range.startLine });
            void trace(editorContext.mode);
          }
        } else if (!graph) {
          activeRequest?.abort(); send({ type: "progress", message: null });
          send({ type: "loading", message: "Waiting for an active PHP editor context…" });
        }
      }
    } catch (error) {
      if ((error as Error & { status?: number }).status === 401) { showLogin(); return; }
      send({ type: "connection", connected: false }); await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

function showLogin(): void {
  if (document.getElementById("browser-login")) return;
  const overlay = document.createElement("section"); overlay.id = "browser-login"; overlay.className = "browser-login";
  const form = document.createElement("form"); const title = document.createElement("h1"); title.textContent = "Connect to Trace"; const help = document.createElement("p"); help.textContent = "Open Trace from the VS Code status item, or exchange the local client token once. The browser does not store it."; const input = document.createElement("input"); input.type = "password"; input.autocomplete = "off"; input.placeholder = "Client token"; const button = document.createElement("button"); button.textContent = "Open Trace"; const error = document.createElement("p"); error.className = "comparison-error"; form.append(title, help, input, button, error); overlay.append(form); document.body.append(overlay);
  input.setAttribute("aria-label", "Client token");
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "none");
  error.setAttribute("role", "alert");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    try {
      const clientToken = pastedClientToken(input.value);
      input.value = "";
      button.disabled = true;
      const response = await fetch("/v1/browser-launch", { method: "POST", headers: { Authorization: `Bearer ${clientToken}`, "X-Trace-Protocol": PROTOCOL_VERSION, "Content-Type": "application/json" }, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION }) });
      const value = await response.json() as { url?: string; error?: { message?: string } };
      if (response.status === 401) throw new Error("This token was not accepted. Copy the current local Trace client token or open Trace from the VS Code status item.");
      if (!response.ok || !value.url) throw new Error(value.error?.message ?? "Could not create browser session");
      location.assign(value.url);
    } catch (cause) {
      input.value = "";
      error.textContent = cause instanceof Error ? cause.message : String(cause);
    } finally { button.disabled = false; }
  });
}

type VscodeApi = { postMessage(message: unknown): void; getState(): unknown; setState(value: unknown): void };
declare global { interface Window { acquireVsCodeApi?: () => VscodeApi } }
window.acquireVsCodeApi = () => ({
  postMessage: (message) => { void handle(message as UiMessage); },
  getState: () => { try { return JSON.parse(sessionStorage.getItem("trace-browser-view") ?? "null"); } catch { return undefined; } },
  setState: (value) => { try { sessionStorage.setItem("trace-browser-view", JSON.stringify(value)); } catch { /* best effort presentation state */ } },
});

const systemTheme = matchMedia("(prefers-color-scheme: light)");
function applyTheme(theme?: "light" | "dark" | "high-contrast"): void {
  document.body.classList.remove("vscode-light", "vscode-dark", "vscode-high-contrast");
  document.body.classList.add(theme === "high-contrast" ? "vscode-high-contrast" : theme === "light" || (!theme && systemTheme.matches) ? "vscode-light" : "vscode-dark");
}
systemTheme.addEventListener("change", () => { if (!editorContext?.theme) applyTheme(); });
applyTheme();
