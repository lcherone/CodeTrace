import { PROTOCOL_VERSION, type EditorContextState, type GraphResponse, type RepositoryRevisionMap, type TemporalGraphComparisonResponse, type TraceMode } from "@trace/contracts";

type UiMessage = { type: string; [key: string]: unknown };
type HostMessage = { type: string; [key: string]: unknown };
let contextVersion = 0;
let initialized = false;
let editorContext: EditorContextState | null = null;
let graph: GraphResponse | undefined;
let activeRequest: AbortController | undefined;

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
  send({ type: "loading", message: `Loading ${mode} relationships…` });
  try {
    graph = indexedGraph(await api<GraphResponse>("/v1/trace", { method: "POST", signal: activeRequest.signal, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, mode, limit: 180, selection: { ...editorContext.selection, selectedText: editorContext.selection.symbolHint ?? "" } }) }));
    send({ type: "graph", graph });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    send({ type: "error", message: error instanceof Error ? error.message : String(error), trace: true });
  }
}

async function handle(message: UiMessage): Promise<void> {
  try {
    if (message.type === "ready") return void startPolling();
    if (message.type === "changeMode") return void trace(message.mode as TraceMode);
    if (message.type === "expand" && graph) {
      graph = indexedGraph(await api<GraphResponse>("/v1/graph/expand", { method: "POST", body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, queryId: graph.queryId, nodeId: message.nodeId, direction: message.direction }) }));
      return send({ type: "graph", graph });
    }
    if (message.type === "checkInclusion" && graph) {
      const event = graph.history.find((item) => item.id === message.eventId); if (!event) throw new Error("History event is no longer present in this graph.");
      const result = await api<unknown>("/v1/inclusion", { method: "POST", body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, symbolId: event.symbolId, commit: event.commit }) });
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
    if (["openSource", "openEvidence", "openHistory", "navigate"].includes(message.type)) return send({ type: "error", message: "Source text is intentionally not exposed in the browser.", detail: "Use VS Code to open the indexed path and range shown in evidence." });
  } catch (error) { send({ type: "error", message: error instanceof Error ? error.message : String(error) }); }
}

let polling = false;
async function startPolling(): Promise<void> {
  if (polling) return; polling = true;
  for (;;) {
    try {
      const response = await api<{ version: number; context: EditorContextState | null }>(`/v1/editor-context?after=${contextVersion}&waitMs=25000`);
      if (!initialized || response.version !== contextVersion) { initialized = true; contextVersion = response.version; editorContext = response.context; if (editorContext) { applyTheme(editorContext.theme); send({ type: "context", relativePath: editorContext.selection.relativePath, line: editorContext.selection.range.startLine }); await trace(editorContext.mode); } else send({ type: "loading", message: "Waiting for an active PHP editor context…" }); }
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
  form.addEventListener("submit", async (event) => { event.preventDefault(); try { const response = await fetch("/v1/browser-launch", { method: "POST", headers: { Authorization: `Bearer ${input.value.trim()}`, "X-Trace-Protocol": PROTOCOL_VERSION, "Content-Type": "application/json" }, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION }) }); const value = await response.json() as { url?: string; error?: { message?: string } }; input.value = ""; if (!response.ok || !value.url) throw new Error(value.error?.message ?? "Could not create browser session"); location.assign(value.url); } catch (cause) { input.value = ""; error.textContent = cause instanceof Error ? cause.message : String(cause); } });
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
