import cytoscape, { type Core, type EdgeSingular, type EventObject, type NodeSingular } from "cytoscape";
import { ExtensionOutboundMessageSchema, type ExtensionOutboundMessage } from "../messages";
import type { ChangeInclusionResponse, Evidence, GraphEdge, GraphNode, GraphResponse, HistoryEvent, RepositoryRevisionMap, TemporalGraphComparisonResponse } from "@trace/contracts";
import { layeredGraphPositions } from "./layout";
import { comparisonStates, comparisonView, defaultComparisonState, type ComparisonState, type ComparisonView } from "../comparison";
import { presentAssessment, type InclusionAssessmentLike } from "../inclusionPresentation";
import { composerMetadataKeys, composerResolutionFromMetadata, type ComposerResolutionPresentation } from "../composerPresentation";
import { isAllowedGitHubUrl } from "../externalLinks";
import { receiverAnalysisFromMetadata, receiverPrecisionMessage, type ReceiverAnalysisPresentation } from "../receiverPresentation";

type VscodeApi = { postMessage(message: unknown): void; getState(): unknown; setState(value: unknown): void };
declare global { interface Window { acquireVsCodeApi?: () => VscodeApi; __TRACE_FIXTURE__?: ExtensionOutboundMessage; __TRACE_INITIAL_SELECTION__?: string } }

const vscode: VscodeApi = window.acquireVsCodeApi?.() ?? {
  postMessage: (message) => window.dispatchEvent(new CustomEvent("trace-preview-message", { detail: message })),
  getState: () => undefined,
  setState: () => undefined,
};
const scriptNonce = document.currentScript?.nonce;
if (scriptNonce) {
  const createElement = document.createElement.bind(document);
  document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
    const element = createElement(tagName, options);
    if (tagName.toLocaleLowerCase() === "style") element.setAttribute("nonce", scriptNonce);
    return element;
  }) as typeof document.createElement;
}
cytoscape.warnings(false);
let cy: Core | undefined;
let graph: GraphResponse | undefined;
let normalGraph: GraphResponse | undefined;
let temporalComparison: TemporalGraphComparisonResponse | undefined;
let comparisonState: ComparisonState | undefined;
let currentComparisonView: ComparisonView | undefined;
const restoredState = vscode.getState();
const restored = isRecord(restoredState) ? restoredState : {};
let selectedId = typeof restored.selectedId === "string" ? restored.selectedId : undefined;
let search = "";
let confidence = "all";
const navigation: string[] = Array.isArray(restored.navigation) ? restored.navigation.filter((item): item is string => typeof item === "string").slice(-8) : [];
let themeRefreshFrame: number | undefined;
let graphResizeFrame: number | undefined;
let iconFontRefreshed = false;
let renderedLayoutKey: string | undefined;

void document.fonts.ready.then(() => {
  if (!graph || iconFontRefreshed) return;
  iconFontRefreshed = true;
  const viewport = cy ? { zoom: cy.zoom(), pan: cy.pan() } : undefined;
  renderGraph(viewport);
});

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing webview element: ${id}`);
  return element as T;
};

const themeObserver = new MutationObserver(() => {
  if (!graph) return;
  if (themeRefreshFrame !== undefined) cancelAnimationFrame(themeRefreshFrame);
  themeRefreshFrame = requestAnimationFrame(() => {
    themeRefreshFrame = undefined;
    const viewport = cy ? { zoom: cy.zoom(), pan: cy.pan() } : undefined;
    renderGraph(viewport);
  });
});
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });

const graphResizeObserver = new ResizeObserver(() => {
  if (!cy) return;
  if (graphResizeFrame !== undefined) cancelAnimationFrame(graphResizeFrame);
  graphResizeFrame = requestAnimationFrame(() => {
    graphResizeFrame = undefined;
    cy?.resize();
    cy?.fit(undefined, 28);
    renderMinimap();
  });
});
graphResizeObserver.observe($("graph"));

document.querySelectorAll<HTMLButtonElement>(".mode").forEach((button) => button.addEventListener("click", () => {
  if (button.dataset.mode) vscode.postMessage({ type: "changeMode", mode: button.dataset.mode });
}));
$("search").addEventListener("input", (event) => { search = (event.target as HTMLInputElement).value.toLocaleLowerCase(); applyFilters(); });
$("confidence").addEventListener("change", (event) => { confidence = (event.target as HTMLSelectElement).value; applyFilters(); });
$("zoom-in").addEventListener("click", () => cy?.zoom({ level: Math.min(3, cy.zoom() * 1.18), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }));
$("zoom-out").addEventListener("click", () => cy?.zoom({ level: Math.max(0.2, cy.zoom() / 1.18), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }));
$("fit").addEventListener("click", () => cy?.fit(undefined, 28));
$("focus-search").addEventListener("click", () => $("search").focus());
$("open-comparison").addEventListener("click", openComparisonEditor);
$("open-comparison-mobile").addEventListener("click", openComparisonEditor);
$("cancel-comparison").addEventListener("click", closeComparisonEditor);
$("close-comparison").addEventListener("click", exitComparison);
$<HTMLFormElement>("comparison-form").addEventListener("submit", submitComparison);
$<HTMLCanvasElement>("graph-minimap").addEventListener("click", () => cy?.fit(undefined, 28));
$("toggle-relationships").addEventListener("click", () => togglePanel("rail-open", "toggle-relationships"));
$("toggle-details").addEventListener("click", () => togglePanel("inspector-open", "toggle-details"));
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("comparison-editor").hidden) {
    closeComparisonEditor();
    return;
  }
  document.body.classList.remove("rail-open", "inspector-open");
  $("toggle-relationships").setAttribute("aria-expanded", "false");
  $("toggle-details").setAttribute("aria-expanded", "false");
});

window.addEventListener("message", ({ data }) => handleMessage(data));
vscode.postMessage({ type: "ready" });
if (window.__TRACE_FIXTURE__) handleMessage(window.__TRACE_FIXTURE__);

function handleMessage(raw: unknown): void {
  const parsed = ExtensionOutboundMessageSchema.safeParse(raw);
  if (!parsed.success) return;
  const message = parsed.data;
  if (message.type === "graph") {
    normalGraph = message.graph;
    render(message.graph);
  }
  if (message.type === "loading") showCanvasState(message.message, "loading");
  if (message.type === "error") showToast(message.detail ? `${message.message} ${message.detail}` : message.message, true);
  if (message.type === "inclusion") renderInclusion(message.eventId, message.result);
  if (message.type === "comparison") renderComparison(message.result);
}

function render(next: GraphResponse, preserveComparison = false): void {
  const previousViewport = cy ? { zoom: cy.zoom(), pan: cy.pan() } : undefined;
  graph = next;
  if (!preserveComparison) clearComparison();
  document.querySelectorAll<HTMLButtonElement>(".mode").forEach((button) => button.classList.toggle("active", button.dataset.mode === graph?.mode));
  $("canvas-state").hidden = true;
  renderGraph(previousViewport);
  renderTree();
  renderTimeline();
  renderStatus();
  renderLegend();
  const focus = next.nodes.find((node) => node.id === next.focusNodeId);
  if (focus && !(($("search") as HTMLInputElement).value)) ($("search") as HTMLInputElement).placeholder = focus.label;
  const preservedSelection = selectedId && (next.nodes.some((node) => node.id === selectedId) || next.edges.some((edge) => edge.id === selectedId)) ? selectedId : undefined;
  selectElement(preservedSelection ?? (window.__TRACE_INITIAL_SELECTION__ && next.edges.some((edge) => edge.id === window.__TRACE_INITIAL_SELECTION__) ? window.__TRACE_INITIAL_SELECTION__ : next.focusNodeId), false);
  renderBreadcrumbs();
}

function openComparisonEditor(): void {
  if (!normalGraph) {
    showToast("Run a trace before comparing revisions.", true);
    return;
  }
  const current = new Map(normalGraph.freshness.repositories.map((revision) => [revision.repositoryId, revision.commit]));
  const before = new Map(temporalComparison?.basis.before.map((revision) => [revision.repositoryId, revision.requestedCommit]) ?? []);
  const after = new Map(temporalComparison?.basis.after.map((revision) => [revision.repositoryId, revision.requestedCommit]) ?? []);
  const repositories = [...new Set([...current.keys(), ...before.keys(), ...after.keys()])].sort();
  if (!repositories.length) {
    showToast("The current graph has no repository bases to compare.", true);
    return;
  }
  $("comparison-rows").innerHTML = repositories.map((repositoryId) => {
    const currentCommit = current.get(repositoryId) ?? "";
    return `<div class="comparison-grid comparison-row"><label title="${escapeHtml(repositoryId)}">${escapeHtml(repositoryId)}</label><input data-side="before" data-repository="${escapeHtml(repositoryId)}" aria-label="Before commit for ${escapeHtml(repositoryId)}" value="${escapeHtml(before.get(repositoryId) ?? currentCommit)}" spellcheck="false" autocomplete="off"><input data-side="after" data-repository="${escapeHtml(repositoryId)}" aria-label="After commit for ${escapeHtml(repositoryId)}" value="${escapeHtml(after.get(repositoryId) ?? currentCommit)}" spellcheck="false" autocomplete="off"></div>`;
  }).join("");
  $("comparison-error").hidden = true;
  $("comparison-editor").hidden = false;
  document.querySelector<HTMLInputElement>('[data-side="before"]')?.focus();
}

function closeComparisonEditor(): void {
  $("comparison-editor").hidden = true;
  $("open-comparison").focus();
}

function submitComparison(event: Event): void {
  event.preventDefault();
  const before: RepositoryRevisionMap = {};
  const after: RepositoryRevisionMap = {};
  const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
  for (const input of Array.from(document.querySelectorAll<HTMLInputElement>("#comparison-rows input[data-side]"))) {
    const repositoryId = input.dataset.repository;
    const side = input.dataset.side;
    const commit = input.value.trim();
    if (!repositoryId || !commitPattern.test(commit)) {
      const error = $("comparison-error");
      error.textContent = `Enter a full 40- or 64-character Git commit for ${repositoryId ?? "every repository"}.`;
      error.hidden = false;
      input.focus();
      return;
    }
    (side === "before" ? before : after)[repositoryId] = commit;
  }
  if (!Object.keys(before).length || Object.keys(before).some((repositoryId) => !after[repositoryId])) {
    const error = $("comparison-error");
    error.textContent = "Both sides must explicitly name every repository and commit.";
    error.hidden = false;
    return;
  }
  closeComparisonEditor();
  showCanvasState("Comparing explicit repository revisions…", "loading");
  vscode.postMessage({ type: "compare", beforeRevisions: before, afterRevisions: after });
}

function renderComparison(result: TemporalGraphComparisonResponse): void {
  temporalComparison = result;
  comparisonState = defaultComparisonState(result);
  renderComparisonState();
}

function renderComparisonState(): void {
  if (!temporalComparison || !comparisonState) return;
  currentComparisonView = comparisonView(temporalComparison, comparisonState);
  render(currentComparisonView.graph, true);
  document.body.classList.add("comparison-active");
  $("comparison-summary").hidden = false;
  renderComparisonBases(temporalComparison);
  const states = $("comparison-states");
  states.innerHTML = comparisonStates.map((state) => `<button type="button" class="comparison-state${state === comparisonState ? " active" : ""}" data-comparison-state="${state}" aria-pressed="${state === comparisonState}">${escapeHtml(humanize(state))} <span>${currentComparisonView!.counts[state]}</span></button>`).join("");
  states.querySelectorAll<HTMLButtonElement>("[data-comparison-state]").forEach((button) => button.addEventListener("click", () => {
    comparisonState = button.dataset.comparisonState as ComparisonState;
    renderComparisonState();
  }));
}

function renderComparisonBases(result: TemporalGraphComparisonResponse): void {
  const before = new Map(result.basis.before.map((basis) => [basis.repositoryId, basis]));
  const after = new Map(result.basis.after.map((basis) => [basis.repositoryId, basis]));
  const basisChanges = new Map(result.basisChanges.map((change) => [change.repositoryId, change.kind]));
  const repositories = [...new Set([...before.keys(), ...after.keys()])].sort();
  $("comparison-bases").innerHTML = `<table><caption>Explicit repository commit bases</caption><thead><tr><th>Repository</th><th>Before commit</th><th>After commit</th><th>Basis</th></tr></thead><tbody>${repositories.map((repositoryId) => {
    const beforeBasis = before.get(repositoryId);
    const afterBasis = after.get(repositoryId);
    const beforeCommit = beforeBasis?.resolvedCommit;
    const afterCommit = afterBasis?.resolvedCommit;
    const kind = basisChanges.get(repositoryId) ?? "unchanged";
    return `<tr><th title="${escapeHtml(repositoryId)}">${escapeHtml(repositoryId)}</th><td><code title="${escapeHtml(beforeCommit ?? "Not present")}">${escapeHtml(beforeCommit?.slice(0, 12) ?? "Not present")}</code></td><td><code title="${escapeHtml(afterCommit ?? "Not present")}">${escapeHtml(afterCommit?.slice(0, 12) ?? "Not present")}</code></td><td><span class="basis-kind ${kind}">${escapeHtml(humanize(kind))}</span></td></tr>`;
  }).join("")}</tbody></table>`;
}

function clearComparison(): void {
  temporalComparison = undefined;
  comparisonState = undefined;
  currentComparisonView = undefined;
  document.body.classList.remove("comparison-active");
  $("comparison-summary").hidden = true;
}

function exitComparison(): void {
  if (!normalGraph) return;
  clearComparison();
  render(normalGraph);
}

function renderGraph(
  previousViewport?: { zoom: number; pan: { x: number; y: number } },
): void {
  if (!graph) return;
  const nextLayoutKey = graphLayoutKey(graph);
  const layoutChanged = nextLayoutKey !== renderedLayoutKey;
  cy?.destroy();
  const elements = [
    ...graph.nodes.map((node) => ({ data: { id: node.id, label: `${kindGlyph(node.kind)}  ${graphLabel(node.label)}${node.subtitle ? `\n${node.subtitle}` : ""}`, fullLabel: node.label, subtitle: node.subtitle ?? "", kind: node.kind, focused: Boolean(node.focused || node.id === graph?.focusNodeId), changeState: currentComparisonView?.nodeStates.get(node.id) ?? "" } })),
    ...graph.edges.map((edge) => {
      const changeState = currentComparisonView?.edgeStates.get(edge.id);
      return { data: { id: edge.id, source: edge.source, target: edge.target, label: `${edge.label}${changeState ? ` · ${humanize(changeState)}` : ""}`, type: edge.type, confidence: edge.confidence, changeState: changeState ?? "" } };
    }),
  ];
  const styles = getComputedStyle(document.body);
  const themeColor = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback;
  const editorFont = styles.getPropertyValue("--vscode-editor-font-family").trim() || "ui-monospace, monospace";
  const uiFont = styles.getPropertyValue("--vscode-font-family").trim() || "system-ui, sans-serif";
  const nodeBackground = themeColor("--node-bg", "#252526");
  const nodeForeground = themeColor("--node-text", "#cccccc");
  const nodeBorder = themeColor("--node-border", "#454545");
  const focus = themeColor("--focus", "#007fd4");
  const focusBackground = themeColor("--node-focus-bg", "#04395e");
  const focusForeground = themeColor("--node-focus-text", "#ffffff");
  const blue = themeColor("--blue", "#4daafc");
  const green = themeColor("--green", "#89d185");
  const amber = themeColor("--amber", "#cca700");
  const violet = themeColor("--violet", "#b180d7");
  const pink = themeColor("--pink", "#e06c8b");
  const unresolved = themeColor("--unresolved", "#7d7d7d");
  const edge = themeColor("--edge", "#9d9d9d");
  const edgeLabelBackground = themeColor("--bg", "#1e1e1e");
  const edgeLabelForeground = themeColor("--text", "#cccccc");
  cy = cytoscape({
    container: $("graph"),
    elements,
    minZoom: 0.2,
    maxZoom: 3,
    selectionType: "single",
    boxSelectionEnabled: true,
    style: [
      { selector: "node", style: { "background-color": nodeBackground, "border-color": nodeBorder, "border-width": 1.5, shape: "round-rectangle", width: 194, height: 82, padding: "10px", label: "data(label)", color: nodeForeground, "font-family": `codicon, ${editorFont}`, "font-size": "15px", "font-weight": 550, "text-wrap": "wrap", "text-max-width": "188px", "text-valign": "center", "text-halign": "center", "overlay-opacity": 0 } },
      { selector: "node[kind = 'project']", style: { "border-color": green } },
      { selector: "node[kind = 'package-revision']", style: { "border-color": violet } },
      { selector: "node[kind = 'interface'], node[kind = 'trait']", style: { "border-color": green } },
      { selector: "node[kind = 'method']", style: { "border-color": blue } },
      { selector: "node[kind = 'commit']", style: { "border-color": pink } },
      { selector: "node[kind = 'release']", style: { "border-color": violet } },
      { selector: "node[?focused]", style: { "border-color": focus, "border-width": 3, "background-color": focusBackground, color: focusForeground } },
      { selector: "node:selected", style: { "border-color": focus, "border-width": 3, "background-color": focusBackground, color: focusForeground } },
      { selector: "edge", style: { width: 1.4, "line-color": edge, "target-arrow-color": edge, "target-arrow-shape": "triangle", "curve-style": "bezier", label: "data(label)", color: edgeLabelForeground, "font-size": "12.5px", "font-family": uiFont, "font-weight": 500, "text-background-color": edgeLabelBackground, "text-background-opacity": 0.96, "text-background-padding": "5px", "text-margin-y": -7, "text-rotation": "none", "arrow-scale": 0.8, "overlay-opacity": 0 } },
      { selector: "edge[confidence = 'possible']", style: { "line-style": "dashed", "line-color": amber, "target-arrow-color": amber } },
      { selector: "edge[confidence = 'dependency-only']", style: { "line-style": "dotted", "line-color": violet, "target-arrow-color": violet } },
      { selector: "edge[confidence = 'unresolved']", style: { "line-style": "dashed", "line-color": unresolved, "target-arrow-color": unresolved, opacity: 0.62 } },
      { selector: "edge[type = 'overrides'], edge[type = 'calls-parent']", style: { "line-color": blue, "target-arrow-color": blue, width: 2.2 } },
      { selector: "node[changeState = 'added']", style: { "border-color": green, "border-width": 3 } },
      { selector: "node[changeState = 'removed']", style: { "border-color": themeColor("--red", "#f14c4c"), "border-width": 3, opacity: 0.82 } },
      { selector: "node[changeState = 'changed']", style: { "border-color": amber, "border-width": 3 } },
      { selector: "edge[changeState = 'added']", style: { "line-color": green, "target-arrow-color": green, width: 3, "line-style": "solid" } },
      { selector: "edge[changeState = 'removed']", style: { "line-color": themeColor("--red", "#f14c4c"), "target-arrow-color": themeColor("--red", "#f14c4c"), width: 3, "line-style": "dashed", opacity: 0.86 } },
      { selector: "edge[changeState = 'changed']", style: { "line-color": amber, "target-arrow-color": amber, width: 3, "line-style": "solid" } },
      { selector: "edge[changeState = 'unchanged']", style: { opacity: 0.72 } },
      { selector: "edge:selected", style: { "line-color": focus, "target-arrow-color": focus, width: 3 } },
      { selector: ".filtered", style: { display: "none" } },
      { selector: ".dimmed", style: { opacity: 0.16 } },
    ],
  });
  const positions = layeredGraphPositions(graph.nodes, graph.edges, graph.focusNodeId);
  cy.nodes().forEach((node) => {
    const position = positions.get(node.id());
    if (position) node.position({ x: position.x, y: position.y });
  });
  if (layoutChanged || !previousViewport) {
    cy.fit(undefined, 28);
  } else if (previousViewport) {
    cy.zoom(previousViewport.zoom);
    cy.pan(previousViewport.pan);
  }
  renderedLayoutKey = nextLayoutKey;
  cy.on("tap", "node, edge", (event: EventObject) => selectElement(event.target.id(), true));
  cy.on("dbltap", "node", (event: EventObject) => { if (!temporalComparison) vscode.postMessage({ type: "expand", nodeId: event.target.id(), direction: "both" }); });
  cy.on("tap", (event: EventObject) => { if (event.target === cy) clearSelection(); });
  cy.on("pan zoom position", renderMinimap);
  if (selectedId) cy.getElementById(selectedId).select();
  renderMinimap();
  applyFilters();
}

function graphLayoutKey(value: GraphResponse): string {
  const nodes = value.nodes.map((node) => `${node.id}\0${node.kind}\0${node.label}`).sort();
  const edges = value.edges.map((edge) => `${edge.id}\0${edge.source}\0${edge.target}\0${edge.type}`).sort();
  return JSON.stringify([value.queryId, value.mode, value.focusNodeId, nodes, edges]);
}

function renderMinimap(): void {
  if (!cy) return;
  const canvas = $<HTMLCanvasElement>("graph-minimap");
  const width = canvas.clientWidth || 186;
  const height = canvas.clientHeight || 76;
  const ratio = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const bounds = cy.elements().boundingBox({ includeLabels: false });
  if (!bounds.w || !bounds.h) return;
  const padding = 8;
  const scale = Math.min((width - padding * 2) / bounds.w, (height - padding * 2) / bounds.h);
  const offsetX = (width - bounds.w * scale) / 2 - bounds.x1 * scale;
  const offsetY = (height - bounds.h * scale) / 2 - bounds.y1 * scale;
  const point = (position: { x: number; y: number }) => ({ x: position.x * scale + offsetX, y: position.y * scale + offsetY });
  const styles = getComputedStyle(document.body);
  const color = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  context.strokeStyle = color("--border", "#26313d");
  context.lineWidth = 1;
  cy.edges().forEach((edge) => {
    const source = point(edge.source().position());
    const target = point(edge.target().position());
    context.beginPath();
    context.moveTo(source.x, source.y);
    context.lineTo(target.x, target.y);
    context.stroke();
  });
  const nodeColors: Record<string, string> = { project: color("--green", "#45cf78"), "package-revision": color("--violet", "#b286ff"), class: color("--blue", "#35aef3"), interface: color("--green", "#45cf78"), trait: color("--green", "#45cf78"), method: color("--blue", "#35aef3"), commit: color("--pink", "#ef7890"), release: color("--violet", "#b286ff") };
  cy.nodes().forEach((node) => {
    const position = point(node.position());
    context.strokeStyle = nodeColors[node.data("kind")] ?? color("--muted", "#9aa8b7");
    context.lineWidth = node.id() === graph?.focusNodeId ? 2 : 1;
    context.strokeRect(position.x - 6, position.y - 3, 12, 6);
  });
  const extent = cy.extent();
  const topLeft = point({ x: extent.x1, y: extent.y1 });
  const bottomRight = point({ x: extent.x2, y: extent.y2 });
  context.strokeStyle = color("--focus", "#35aef3");
  context.lineWidth = 1;
  context.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
}

function renderTree(): void {
  if (!graph) return;
  const root = $("relationship-tree");
  root.replaceChildren();
  const focus = graph.nodes.find((node) => node.id === graph?.focusNodeId);
  if (focus) {
    const focusButton = document.createElement("button");
    focusButton.className = "tree-focus selected";
    focusButton.dataset.id = focus.id;
    focusButton.innerHTML = `${icon(kindIcon(focus.kind), "type-accent")}<strong>${escapeHtml(focus.label)}</strong><span>${graph.edges.length}</span>`;
    focusButton.addEventListener("click", () => selectElement(focus.id, true));
    root.append(focusButton);
  }
  const grouped = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    const list = grouped.get(edge.type) ?? [];
    list.push(edge);
    grouped.set(edge.type, list);
  }
  $("relationship-count").textContent = String(graph.edges.length);
  for (const [type, edges] of grouped) {
    const section = document.createElement("section");
    section.className = "tree-group";
    const heading = document.createElement("button");
    heading.className = "tree-heading";
    const initiallyExpanded = !["parameter-type", "return-type", "late-static-binding"].includes(type);
    heading.setAttribute("aria-expanded", String(initiallyExpanded));
    heading.innerHTML = `${icon(initiallyExpanded ? "chevron-down" : "chevron-right", "tree-chevron")}${icon(relationshipIcon(type), `relationship-icon ${type}`)}<strong>${escapeHtml(humanize(type))}</strong><span>${edges.length}</span>`;
    const list = document.createElement("div");
    list.className = "tree-children";
    list.hidden = !initiallyExpanded;
    heading.addEventListener("click", () => {
      const hidden = list.hidden;
      list.hidden = !hidden;
      heading.setAttribute("aria-expanded", String(hidden));
      const chevron = heading.querySelector(".tree-chevron");
      chevron?.classList.toggle("codicon-chevron-down", hidden);
      chevron?.classList.toggle("codicon-chevron-right", !hidden);
    });
    for (const edge of edges) {
      const otherId = edge.source === graph.focusNodeId ? edge.target : edge.source;
      const node = graph.nodes.find((candidate) => candidate.id === otherId);
      const button = document.createElement("button");
      button.className = "tree-item";
      button.dataset.id = edge.id;
      const changeState = currentComparisonView?.edgeStates.get(edge.id);
      button.setAttribute("aria-label", `${node?.label ?? edge.label}, ${changeState ? `${humanize(changeState)} relationship` : `${humanize(edge.confidence)} confidence`}`);
      button.innerHTML = `${icon(kindIcon(node?.kind ?? "method"), `type-icon ${node?.kind ?? "method"}`)}<span>${escapeHtml(node?.label ?? edge.label)}</span>${changeState ? `<em class="change-label ${changeState}">${escapeHtml(humanize(changeState))}</em>` : `<em class="confidence-mini ${edge.confidence}" title="${escapeHtml(edge.confidence)}"></em>`}`;
      button.addEventListener("click", () => selectElement(edge.id, true));
      list.append(button);
    }
    section.append(heading, list);
    root.append(section);
  }
}

function selectElement(id: string, addHistory: boolean): void {
  if (!graph || !cy) return;
  selectedId = id;
  cy.elements().unselect();
  cy.getElementById(id).select();
  document.querySelectorAll<HTMLElement>("[data-id]").forEach((element) => element.classList.toggle("selected", element.dataset.id === id));
  const node = graph.nodes.find((candidate) => candidate.id === id);
  const edge = graph.edges.find((candidate) => candidate.id === id);
  if (node) renderNodeDetails(node);
  if (edge) renderEdgeDetails(edge);
  if (addHistory) {
    if (navigation.at(-1) !== id) navigation.push(id);
    if (navigation.length > 8) navigation.shift();
    renderBreadcrumbs();
    vscode.setState({ selectedId: id, navigation });
  }
}

function clearSelection(): void {
  selectedId = undefined;
  cy?.elements().unselect();
  $("details").className = "details empty";
  $("details").innerHTML = "<p>Select a node or relationship to inspect its evidence.</p>";
  $("detail-kind").textContent = "Details";
  $("detail-confidence").textContent = "";
}

function togglePanel(className: "rail-open" | "inspector-open", buttonId: "toggle-relationships" | "toggle-details"): void {
  const otherClass = className === "rail-open" ? "inspector-open" : "rail-open";
  const otherButton = className === "rail-open" ? $("toggle-details") : $("toggle-relationships");
  const open = !document.body.classList.contains(className);
  document.body.classList.remove(otherClass);
  document.body.classList.toggle(className, open);
  $(buttonId).setAttribute("aria-expanded", String(open));
  otherButton.setAttribute("aria-expanded", "false");
}

function renderNodeDetails(node: GraphNode): void {
  $("detail-kind").textContent = humanize(node.kind);
  $("detail-confidence").className = "confidence";
  $("detail-confidence").textContent = node.focused ? "Focus" : "Indexed";
  const occurrence = node.occurrence;
  const reserved = new Set(["description", "documentationDetails", "signature", "parameters", "returnType", "contractSources", "lateStaticBindings", "parent", "interfaces", "traits", "receiverAnalysis", ...composerMetadataKeys]);
  const metadata = Object.entries(node.metadata).filter(([key, value]) => !reserved.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"));
  const description = typeof node.metadata.description === "string" ? node.metadata.description : undefined;
  const documentationDetails = typeof node.metadata.documentationDetails === "string" ? node.metadata.documentationDetails : undefined;
  const signature = typeof node.metadata.signature === "string" ? node.metadata.signature : undefined;
  const parameters = Array.isArray(node.metadata.parameters) ? node.metadata.parameters.filter(isRecord) : [];
  const returnType = isRecord(node.metadata.returnType) ? node.metadata.returnType : undefined;
  const contractSources = Array.isArray(node.metadata.contractSources) ? node.metadata.contractSources.filter(isRecord) : [];
  const bindings = Array.isArray(node.metadata.lateStaticBindings) ? node.metadata.lateStaticBindings.filter(isRecord) : [];
  const parent = typeof node.metadata.parent === "string" ? node.metadata.parent : undefined;
  const interfaces = stringArray(node.metadata.interfaces);
  const traits = stringArray(node.metadata.traits);
  const composerResolution = composerResolutionFromMetadata(node.metadata);
  const receiverAnalysis = receiverAnalysisFromMetadata(node.metadata);
  const typeHierarchy = [
    ...(parent ? [["Parent", parent] as const] : []),
    ...interfaces.map((value) => ["Interface", value] as const),
    ...traits.map((value) => ["Trait", value] as const),
  ];
  const temporalState = currentComparisonView?.nodeStates.get(node.id);
  const temporalFields = currentComparisonView?.changedFields.get(node.id) ?? [];
  $("details").className = "details";
  $("details").innerHTML = `
    <section class="detail-hero"><div class="detail-heading">${icon(kindIcon(node.kind), `type-icon ${node.kind}`)}<h3>${escapeHtml(node.label)}</h3></div>${node.subtitle ? `<p class="subtitle">${escapeHtml(node.subtitle)}</p>` : ""}</section>
    ${temporalState ? `<section class="temporal-detail ${temporalState}"><h3>Temporal comparison</h3><dl><dt>State</dt><dd><strong>${escapeHtml(humanize(temporalState))}</strong></dd>${temporalFields.length ? `<dt>Changed fields</dt><dd>${temporalFields.map(escapeHtml).join(" · ")}</dd>` : ""}</dl></section>` : ""}
    ${description || documentationDetails ? `<section class="description-panel"><h3>Description</h3>${description ? `<p class="description-summary">${escapeHtml(description)}</p>` : ""}${documentationDetails ? `<p>${escapeHtml(documentationDetails)}</p>` : ""}</section>` : ""}
    ${signature || parameters.length || returnType ? `<section><h3>Type contract</h3>${signature ? `<pre class="signature"><code>${escapeHtml(signature)}</code></pre>` : ""}${parameters.length ? `<div class="contract-list"><h4>Parameters</h4>${parameters.map(renderParameter).join("")}</div>` : ""}${returnType ? `<div class="contract-list"><h4>Returns</h4>${renderTypeContract(returnType, "Return value")}</div>` : ""}</section>` : ""}
    ${receiverAnalysis.length ? `<section class="receiver-analysis"><h3>${icon("inspect")} Receiver analysis</h3><div class="receiver-list">${receiverAnalysis.map(renderReceiverAnalysis).join("")}</div></section>` : ""}
    ${contractSources.length ? `<section><h3>Contract provenance</h3>${contractSources.map(renderContractSource).join("")}</section>` : ""}
    ${typeHierarchy.length ? `<section><h3>Type hierarchy</h3><dl>${typeHierarchy.map(([key, value]) => `<dt>${key}</dt><dd><code>${escapeHtml(value)}</code></dd>`).join("")}</dl></section>` : ""}
    ${bindings.length ? `<section><h3>Late static binding</h3>${bindings.map((binding) => `<article class="binding"><strong>${escapeHtml(humanize(typeof binding.kind === "string" ? binding.kind : "binding"))}</strong><p>${escapeHtml(typeof binding.detail === "string" ? binding.detail : "Resolved from static at runtime.")}</p>${isRecord(binding.range) && typeof binding.range.startLine === "number" ? `<small>Line ${binding.range.startLine}</small>` : ""}</article>`).join("")}<p class="limitation">The concrete target can be a subclass of the declaring class at runtime.</p></section>` : ""}
    ${composerResolution ? renderComposerResolution(composerResolution) : ""}
    ${occurrence ? `<section><h3>Source</h3><dl><dt>Repository</dt><dd>${escapeHtml(occurrence.revision.repositoryId)}</dd><dt>Revision</dt><dd><code>${escapeHtml(occurrence.revision.commit.slice(0, 12))}</code>${occurrence.revision.dirty ? " · local overlay" : ""}</dd><dt>Path</dt><dd><code>${escapeHtml(occurrence.path)}:${occurrence.range.startLine}</code></dd></dl><button class="primary" id="open-node-source">Open source</button></section>` : ""}
    ${metadata.length ? `<section><h3>Metadata</h3><dl>${metadata.map(([key, value]) => `<dt>${escapeHtml(humanize(key))}</dt><dd>${escapeHtml(String(value))}</dd>`).join("")}</dl></section>` : ""}
    ${temporalComparison ? "" : '<section><button id="expand-node">Expand relationships</button></section>'}`;
  document.getElementById("open-node-source")?.addEventListener("click", () => vscode.postMessage({ type: "openSource", nodeId: node.id }));
  document.getElementById("expand-node")?.addEventListener("click", () => vscode.postMessage({ type: "expand", nodeId: node.id, direction: "both" }));
}

function renderReceiverAnalysis(analysis: ReceiverAnalysisPresentation): string {
  const precise = analysis.status === "resolved" && analysis.confidence === "confirmed" && analysis.candidateTypes.length === 1;
  const statusIcon = precise ? "pass-filled" : analysis.status === "ambiguous" ? "warning" : analysis.status === "dynamic" ? "symbol-event" : "question";
  const method = analysis.methodName ?? "Dynamic or runtime method";
  const candidates = analysis.candidateTypes.length
    ? `<div class="receiver-candidates">${analysis.candidateTypes.map((candidate) => `<code>${escapeHtml(candidate)}</code>`).join("")}</div>`
    : '<span class="receiver-none">None claimed</span>';
  return `<article class="receiver-card receiver-${escapeHtml(analysis.status)}">
    <header><div>${icon(statusIcon)}<strong>${escapeHtml(method)}</strong></div><span class="receiver-status">${escapeHtml(humanize(analysis.status))}</span></header>
    <dl><dt>Expression</dt><dd><code>${escapeHtml(analysis.expression)}</code></dd><dt>Candidate types</dt><dd>${candidates}</dd><dt>Resolution source</dt><dd>${escapeHtml(humanize(analysis.resolutionMethod))}</dd><dt>Line</dt><dd>${analysis.range.startLine}</dd><dt>Confidence</dt><dd><span class="assessment-label confidence-${escapeHtml(analysis.confidence)}">${escapeHtml(humanize(analysis.confidence))}</span></dd></dl>
    <p class="receiver-precision ${precise ? "precise" : "not-claimed"}">${icon(precise ? "target" : "circle-slash")} ${escapeHtml(receiverPrecisionMessage(analysis))}</p>
    ${analysis.limitations.length ? `<div class="receiver-limitations"><strong>Limitations</strong><ul>${analysis.limitations.map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join("")}</ul></div>` : ""}
  </article>`;
}

function renderComposerResolution(resolution: ComposerResolutionPresentation): string {
  const rows = [
    ["Declared constraint", resolution.declaredConstraint],
    ["Base branch", resolution.declaredConstraintBase],
    ["Inline alias", resolution.declaredAlias],
    ["Resolved version", resolution.resolvedVersion],
    ["Source repository", resolution.normalizedSourceUrl ?? resolution.resolvedSourceUrl],
    ["Source URL", resolution.normalizedSourceUrl && resolution.resolvedSourceUrl ? resolution.resolvedSourceUrl : undefined],
    ["Source reference", resolution.resolvedSourceReference],
    ["Distribution reference", resolution.resolvedDistReference],
    ["Distribution URL", resolution.resolvedDistUrl],
    ["Installed path", resolution.resolvedPath],
    ["Indexed repository", resolution.indexedRepositoryId],
    ["Indexed revision", resolution.indexedRevision],
    ["Resolution method", resolution.resolutionMethod],
  ].filter((row): row is [string, string] => Boolean(row[1]));
  return `<section class="composer-resolution"><div class="composer-heading"><h3>${icon("package")} Composer resolution</h3>${resolution.resolution ? `<span class="resolution-label resolution-${escapeHtml(resolution.resolution)}">${escapeHtml(humanize(resolution.resolution))}</span>` : ""}</div>
    <dl>${rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd><code>${escapeHtml(value)}</code></dd>`).join("")}</dl>
    ${resolution.branchAliases.length ? `<div class="composer-subsection"><strong>Package branch aliases</strong><dl>${resolution.branchAliases.map(({ branch, alias }) => `<dt><code>${escapeHtml(branch)}</code></dt><dd><code>${escapeHtml(alias)}</code></dd>`).join("")}</dl></div>` : ""}
    ${resolution.repositoryCandidates.length ? `<div class="composer-subsection"><strong>Repository candidates</strong><div class="repository-candidates">${resolution.repositoryCandidates.map((candidate) => `<article><span class="resolution-label${candidate.canonical ? " resolution-exact" : ""}">${candidate.canonical ? "Canonical " : ""}${escapeHtml(humanize(candidate.type))}</span>${candidate.packageName ? `<strong>${escapeHtml(candidate.packageName)}</strong>` : ""}${candidate.normalizedUrl ?? candidate.url ? `<code>${escapeHtml(candidate.normalizedUrl ?? candidate.url!)}</code>` : ""}${candidate.resolvedPath ? `<code>${escapeHtml(candidate.resolvedPath)}</code>` : ""}</article>`).join("")}</div></div>` : ""}
    ${resolution.evidence.length ? `<div class="resolution-evidence"><strong>Resolution evidence</strong><ul>${resolution.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}
    ${resolution.limitations.length ? `<div class="assessment-limitations"><strong>Resolution limitations</strong><ul>${resolution.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}
  </section>`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function renderParameter(parameter: Record<string, unknown>): string {
  const name = typeof parameter.name === "string" ? `$${parameter.name}` : "Parameter";
  const flags = [parameter.byReference === true ? "by reference" : "", parameter.variadic === true ? "variadic" : ""].filter(Boolean);
  return renderTypeContract(parameter, name, flags);
}

function renderTypeContract(contract: Record<string, unknown>, labelText: string, flags: string[] = []): string {
  const declared = typeof contract.declaredType === "string" ? contract.declaredType : "untyped";
  const resolved = stringArray(contract.resolvedTypes);
  const source = contract.typeSource === "phpdoc" ? "PHPDoc" : "native";
  const description = typeof contract.description === "string" ? contract.description : undefined;
  const phpDocType = typeof contract.phpDocType === "string" ? contract.phpDocType : undefined;
  const qualifiers = [...flags, contract.nullable === true ? "nullable" : "", contract.lateStatic === true ? "late static" : ""].filter(Boolean);
  return `<article class="contract-item"><div><strong>${escapeHtml(labelText)}</strong><span class="type-source ${source.toLocaleLowerCase()}">${source}</span></div><code>${escapeHtml(declared)}</code>${resolved.length ? `<p><span>Resolves to</span> ${resolved.map((value) => `<code>${escapeHtml(value)}</code>`).join(" · ")}</p>` : ""}${phpDocType ? `<p><span>PHPDoc</span> <code>${escapeHtml(phpDocType)}</code></p>` : ""}${qualifiers.length ? `<p class="qualifiers">${qualifiers.map(escapeHtml).join(" · ")}</p>` : ""}${description ? `<p class="contract-description">${escapeHtml(description)}</p>` : ""}</article>`;
}

function renderContractSource(source: Record<string, unknown>): string {
  const symbol = typeof source.symbol === "string" ? source.symbol : "Inherited declaration";
  const relationship = typeof source.relationship === "string" ? humanize(source.relationship) : "Contract";
  const signature = typeof source.signature === "string" ? source.signature : undefined;
  const parameters = Array.isArray(source.parameters) ? source.parameters.filter(isRecord) : [];
  const returned = isRecord(source.returnType) ? source.returnType : undefined;
  return `<article class="contract-source"><div><strong>${escapeHtml(symbol)}</strong><span>${escapeHtml(relationship)}</span></div>${signature ? `<pre class="signature"><code>${escapeHtml(signature)}</code></pre>` : ""}${parameters.length ? `<div class="contract-list"><h4>Parameters</h4>${parameters.map(renderParameter).join("")}</div>` : ""}${returned ? `<div class="contract-list"><h4>Returns</h4>${renderTypeContract(returned, "Return value")}</div>` : ""}</article>`;
}

function renderEdgeDetails(edge: GraphEdge): void {
  $("detail-kind").textContent = "Relationship";
  $("detail-confidence").className = `codicon codicon-${relationshipIcon(edge.type)} detail-filter-icon`;
  $("detail-confidence").textContent = "";
  const source = graph?.nodes.find((node) => node.id === edge.source);
  const target = graph?.nodes.find((node) => node.id === edge.target);
  const sourceOccurrence = source?.occurrence;
  const evidenceSignature = typeof source?.metadata.signature === "string" ? source.metadata.signature : typeof target?.metadata.signature === "string" ? target.metadata.signature : undefined;
  const evidenceLine = edge.evidence[0]?.range?.startLine ?? sourceOccurrence?.range.startLine;
  const repositories = graph?.freshness.repositories.length ?? 0;
  const temporalState = currentComparisonView?.edgeStates.get(edge.id);
  const temporalFields = currentComparisonView?.changedFields.get(edge.id) ?? [];
  $("details").className = "details";
  $("details").innerHTML = `
    <section class="detail-hero relationship-hero"><div class="detail-heading">${icon(relationshipIcon(edge.type), `relationship-icon ${edge.type}`)}<h3>${escapeHtml(edge.label)}</h3><span class="selected-badge">Selected</span></div><p class="relationship-copy"><code>${escapeHtml(source?.label ?? edge.source)}</code><br>${escapeHtml(edge.label.toLocaleLowerCase())} <code>${escapeHtml(target?.label ?? edge.target)}</code></p></section>
    ${temporalState ? `<section class="temporal-detail ${temporalState}"><h3>Relationship comparison</h3><dl><dt>State</dt><dd><strong>${escapeHtml(humanize(temporalState))}</strong></dd>${temporalFields.length ? `<dt>Changed fields</dt><dd>${temporalFields.map(escapeHtml).join(" · ")}</dd>` : ""}</dl></section>` : ""}
    <section class="detail-section"><h3>${detailSectionToggle("Source")}</h3><dl class="relationship-source"><dt>From</dt><dd>${icon(kindIcon(source?.kind ?? "method"), `type-icon ${source?.kind ?? "method"}`)}<code>${escapeHtml(source?.label ?? edge.source)}</code></dd><dt>To</dt><dd>${icon(kindIcon(target?.kind ?? "method"), `type-icon ${target?.kind ?? "method"}`)}<code>${escapeHtml(target?.label ?? edge.target)}</code></dd><dt>Type</dt><dd>${icon(relationshipIcon(edge.type), `relationship-icon ${edge.type}`)}${escapeHtml(humanize(edge.type))}</dd><dt>Confidence</dt><dd><i class="confidence-mini ${edge.confidence}"></i><strong class="confidence-text ${edge.confidence}">${escapeHtml(humanize(edge.confidence))}</strong></dd></dl></section>
    <section class="detail-section"><h3>${detailSectionToggle("Evidence")}</h3>${edge.evidence.map((evidence, index) => `<article class="evidence"><p>${escapeHtml(evidence.detail)}</p>${evidenceSignature ? `<div class="code-evidence">${evidenceLine ? `<span class="line-number">${evidenceLine}</span>` : ""}<pre><code>${escapeHtml(evidenceSignature)}</code></pre></div>` : ""}<dl><dt>Method</dt><dd>${escapeHtml(evidence.resolutionMethod)}</dd><dt>Revision</dt><dd><code>${escapeHtml(evidence.commit.slice(0, 12))}</code></dd>${evidence.path ? `<dt>Source</dt><dd><code>${escapeHtml(evidence.path)}${evidence.range ? `:${evidence.range.startLine}` : ""}</code></dd>` : ""}</dl>${evidence.limitations.length ? `<p class="limitation">${evidence.limitations.map(escapeHtml).join(" · ")}</p>` : ""}${evidence.path ? `<button data-evidence="${index}">${icon("go-to-file")}Open evidence</button>` : ""}</article>`).join("")}</section>
    ${sourceOccurrence ? `<section class="detail-section"><h3>${detailSectionToggle("Repository")}</h3><dl><dt>${icon("repo")}</dt><dd>${escapeHtml(sourceOccurrence.revision.repositoryId)}</dd><dt>${icon("source-control")}</dt><dd><code>${escapeHtml(sourceOccurrence.revision.commit.slice(0, 12))}</code>${sourceOccurrence.revision.dirty ? " · local overlay" : ""}</dd></dl><button class="primary" id="open-edge-source">${icon("go-to-file")}Open in VS Code</button></section>` : ""}
    <section class="detail-section"><h3>${detailSectionToggle("Context")}</h3><dl><dt>Confidence</dt><dd><i class="confidence-mini ${edge.confidence}"></i>${escapeHtml(humanize(edge.confidence))}</dd><dt>Analysis scope</dt><dd>${graph?.freshness.partial ? "Local overlay" : "Indexed revision"}</dd><dt>Scope</dt><dd>${repositories} repositor${repositories === 1 ? "y" : "ies"}</dd>${graph?.freshness.limitations.length ? `<dt>Limitations</dt><dd>${graph.freshness.limitations.map(escapeHtml).join(" · ")}</dd>` : ""}</dl></section>`;
  wireDetailSections();
  document.querySelectorAll<HTMLButtonElement>("[data-evidence]").forEach((button) => button.addEventListener("click", () => vscode.postMessage({ type: "openEvidence", edgeId: edge.id, evidenceIndex: Number(button.dataset.evidence) })));
  document.getElementById("open-edge-source")?.addEventListener("click", () => vscode.postMessage({ type: "openSource", nodeId: source?.id ?? edge.source }));
}

function detailSectionToggle(label: string): string {
  return `<button class="detail-section-toggle" type="button" aria-expanded="true"><span>${escapeHtml(label)}</span>${icon("chevron-down")}</button>`;
}

function wireDetailSections(): void {
  document.querySelectorAll<HTMLButtonElement>(".detail-section-toggle").forEach((button) => button.addEventListener("click", () => {
    const section = button.closest<HTMLElement>(".detail-section");
    if (!section) return;
    const expanded = button.getAttribute("aria-expanded") !== "false";
    button.setAttribute("aria-expanded", String(!expanded));
    Array.from(section.children).forEach((child) => {
      if (child !== button.parentElement) (child as HTMLElement).hidden = expanded;
    });
  }));
}

function renderTimeline(): void {
  if (!graph) return;
  const timeline = $("timeline");
  timeline.replaceChildren();
  $("history-count").textContent = `${graph.history.length} event${graph.history.length === 1 ? "" : "s"}`;
  const historyBasis = temporalComparison ? comparisonState === "removed" ? "Before graph · " : "After graph · " : "";
  $("history-symbol").textContent = `${historyBasis}${graph.nodes.find((node) => node.id === graph?.focusNodeId)?.label ?? ""}`;
  if (!graph.history.length) {
    timeline.innerHTML = '<p class="empty-history">No history events were identified within the indexed scope.</p>';
    return;
  }
  for (const event of graph.history) timeline.append(historyButton(event));
}

function historyButton(event: HistoryEvent): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = `history-event ${event.category}`;
  button.innerHTML = `<span class="event-dot"></span>${icon(event.category === "introduction" ? "git-commit" : event.category === "signature" ? "tag" : "source-control", "event-icon")}<code>${escapeHtml(event.commit.slice(0, 8))}</code><strong>${escapeHtml(event.summary)}</strong><time datetime="${escapeHtml(event.authoredAt)}">${new Date(event.authoredAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</time>`;
  button.title = "Inspect this history event";
  button.addEventListener("click", () => renderHistoryDetails(event));
  return button;
}

function renderHistoryDetails(event: HistoryEvent): void {
  selectedId = event.id;
  $("detail-kind").textContent = "History event";
  const confidence = event.lineage?.confidence;
  $("detail-confidence").className = `confidence ${confidence ?? "confirmed"}`;
  $("detail-confidence").textContent = confidence ? humanize(confidence) : humanize(event.category);
  $("details").className = "details";
  const lineage = event.lineage ? `
    <section class="lineage-detail">
      <h3>${icon(event.category === "rename" ? "edit" : "git-compare")} ${escapeHtml(humanize(event.category))} lineage</h3>
      <dl>
        <dt>From symbol</dt><dd><code>${escapeHtml(event.lineage.fromSymbol)}</code></dd>
        <dt>From path</dt><dd><code>${escapeHtml(event.lineage.fromPath)}</code></dd>
        <dt>To symbol</dt><dd><code>${escapeHtml(event.lineage.toSymbol)}</code></dd>
        <dt>To path</dt><dd><code>${escapeHtml(event.lineage.toPath)}</code></dd>
        <dt>Confidence</dt><dd><span class="assessment-label confidence-${escapeHtml(event.lineage.confidence)}">${escapeHtml(humanize(event.lineage.confidence))}</span></dd>
      </dl>
      ${renderEvidenceList(event.lineage.evidence)}
      ${event.lineage.limitations.length ? `<div class="assessment-limitations"><strong>Lineage limitations</strong><ul>${event.lineage.limitations.map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join("")}</ul></div>` : ""}
    </section>` : "";
  $("details").innerHTML = `
    <section><h3>${escapeHtml(event.summary)}</h3><p class="subtitle"><code>${escapeHtml(event.commit.slice(0, 12))}</code></p></section>
    <section><h3>Change</h3><dl><dt>Category</dt><dd>${escapeHtml(humanize(event.category))}</dd><dt>Author</dt><dd>${escapeHtml(event.authorName)}</dd><dt>Date</dt><dd>${escapeHtml(new Date(event.authoredAt).toLocaleString())}</dd></dl>${event.limitations.length ? `<p class="limitation">${event.limitations.map(escapeHtml).join(" · ")}</p>` : ""}</section>
    ${lineage}
    <section><button class="primary" id="open-history-diff">Open before/after diff</button><button id="check-inclusion">Check releases, consumers and active behaviour</button><div id="history-inclusion" aria-live="polite"></div></section>`;
  $("open-history-diff").addEventListener("click", () => vscode.postMessage({ type: "openHistory", eventId: event.id, side: "diff" }));
  $("check-inclusion").addEventListener("click", () => {
    $("history-inclusion").textContent = "Checking ancestry, equivalent patches and active behaviour…";
    vscode.postMessage({ type: "checkInclusion", eventId: event.id });
  });
}

function renderInclusion(eventId: string, result: ChangeInclusionResponse): void {
  if (selectedId !== eventId) return;
  const target = document.getElementById("history-inclusion");
  if (!target) return;
  const releases = result.releaseAssessments.length
    ? result.releaseAssessments.map((release) => renderAssessmentCard(
      release.release,
      `Revision ${release.revision.slice(0, 12)}`,
      release,
      release.evidence,
      release.limitations,
    )).join("")
    : result.releases.length
      ? result.releases.map((release) => `<article class="assessment-card"><h4>${icon("tag")} ${escapeHtml(release)}</h4><p>Contains the original commit; active behaviour was not assessed.</p></article>`).join("")
      : '<p class="empty-assessment">No release assessment was identified in indexed history.</p>';
  const consumers = result.consumers.length
    ? result.consumers.map((consumer) => renderAssessmentCard(
      consumer.consumerRepositoryId,
      `${consumer.packageName} · ${consumer.resolvedVersion ?? consumer.declaredConstraint ?? "unresolved"}`,
      consumer,
      consumer.evidence,
      consumer.limitations,
      consumer.reason,
    )).join("")
    : '<p class="empty-assessment">No indexed consumers resolve this package.</p>';
  const pullRequests = result.githubAssociations.pullRequests.length
    ? result.githubAssociations.pullRequests.map(renderGitHubPullRequest).join("")
    : '<p class="empty-assessment">No associated GitHub pull requests were identified.</p>';
  const githubReleases = result.githubAssociations.releases.length
    ? result.githubAssociations.releases.map(renderGitHubRelease).join("")
    : '<p class="empty-assessment">No associated GitHub releases were identified.</p>';
  target.innerHTML = `<div class="inclusion-results"><section aria-labelledby="release-assessment-title"><h3 id="release-assessment-title">Release inclusion and behaviour</h3><div class="assessment-list">${releases}</div></section><section aria-labelledby="consumer-assessment-title"><h3 id="consumer-assessment-title">Consumer inclusion and behaviour</h3><div class="assessment-list">${consumers}</div></section><section aria-labelledby="github-pr-title"><h3 id="github-pr-title">Associated GitHub pull requests</h3><div class="assessment-list">${pullRequests}</div></section><section aria-labelledby="github-release-title"><h3 id="github-release-title">Associated GitHub releases</h3><div class="assessment-list">${githubReleases}</div></section>${result.githubAssociations.limitations.length ? `<div class="assessment-limitations"><strong>GitHub association limitations</strong><ul>${result.githubAssociations.limitations.map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join("")}</ul></div>` : ""}${result.limitations.length ? `<div class="assessment-limitations"><strong>Assessment limitations</strong><ul>${result.limitations.map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join("")}</ul></div>` : ""}</div>`;
  target.querySelectorAll<HTMLButtonElement>("[data-github-url]").forEach((button) => button.addEventListener("click", () => {
    const url = button.dataset.githubUrl;
    if (url && isAllowedGitHubUrl(url)) vscode.postMessage({ type: "openGitHub", url });
  }));
}

function renderGitHubPullRequest(pullRequest: ChangeInclusionResponse["githubAssociations"]["pullRequests"][number]): string {
  const merged = pullRequest.mergedAt ? `Merged ${new Date(pullRequest.mergedAt).toLocaleDateString()}` : humanize(pullRequest.state);
  const head = pullRequest.headRepository ? `<dt>Head fork</dt><dd>${escapeHtml(pullRequest.headRepository)}</dd>` : "";
  const headCommit = pullRequest.headCommit ? `<dt>Head commit</dt><dd><code>${escapeHtml(pullRequest.headCommit.slice(0, 12))}</code></dd>` : "";
  return `<article class="assessment-card github-association"><header><div><h4>${icon("git-pull-request")} ${escapeHtml(pullRequest.repository)} #${pullRequest.number}</h4><p>${escapeHtml(pullRequest.title)}</p></div><span class="assessment-label confidence-${escapeHtml(pullRequest.confidence)}">${escapeHtml(humanize(pullRequest.confidence))}</span></header><dl><dt>State</dt><dd>${escapeHtml(merged)}</dd><dt>Commit</dt><dd><code>${escapeHtml(pullRequest.commit.slice(0, 12))}</code></dd>${head}${headCommit}</dl>${renderEvidenceList(pullRequest.evidence)}${pullRequest.limitations.length ? renderAssociationLimitations(pullRequest.limitations) : ""}${githubButton(pullRequest.url)}</article>`;
}

function renderGitHubRelease(release: ChangeInclusionResponse["githubAssociations"]["releases"][number]): string {
  const publication = release.publishedAt ? new Date(release.publishedAt).toLocaleDateString() : "Publication date unavailable";
  const releaseState = release.draft ? "Draft" : release.prerelease ? "Prerelease" : "Published";
  return `<article class="assessment-card github-association"><header><div><h4>${icon("tag")} ${escapeHtml(release.tagName)}</h4><p>${escapeHtml(release.name ?? release.repository)}</p></div><span class="assessment-label confidence-${escapeHtml(release.confidence)}">${escapeHtml(humanize(release.confidence))}</span></header><dl><dt>Repository</dt><dd>${escapeHtml(release.repository)}</dd><dt>Release state</dt><dd>${releaseState}</dd><dt>Tag commit</dt><dd><code>${escapeHtml(release.tagCommit.slice(0, 12))}</code></dd>${release.targetCommitish ? `<dt>Target</dt><dd><code>${escapeHtml(release.targetCommitish)}</code></dd>` : ""}<dt>Published</dt><dd>${escapeHtml(publication)}</dd></dl>${renderEvidenceList(release.evidence)}${release.limitations.length ? renderAssociationLimitations(release.limitations) : ""}${githubButton(release.url)}</article>`;
}

function githubButton(url: string): string {
  return isAllowedGitHubUrl(url) ? `<button type="button" class="github-button" data-github-url="${escapeHtml(url)}">${icon("github")} Open in GitHub</button>` : '<p class="limitation">The associated URL is not an allowed github.com link.</p>';
}

function renderAssociationLimitations(limitations: string[]): string {
  return `<div class="assessment-limitations"><strong>Association limitations</strong><ul>${limitations.map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join("")}</ul></div>`;
}

function renderAssessmentCard(
  title: string,
  subtitle: string,
  assessment: InclusionAssessmentLike,
  evidence: Evidence[],
  limitations: string[],
  reason?: string,
): string {
  const presentation = presentAssessment(assessment);
  const commits = presentation.commits.map(({ label, commit }) => `<dt>${escapeHtml(label)}</dt><dd><code title="${escapeHtml(commit)}">${escapeHtml(commit.slice(0, 12))}</code></dd>`).join("");
  return `<article class="assessment-card behaviour-${escapeHtml(assessment.activeBehaviour)}">
    <header><div><h4>${escapeHtml(title)}</h4><p>${escapeHtml(subtitle)}</p></div><span class="assessment-label behaviour-${escapeHtml(assessment.activeBehaviour)}">${escapeHtml(presentation.activeBehaviourLabel)}</span></header>
    <dl><dt>Inclusion</dt><dd><span class="assessment-label inclusion-${escapeHtml(assessment.state)}">${escapeHtml(presentation.inclusionLabel)}</span></dd><dt>Active behaviour</dt><dd>${escapeHtml(presentation.activeBehaviourLabel)}</dd>${commits}</dl>
    ${reason ? `<p class="assessment-reason">${escapeHtml(reason)}</p>` : ""}
    ${renderEvidenceList(evidence)}
    ${limitations.length ? `<div class="assessment-limitations"><strong>Limitations</strong><ul>${limitations.map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join("")}</ul></div>` : ""}
  </article>`;
}

function renderEvidenceList(evidence: Evidence[]): string {
  if (!evidence.length) return '<p class="empty-assessment">No supporting source evidence was available.</p>';
  return `<details class="assessment-evidence"><summary>Evidence (${evidence.length})</summary>${evidence.map((item) => `<article><strong>${escapeHtml(item.detail)}</strong><p>${escapeHtml(item.resolutionMethod)} · ${escapeHtml(item.confidence)}</p>${item.path ? `<code>${escapeHtml(item.path)}${item.range ? `:${item.range.startLine}` : ""}</code>` : ""}${item.limitations.length ? `<ul>${item.limitations.map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join("")}</ul>` : ""}</article>`).join("")}</details>`;
}

function renderStatus(): void {
  if (!graph) return;
  $("index-status").innerHTML = `<i class="status-dot"></i>Indexed at <code>${escapeHtml(graph.freshness.repositories[0]?.commit.slice(0, 8) ?? `generation ${graph.freshness.generation}`)}</code>`;
  $("overlay-status").textContent = graph.nodes.some((node) => node.occurrence?.overlayId) ? "Local overlay" : "Indexed source";
  $("scope-status").textContent = `Scope: ${graph.freshness.repositories.length} repositories`;
  $("partial-status").textContent = graph.freshness.partial ? "Partial" : "Index up to date";
  $("partial-status").title = graph.freshness.partial ? graph.freshness.limitations.join(" · ") : `Indexed ${new Date(graph.freshness.indexedAt).toLocaleString()}`;
  $("partial-status").className = graph.freshness.partial ? "partial" : "complete";
}

function renderLegend(): void {
  const kinds = [...new Set(graph?.nodes.map((node) => node.kind) ?? [])];
  const temporal = comparisonState ? `<span class="change-label ${comparisonState}">${escapeHtml(humanize(comparisonState))} relationships only</span>` : "";
  $("legend").innerHTML = `${kinds.map((kind) => `<span>${icon(kindIcon(kind), `type-icon ${kind}`)}${escapeHtml(humanize(kind))}</span>`).join("")}<span><i class="line solid"></i>Confirmed</span><span><i class="line dashed"></i>Possible</span><span><i class="line dotted"></i>Dependency only</span>${temporal}`;
}

function renderBreadcrumbs(): void {
  $("breadcrumbs").innerHTML = navigation.map((id, index) => {
    const item = graph?.nodes.find((node) => node.id === id)?.label ?? graph?.edges.find((edge) => edge.id === id)?.label ?? id;
    return `${index ? '<span aria-hidden="true">›</span>' : ""}<button data-breadcrumb="${escapeHtml(id)}">${escapeHtml(item)}</button>`;
  }).join("");
  document.querySelectorAll<HTMLButtonElement>("[data-breadcrumb]").forEach((button) => button.addEventListener("click", () => selectElement(button.dataset.breadcrumb!, false)));
}

function applyFilters(): void {
  if (!cy || !graph) return;
  cy.elements().removeClass("filtered dimmed");
  for (const edge of graph.edges) {
    if (confidence !== "all" && edge.confidence !== confidence) cy.getElementById(edge.id).addClass("filtered");
  }
  if (search) {
    const matching = cy.nodes().filter((node: NodeSingular) => `${node.data("fullLabel")} ${node.data("subtitle")}`.toLocaleLowerCase().includes(search));
    cy.elements().addClass("dimmed");
    matching.removeClass("dimmed");
    matching.connectedEdges().removeClass("dimmed");
    matching.connectedEdges().connectedNodes().removeClass("dimmed");
  }
  const visibleEdges = cy.edges().filter((edge: EdgeSingular) => !edge.hasClass("filtered"));
  cy.nodes().forEach((node) => { node.toggleClass("filtered", node.id() !== graph?.focusNodeId && visibleEdges.connectedNodes().filter(`#${cssEscape(node.id())}`).length === 0 && confidence !== "all"); });
  document.querySelectorAll<HTMLElement>(".tree-group").forEach((group) => {
    let visible = 0;
    group.querySelectorAll<HTMLButtonElement>(".tree-item").forEach((item) => {
      const edge = graph?.edges.find((candidate) => candidate.id === item.dataset.id);
      const otherId = edge ? edge.source === graph?.focusNodeId ? edge.target : edge.source : undefined;
      const node = graph?.nodes.find((candidate) => candidate.id === otherId);
      const matchesConfidence = Boolean(edge) && (confidence === "all" || edge?.confidence === confidence);
      const matchesSearch = !search || `${node?.label ?? ""} ${edge?.label ?? ""}`.toLocaleLowerCase().includes(search);
      item.hidden = !(matchesConfidence && matchesSearch);
      if (!item.hidden) visible += 1;
    });
    group.hidden = visible === 0;
    const count = group.querySelector<HTMLElement>(".tree-heading span:last-child");
    if (count) count.textContent = String(visible);
  });
}

function showCanvasState(message: string, kind: string): void {
  const element = $("canvas-state");
  element.hidden = false;
  element.className = `canvas-state ${kind}`;
  element.textContent = message;
}

function showToast(message: string, persistent = false): void {
  const toast = $("toast");
  toast.hidden = false;
  toast.textContent = message;
  if (!persistent) window.setTimeout(() => { toast.hidden = true; }, 3500);
}

function humanize(value: string): string {
  return value.replaceAll("-", " ").replaceAll(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

function icon(name: string, className = ""): string {
  return `<i class="codicon codicon-${escapeHtml(name)} ${escapeHtml(className)}" aria-hidden="true"></i>`;
}

function kindIcon(kind: string): string {
  return ({ project: "folder", "package-revision": "package", class: "symbol-class", interface: "symbol-interface", trait: "symbol-structure", method: "symbol-method", commit: "git-commit", release: "tag" } as Record<string, string>)[kind] ?? "symbol-misc";
}

function kindGlyph(kind: string): string {
  return ({ project: "\uea83", "package-revision": "\ueb29", class: "\ueb5b", interface: "\ueb61", trait: "\uea91", method: "\uea8c", commit: "\ueafc", release: "\uea66" } as Record<string, string>)[kind] ?? "\ueb63";
}

function relationshipIcon(type: string): string {
  return ({ declares: "references", extends: "type-hierarchy", implements: "type-hierarchy", "implements-method": "type-hierarchy", inherits: "type-hierarchy", overrides: "arrow-right", calls: "call-outgoing", "calls-parent": "arrow-right", requires: "library", "uses-trait": "symbol-structure", "parameter-type": "symbol-parameter", "return-type": "symbol-method-arrow", "late-static-binding": "symbol-key", "changed-in": "git-commit", "included-in-release": "tag", "possible-lineage": "git-compare" } as Record<string, string>)[type] ?? "link";
}

function graphLabel(value: string): string {
  const separator = value.indexOf("::");
  if (separator < 0) return value;
  const owner = value.slice(0, separator);
  const member = value.slice(separator + 2).replace(/\(\)$/, "");
  const namespaceSeparator = owner.lastIndexOf("\\");
  const ownerLines = namespaceSeparator > 0 ? `${owner.slice(0, namespaceSeparator)}\n${owner.slice(namespaceSeparator + 1)}` : owner;
  return `${ownerLines}\n${member}`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function cssEscape(value: string): string {
  return globalThis.CSS?.escape(value) ?? value.replaceAll(/[^a-zA-Z0-9_-]/g, "\\$&");
}
