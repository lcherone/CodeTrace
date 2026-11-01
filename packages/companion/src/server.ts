import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { BrowserLaunchRequestSchema, CodeLensCountsRequestSchema, EditorContextUpdateRequestSchema, PROTOCOL_VERSION, SelectionSchema, TemporalGraphComparisonRequestSchema, type CompanionStatus, type GraphResponse, type HistoryEvent, type TemporalGraphComparisonResponse } from "@trace/contracts";
import { CredentialStore } from "./credentials.js";
import { sanitizeRepositoryUrl } from "./composer.js";
import { adminDashboardHtml } from "./dashboard.js";
import { BrowserSessionBroker, EditorContextHub } from "./browser-state.js";
import { GitRepository } from "./git.js";
import { GraphService } from "./graph.js";
import { GitHubClient, parseGitHubRepository } from "./github.js";
import { HistoryService } from "./history.js";
import { ExplorationService } from "./exploration.js";
import { MethodImpactService } from "./method-impact.js";
import { IndexCoordinator, ScannerBackpressureError, type ScannerOptions } from "./indexer.js";
import { LensCountService, LensRevisionError } from "./lens-counts.js";
import type { RepositoryRecord } from "./model.js";
import { linkComposerRevisions } from "./relationships.js";
import { TraceStore } from "./store.js";
import { TemporalGraphService, TemporalRevisionError } from "./temporal.js";

const TraceRequest = z.object({ protocolVersion: z.literal(PROTOCOL_VERSION), mode: z.enum(["origin", "inheritance", "callers", "consumers", "impact", "history"]), stage: z.enum(["overview", "complete"]).optional(), selection: SelectionSchema, limit: z.number().int().min(1).max(500).optional() });
const RepositoryRequest = z.object({ protocolVersion: z.literal(PROTOCOL_VERSION), id: z.string().min(1).max(200), root: z.string().min(1), remoteUrl: z.string().min(1).optional(), defaultBranch: z.string().optional(), include: z.array(z.string()).optional(), exclude: z.array(z.string()).optional() });

export interface ServerOptions { host: string; port: number; dataDirectory: string; fixtureMode: boolean; token?: string; automaticScan?: boolean; scanner?: ScannerOptions; githubApiBase?: string }

const json = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(JSON.stringify(value));
};
const errorBody = (code: string, message: string, details?: unknown) => ({ protocolVersion: PROTOCOL_VERSION, error: { code, message, ...(details === undefined ? {} : { details }) } });

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const value = Buffer.from(chunk); size += value.length; if (size > 5 * 1024 * 1024) throw new Error("Request body exceeds 5 MB"); chunks.push(value); }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function secureEqual(actual: string, expected: string): boolean {
  const a = createHash("sha256").update(actual).digest(); const b = createHash("sha256").update(expected).digest(); return timingSafeEqual(a, b);
}

function historyWithoutSource(event: HistoryEvent): HistoryEvent {
  const { beforeSource: _beforeSource, afterSource: _afterSource, ...safe } = event;
  return safe;
}

function graphWithoutSource(graph: GraphResponse): GraphResponse {
  return { ...graph, history: graph.history.map(historyWithoutSource) };
}

function comparisonWithoutSource(comparison: TemporalGraphComparisonResponse): TemporalGraphComparisonResponse {
  return { ...comparison, before: graphWithoutSource(comparison.before), after: graphWithoutSource(comparison.after) };
}

async function ensureToken(dataDirectory: string, supplied?: string): Promise<{ token: string; path: string }> {
  const tokenPath = path.join(dataDirectory, "client-token"); await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  if (supplied) return { token: supplied, path: tokenPath };
  try { return { token: (await readFile(tokenPath, "utf8")).trim(), path: tokenPath }; }
  catch { const token = randomBytes(32).toString("base64url"); await writeFile(tokenPath, `${token}\n`, { mode: 0o600 }); await chmod(tokenPath, 0o600); return { token, path: tokenPath }; }
}

export async function startServer(options: ServerOptions): Promise<{ close: () => Promise<void>; url: string; tokenPath: string; store: TraceStore }> {
  if (!["127.0.0.1", "::1", "localhost"].includes(options.host)) throw new Error("Trace companion may only bind to a loopback host");
  const credentials = new CredentialStore(options.dataDirectory);
  const { token, path: tokenPath } = await ensureToken(options.dataDirectory, options.token);
  const store = new TraceStore(path.join(options.dataDirectory, "trace.sqlite"));
  const indexer = new IndexCoordinator(store, options.scanner);
  const graphs = new GraphService(store);
  const temporalGraphs = new TemporalGraphService(store, graphs);
  const lensCounts = new LensCountService(store);
  const history = new HistoryService(store);
  const exploration = new ExplorationService(store, graphs);
  const methodImpact = new MethodImpactService(store, graphs);
  const browserSessions = new BrowserSessionBroker();
  const editorContexts = new EditorContextHub();
  const enrichRepository = async (repository: RepositoryRecord): Promise<RepositoryRecord> => {
    if (repository.remoteUrl && repository.defaultBranch) return repository;
    const git = new GitRepository(repository.root);
    const [remoteUrl, revision] = await Promise.all([git.remoteUrl(), git.headIdentity()]);
    const discoveredRemoteUrl = sanitizeRepositoryUrl(remoteUrl);
    return {
      ...repository,
      ...(!repository.remoteUrl && discoveredRemoteUrl ? { remoteUrl: discoveredRemoteUrl } : {}),
      ...(!repository.defaultBranch && revision.branch ? { defaultBranch: revision.branch } : {}),
      ...(!repository.sourceRevision ? { sourceRevision: revision.commit } : {}),
    };
  };
  const [browserHtml, browserBridge, browserScript, browserStyles, browserFont] = await Promise.all([
    readFile(new URL("./browser/index.html", import.meta.url)),
    readFile(new URL("./browser/bridge.js", import.meta.url)),
    readFile(new URL("./browser/app.js", import.meta.url)),
    readFile(new URL("./browser/app.css", import.meta.url)),
    readFile(new URL("./browser/codicon.ttf", import.meta.url)),
  ]);
  const started = Date.now();
  const server = createServer(async (request, response) => {
    const requestAbort = new AbortController();
    request.once("aborted", () => requestAbort.abort());
    response.once("close", () => { if (!response.writableEnded) requestAbort.abort(); });
    const url = new URL(request.url ?? "/", `http://${options.host}:${options.port}`);
    const method = request.method ?? "GET";
    const origin = request.headers.origin;
    if (origin) {
      const address = server.address();
      const activePort = typeof address === "object" && address ? address.port : options.port;
      const allowed = origin === `http://127.0.0.1:${activePort}` || origin === `http://localhost:${activePort}` || origin === `http://[::1]:${activePort}` || origin.startsWith("vscode-webview://") || origin.endsWith(".vscode-webview.net");
      if (!allowed) return json(response, 403, errorBody("UNAUTHORIZED", "Origin is not allowed"));
      response.setHeader("Access-Control-Allow-Origin", origin); response.setHeader("Vary", "Origin"); response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Trace-Protocol"); response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    }
    if (method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    if (url.pathname === "/health") return json(response, 200, { service: "trace-companion", protocolVersion: PROTOCOL_VERSION, status: "ok" });
    if (url.pathname === "/" && method === "GET" && url.searchParams.has("ticket")) {
      const exchanged = browserSessions.exchange(url.searchParams.get("ticket") ?? "");
      if (!exchanged) return json(response, 401, errorBody("UNAUTHORIZED", "Browser launch ticket is invalid, expired, or already used"));
      response.writeHead(303, { Location: "/", "Set-Cookie": exchanged.cookie, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff" }); response.end(); return;
    }
    if (url.pathname === "/" && method === "GET") { const nonce = randomBytes(18).toString("base64url"); const html = browserHtml.toString("utf8").replaceAll("{{NONCE}}", nonce); const contentSecurityPolicy = `default-src 'none'; style-src 'self' 'nonce-${nonce}'; script-src 'self' 'nonce-${nonce}'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`; response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": contentSecurityPolicy, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff" }); response.end(html); return; }
    if (url.pathname === "/favicon.ico" && method === "GET") { response.writeHead(204, { "Cache-Control": "public,max-age=86400" }); response.end(); return; }
    if (url.pathname === "/admin" && method === "GET") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff" }); response.end(adminDashboardHtml); return; }
    if (url.pathname === "/browser/app.js" && method === "GET") { response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(browserScript); return; }
    if (url.pathname === "/browser/bridge.js" && method === "GET") { response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(browserBridge); return; }
    if (url.pathname === "/browser/app.css" && method === "GET") { response.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(browserStyles); return; }
    if (url.pathname === "/browser/codicon.ttf" && method === "GET") { response.writeHead(200, { "Content-Type": "font/ttf", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(browserFont); return; }
    if (!url.pathname.startsWith("/v1/")) return json(response, 404, errorBody("NOT_FOUND", "Route not found"));
    if (request.headers["x-trace-protocol"] !== PROTOCOL_VERSION) return json(response, 409, errorBody("PROTOCOL_MISMATCH", `Companion protocol ${PROTOCOL_VERSION} is required`));
    const authorization = request.headers.authorization ?? "";
    const bearerAuthenticated = authorization.startsWith("Bearer ") && secureEqual(authorization.slice(7), token);
    const browserAuthenticated = browserSessions.authenticate(request.headers.cookie);
    const statusIsPublic = url.pathname === "/v1/status" && method === "GET";
    if (!statusIsPublic) {
      if (!bearerAuthenticated && !browserAuthenticated) return json(response, 401, errorBody("UNAUTHORIZED", "A valid local client token or browser session is required"));
    }
    if (["POST", "PUT", "DELETE"].includes(method) && request.headers["content-type"]?.split(";")[0] !== "application/json" && method !== "DELETE") return json(response, 415, errorBody("INVALID_REQUEST", "Mutation requests require application/json"));

    try {
      if (url.pathname === "/v1/browser-launch" && method === "POST") {
        BrowserLaunchRequestSchema.parse(await body(request));
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : options.port;
        const host = options.host === "::1" ? "[::1]" : options.host === "localhost" ? "localhost" : "127.0.0.1";
        return json(response, 201, browserSessions.launch(`http://${host}:${port}`));
      }
      if (url.pathname === "/v1/editor-context" && method === "POST") {
        const parsed = EditorContextUpdateRequestSchema.parse(await body(request));
        if (parsed.context === null) return json(response, 200, editorContexts.publish(parsed.clientId, null));
        const publishedContext = parsed.context;
        const repository = store.listRepositories().find((item) => item.root === publishedContext.selection.repositoryPath);
        if (!repository) return json(response, 404, errorBody("NOT_FOUND", "Editor repository is not configured"));
        const basis = store.activeGenerationBasis(repository.id);
        if (!basis) return json(response, 409, errorBody("CONFLICT", "Editor repository has no published generation"));
        if (basis.commit !== publishedContext.selection.revision.commit) return json(response, 409, errorBody("CONFLICT", "Editor revision does not match the active indexed generation", { repositoryId: repository.id, indexedCommit: basis.commit, requestedCommit: publishedContext.selection.revision.commit }));
        const context = { ...publishedContext, selection: { ...publishedContext.selection, revision: { ...publishedContext.selection.revision, repositoryId: repository.id } } };
        return json(response, 200, editorContexts.publish(parsed.clientId, context, basis.generation));
      }
      if (url.pathname === "/v1/editor-context" && method === "GET") {
        const parsed = z.object({ after: z.coerce.number().int().nonnegative().default(0), waitMs: z.coerce.number().int().min(0).max(25_000).default(0) }).parse(Object.fromEntries(url.searchParams));
        return json(response, 200, await editorContexts.poll(parsed.after, parsed.waitMs, requestAbort.signal));
      }
      if (url.pathname === "/v1/status" && method === "GET") {
        const scanner = indexer.snapshot();
        const active = scanner.active > 0 || scanner.queued > 0;
        const status: CompanionStatus = { protocolVersion: PROTOCOL_VERSION, service: "trace-companion", state: active ? "indexing" : "ready", uptimeSeconds: Math.floor((Date.now() - started) / 1000), fixtureMode: options.fixtureMode };
        return json(response, 200, status);
      }
      if (url.pathname === "/v1/repositories" && method === "GET") return json(response, 200, { repositories: store.listRepositories() });
      if (url.pathname === "/v1/packages" && method === "GET") {
        const packages = store.activePackages(); const dependencies = store.activeDependencies(); linkComposerRevisions(packages, dependencies, store.packageMappings());
        return json(response, 200, { packages, dependencies });
      }
      if (url.pathname === "/v1/package-mappings" && method === "GET") return json(response, 200, { mappings: store.packageMappings() });
      if (url.pathname === "/v1/package-mappings" && method === "POST") {
        const parsed = z.object({ protocolVersion: z.literal(PROTOCOL_VERSION), packageName: z.string().min(1), repositoryId: z.string().min(1), packageRoot: z.string().default("") }).parse(await body(request));
        if (!store.repository(parsed.repositoryId)) return json(response, 404, errorBody("NOT_FOUND", "Mapped repository is not configured"));
        store.setPackageMapping(parsed.packageName, parsed.repositoryId, parsed.packageRoot); return json(response, 201, parsed);
      }
      if (url.pathname.startsWith("/v1/package-mappings/") && method === "DELETE") {
        const packageName = decodeURIComponent(url.pathname.slice("/v1/package-mappings/".length)); return store.removePackageMapping(packageName) ? json(response, 200, { removed: packageName }) : json(response, 404, errorBody("NOT_FOUND", "Package mapping not found"));
      }
      if (url.pathname === "/v1/repositories" && method === "POST") {
        const parsed = RepositoryRequest.parse(await body(request)); const root = await realpath(parsed.root); const info = await stat(path.join(root, ".git")); if (!info) throw new Error("Not a Git repository");
        const remoteUrl = sanitizeRepositoryUrl(parsed.remoteUrl);
        const record = await enrichRepository({ id: parsed.id, root, ...(remoteUrl ? { remoteUrl } : {}), ...(parsed.defaultBranch ? { defaultBranch: parsed.defaultBranch } : {}), ...(parsed.include ? { include: parsed.include } : {}), ...(parsed.exclude ? { exclude: parsed.exclude } : {}) });
        store.upsertRepository(record); indexer.addRepository(record, options.automaticScan !== false); return json(response, 201, record);
      }
      if (url.pathname.startsWith("/v1/repositories/") && method === "DELETE") {
        const id = decodeURIComponent(url.pathname.slice("/v1/repositories/".length)); indexer.removeRepository(id); return store.removeRepository(id) ? json(response, 200, { removed: id }) : json(response, 404, errorBody("NOT_FOUND", "Repository not found"));
      }
      if (url.pathname === "/v1/jobs" && method === "GET") return json(response, 200, { jobs: indexer.statesList(), scanner: indexer.snapshot(), persistedJobs: store.scanJobs(), generations: store.generations() });
      if (url.pathname === "/v1/index" && method === "POST") {
        const parsed = z.object({ protocolVersion: z.literal(PROTOCOL_VERSION), repositoryId: z.string() }).parse(await body(request)); const repository = store.repository(parsed.repositoryId); if (!repository) return json(response, 404, errorBody("NOT_FOUND", "Repository not found"));
        return json(response, 200, await indexer.index(repository));
      }
      if (url.pathname === "/v1/repositories/refresh" && method === "POST") {
        const parsed = z.object({ protocolVersion: z.literal(PROTOCOL_VERSION), repositoryPath: z.string() }).parse(await body(request)); const root = await realpath(parsed.repositoryPath);
        let repository = store.listRepositories().find((item) => item.root === root); if (!repository) { repository = { id: root, root }; store.upsertRepository(repository); indexer.addRepository(repository); }
        const scheduled = indexer.schedule(repository, "manual"); return json(response, 202, { queued: repository.id, jobId: scheduled.jobId, coalesced: scheduled.coalesced });
      }
      if (url.pathname === "/v1/index/cancel" && method === "POST") {
        const parsed = z.object({ protocolVersion: z.literal(PROTOCOL_VERSION), repositoryId: z.string().min(1) }).parse(await body(request));
        return indexer.cancel(parsed.repositoryId) ? json(response, 202, { cancelled: parsed.repositoryId }) : json(response, 404, errorBody("NOT_FOUND", "No queued or running scan exists for this repository"));
      }
      if (url.pathname === "/v1/trace" && method === "POST") {
        const parsed = TraceRequest.parse(await body(request)); const repository = store.listRepositories().find((item) => item.root === parsed.selection.repositoryPath);
        if (!repository) return json(response, 404, errorBody("NOT_FOUND", "Repository is not configured; add or refresh it first"));
        const selection = { ...parsed.selection, revision: { ...parsed.selection.revision, repositoryId: repository.id } };
        let graph = parsed.mode === "impact" && parsed.stage === "overview"
          ? graphs.overview(selection, parsed.limit)
          : await graphs.traceAsync(selection, parsed.mode, parsed.limit, requestAbort.signal);
        if (parsed.mode === "history") {
          const focus = store.activeSymbols().find((symbol) => symbol.id === graph.focusNodeId); if (focus) { await history.analyze(repository.root, focus, AbortSignal.timeout(120_000)); graph = await graphs.traceAsync(selection, parsed.mode, parsed.limit, requestAbort.signal); }
        }
        return json(response, 200, browserAuthenticated && !bearerAuthenticated ? graphWithoutSource(graph) : graph);
      }
      if (url.pathname === "/v1/lenses/counts" && method === "POST") {
        const parsed = CodeLensCountsRequestSchema.parse(await body(request));
        return json(response, 200, await lensCounts.count(parsed, requestAbort.signal));
      }
      if (url.pathname === "/v1/trace/compare" && method === "POST") {
        const parsed = TemporalGraphComparisonRequestSchema.parse(await body(request));
        const comparison = await temporalGraphs.compare(parsed, AbortSignal.timeout(120_000));
        return json(response, 200, browserAuthenticated && !bearerAuthenticated ? comparisonWithoutSource(comparison) : comparison);
      }
      if (url.pathname === "/v1/graph/expand" && method === "POST") {
        const parsed = z.object({ protocolVersion: z.literal(PROTOCOL_VERSION), queryId: z.string(), nodeId: z.string(), direction: z.enum(["in", "out", "both"]) }).parse(await body(request)); const expanded = graphs.expand(parsed.queryId, parsed.nodeId, parsed.direction); return json(response, 200, browserAuthenticated && !bearerAuthenticated ? graphWithoutSource(expanded) : expanded);
      }
      if (url.pathname === "/v1/graph/explore" && method === "POST") {
        const parsed = z.object({ protocolVersion: z.literal(PROTOCOL_VERSION), queryId: z.string().min(1), nodeId: z.string().min(1), stage: z.enum(["overview", "complete"]).optional() }).parse(await body(request));
        const result = await exploration.explore(parsed.queryId, parsed.nodeId, requestAbort.signal, parsed.stage === "overview");
        return json(response, 200, browserAuthenticated && !bearerAuthenticated ? graphWithoutSource(result) : result);
      }
      if (url.pathname === "/v1/graph/details" && method === "POST") {
        const parsed = z.object({ protocolVersion: z.literal(PROTOCOL_VERSION), queryId: z.string().min(1), itemId: z.string().min(1) }).parse(await body(request));
        return json(response, 200, await exploration.details(parsed.queryId, parsed.itemId));
      }
      if (url.pathname === "/v1/graph/compatibility" && method === "POST") {
        const parsed = z.object({ protocolVersion: z.literal(PROTOCOL_VERSION), queryId: z.string().min(1), itemId: z.string().min(1), targetRef: z.string().min(1).max(200).regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/).optional() }).parse(await body(request));
        return json(response, 200, await exploration.compatibility(parsed.queryId, parsed.itemId, parsed.targetRef));
      }
      if (url.pathname === "/v1/method-impact" && method === "POST") {
        const parsed = z.object({ protocolVersion: z.literal(PROTOCOL_VERSION), queryId: z.string().min(1), itemId: z.string().min(1), methodName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(), targetRef: z.string().min(1).max(200).regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/).optional(), localSignature: z.string().min(1).max(4000).optional(), workingTree: z.boolean().optional(), phpVersion: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/).optional(), includeHistory: z.boolean().optional() }).parse(await body(request));
        response.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        const emit = (value: unknown) => { if (!response.destroyed) response.write(`${JSON.stringify(value)}\n`); };
        try { await methodImpact.analyze(parsed, requestAbort.signal, (result) => emit({ type: "result", result })); }
        catch (error) { emit({ type: "error", message: error instanceof Error ? error.message : "Method analysis failed" }); }
        response.end(); return;
      }
      if (url.pathname === "/v1/history" && method === "POST") {
        const parsed = z.object({ protocolVersion: z.literal(PROTOCOL_VERSION), symbolId: z.string(), queryId: z.string().optional() }).parse(await body(request)); const symbol = (parsed.queryId ? graphs.query(parsed.queryId).symbols : store.activeSymbols()).find((item) => item.id === parsed.symbolId); if (!symbol) return json(response, 404, errorBody("NOT_FOUND", "Symbol not found")); const repository = store.repository(symbol.repositoryId); if (!repository) return json(response, 404, errorBody("NOT_FOUND", "Repository not found")); const events = await history.analyze(repository.root, symbol, AbortSignal.timeout(120_000)); return json(response, 200, { events: browserAuthenticated && !bearerAuthenticated ? events.map(historyWithoutSource) : events });
      }
      if (url.pathname === "/v1/inclusion" && method === "POST") {
        const parsed = z.object({ protocolVersion: z.literal(PROTOCOL_VERSION), symbolId: z.string().min(1), commit: z.string().min(1), queryId: z.string().optional() }).parse(await body(request));
        const symbols = parsed.queryId ? graphs.query(parsed.queryId).symbols : store.activeSymbols();
        const symbol = symbols.find((item) => item.id === parsed.symbolId);
        if (!symbol) return json(response, 404, errorBody("NOT_FOUND", "Symbol not found"));
        const repository = store.repository(symbol.repositoryId);
        if (!repository) return json(response, 404, errorBody("NOT_FOUND", "Repository not found"));
        const packages = store.activePackages(); const activeDependencies = store.activeDependencies(); linkComposerRevisions(packages, activeDependencies, store.packageMappings());
        const sourcePackage = packages.filter((item) => item.repositoryId === symbol.repositoryId && (!item.rootPath || symbol.path === item.rootPath || symbol.path.startsWith(`${item.rootPath.replace(/\/$/, "")}/`))).sort((left, right) => right.rootPath.length - left.rootPath.length)[0];
        if (!sourcePackage) return json(response, 409, errorBody("CONFLICT", "The symbol repository has no indexed Composer package identity"));
        const dependencies = activeDependencies.filter((item) => item.packageName === sourcePackage.name && item.indexedRepositoryId === sourcePackage.repositoryId);
        const git = new GitRepository(repository.root);
        const releases = await git.tagsContaining(parsed.commit);
        const allTags = await git.tagsWithRevisions(); const assessedTags = allTags.slice(0, 500);
        const assessmentByBasis = new Map<string, ReturnType<HistoryService["assessInclusion"]>>();
        const assess = (basisCommit: string) => {
          const existing = assessmentByBasis.get(basisCommit); if (existing) return existing;
          const pending = history.assessInclusion(repository.root, parsed.commit, basisCommit, { signal: AbortSignal.timeout(120_000), repositoryId: symbol.repositoryId }); assessmentByBasis.set(basisCommit, pending); return pending;
        };
        const releaseAssessments = [];
        for (const tag of assessedTags) {
          const assessment = await assess(tag.revision);
          if (["contains-original", "likely-equivalent"].includes(assessment.state)) releaseAssessments.push({ release: tag.tag, revision: tag.revision, ...assessment });
        }
        const consumers = await Promise.all(dependencies.map(async (dependency) => {
          const lockedBasis = dependency.resolvedSourceCommit ?? (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(dependency.resolvedDistReference ?? "") ? dependency.resolvedDistReference : undefined);
          const assessment = lockedBasis
            ? await assess(lockedBasis)
            : { state: "unknown" as const, activeBehaviour: "unknown" as const, basisCommit: "unavailable", evidence: [], limitations: ["No exact locked source revision was available"] };
          const consumerCommit = symbols.find((item) => item.repositoryId === dependency.repositoryId)?.commit ?? "unknown";
          return {
            consumerRepositoryId: dependency.repositoryId,
            packageName: dependency.packageName,
            ...(dependency.declaredConstraint ? { declaredConstraint: dependency.declaredConstraint } : {}),
            ...(dependency.declaredConstraintBase ? { declaredConstraintBase: dependency.declaredConstraintBase } : {}),
            ...(dependency.declaredAlias ? { declaredAlias: dependency.declaredAlias } : {}),
            ...(dependency.resolvedVersion ? { resolvedVersion: dependency.resolvedVersion } : {}),
            ...(dependency.resolvedSourceReference ? { resolvedSourceReference: dependency.resolvedSourceReference } : {}),
            ...(dependency.resolvedSourceUrl ? { resolvedSourceUrl: dependency.resolvedSourceUrl } : {}),
            ...(dependency.resolvedDistReference ? { resolvedDistReference: dependency.resolvedDistReference } : {}),
            ...(dependency.resolvedDistUrl ? { resolvedDistUrl: dependency.resolvedDistUrl } : {}),
            ...(dependency.resolvedPath ? { resolvedPath: dependency.resolvedPath } : {}),
            ...(dependency.resolvedSourceCommit ? { resolvedSourceCommit: dependency.resolvedSourceCommit } : {}),
            ...(dependency.indexedRepositoryId ? { indexedRepositoryId: dependency.indexedRepositoryId } : {}),
            ...(dependency.indexedRevision ? { indexedRevision: dependency.indexedRevision } : {}),
            ...(dependency.resolutionMethod ? { resolutionMethod: dependency.resolutionMethod } : {}), resolutionEvidence: dependency.resolutionEvidence ?? [],
            ...(lockedBasis === sourcePackage.sourceCommit ? { indexedSourceCommit: sourcePackage.sourceCommit } : {}),
            selectedChangeCommit: parsed.commit,
            ...assessment,
            reason: assessment.state === "contains-original" ? `The original commit is included and its matching patch is ${assessment.activeBehaviour}.` : assessment.state === "likely-equivalent" ? `A different reachable commit has a stable equivalent patch; active behaviour is ${assessment.activeBehaviour}.` : assessment.state === "does-not-contain-original" ? "Neither the original commit nor an equivalent patch was found within the bounded exact-revision history." : "The exact revision or sufficient patch history was unavailable.",
            evidence: [...assessment.evidence, { repositoryId: dependency.repositoryId, commit: consumerCommit, resolutionMethod: dependency.resolvedSourceCommit ? "composer-lock-source-basis" : lockedBasis ? "composer-lock-dist-basis" : "composer-lock-basis", confidence: lockedBasis ? "confirmed" as const : "unresolved" as const, detail: dependency.resolvedSourceCommit ? `Consumer lock selects exact source revision ${dependency.resolvedSourceCommit}` : lockedBasis ? `Consumer path lock selects exact distribution reference ${lockedBasis}` : "No exact locked source revision was available", limitations: ["A lock file is not deployment proof"] }],
          };
        }));
        const githubAssociations: { pullRequests: any[]; releases: any[]; limitations: string[] } = { pullRequests: [], releases: [], limitations: [] };
        const githubRepository = parseGitHubRepository(repository.remoteUrl ?? sourcePackage.repositoryUrl);
        const githubToken = await credentials.getGitHubToken();
        if (!githubToken) githubAssociations.limitations.push("GitHub associations were not queried because no GitHub token is configured");
        else if (!githubRepository) githubAssociations.limitations.push("GitHub associations were not queried because the source repository URL is not a normalized GitHub repository");
        else {
          const client = new GitHubClient(githubToken, options.githubApiBase);
          const associationSignal = AbortSignal.timeout(30_000);
          try {
            const associated = await client.pullRequestsForCommit(githubRepository, parsed.commit, associationSignal);
            githubAssociations.pullRequests.push(...associated.pullRequests.map((pullRequest) => ({
              repository: githubRepository.fullName, repositoryUrl: githubRepository.url, commit: parsed.commit, ...pullRequest,
              confidence: "confirmed", evidence: [{ repositoryId: symbol.repositoryId, commit: parsed.commit, resolutionMethod: "github-commit-pulls-api", confidence: "confirmed", detail: `GitHub associates commit ${parsed.commit} with pull request #${pullRequest.number}`, limitations: ["Commit association does not by itself prove that the pull request was merged"] }], limitations: [],
            })));
            if (associated.truncated) githubAssociations.limitations.push("GitHub pull-request associations were bounded to 2 pages and 50 results");
          } catch (error) {
            githubAssociations.limitations.push(`GitHub pull-request association was unavailable: ${error instanceof Error ? error.message : String(error)}`);
          }
          const releaseLimit = 25;
          const releaseCandidates = releaseAssessments.slice(0, releaseLimit);
          for (let offset = 0; offset < releaseCandidates.length; offset += 5) {
            await Promise.all(releaseCandidates.slice(offset, offset + 5).map(async (assessment) => {
              try {
                const associated = await client.releaseForTag(githubRepository, assessment.release, associationSignal);
                if (associated) githubAssociations.releases.push({
                  repository: githubRepository.fullName, repositoryUrl: githubRepository.url, tagName: assessment.release, tagCommit: assessment.revision, ...associated,
                  confidence: "possible", evidence: [{ repositoryId: symbol.repositoryId, commit: assessment.revision, resolutionMethod: "github-exact-tag-release-api", confidence: "possible", detail: `GitHub exposes release metadata for the same tag name ${assessment.release}; the local tag resolves to ${assessment.revision}`, limitations: ["The remote tag object was not resolved, so equality with the exact local tag commit is not proven", "Release publication is remote metadata and does not prove deployment"] }], limitations: ["Same-name GitHub release association; remote tag commit was not independently verified"],
                });
              } catch (error) { githubAssociations.limitations.push(`GitHub release association for ${assessment.release} was unavailable: ${error instanceof Error ? error.message : String(error)}`); }
            }));
            if (associationSignal.aborted) break;
          }
          if (releaseAssessments.length > releaseLimit) githubAssociations.limitations.push(`GitHub release association was bounded to ${releaseLimit} exact tags`);
          if (associationSignal.aborted) githubAssociations.limitations.push("GitHub association enrichment reached its 30 second overall budget; local inclusion evidence remains complete");
          githubAssociations.limitations = [...new Set(githubAssociations.limitations)];
        }
        return json(response, 200, { protocolVersion: PROTOCOL_VERSION, symbolId: symbol.id, commit: parsed.commit, releases, releaseAssessments, consumers, githubAssociations, limitations: ["Consumer state reflects indexed lock files, not production deployment", ...(allTags.length > assessedTags.length ? ["Release assessment was bounded to 500 tags"] : [])] });
      }
      if (url.pathname === "/v1/source" && method === "GET") {
        if (browserAuthenticated && !bearerAuthenticated) return json(response, 403, errorBody("UNAUTHORIZED", "Source text is not exposed to browser sessions; use the indexed path and range in VS Code"));
        const repositoryId = url.searchParams.get("repositoryId") ?? ""; const relativePath = url.searchParams.get("path") ?? ""; const commit = url.searchParams.get("commit"); const repository = store.repository(repositoryId); if (!repository) return json(response, 404, errorBody("NOT_FOUND", "Repository not found"));
        if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) return json(response, 400, errorBody("INVALID_REQUEST", "Source path must remain within the repository"));
        const source = commit ? await new GitRepository(repository.root).show(commit, relativePath) : await readFile(path.join(repository.root, relativePath), "utf8"); if (source === undefined) return json(response, 404, errorBody("NOT_FOUND", "Source revision not found")); return json(response, 200, { repositoryId, path: relativePath, commit: commit ?? null, source });
      }
      if (url.pathname === "/v1/credentials/github" && method === "PUT") { const parsed = z.object({ protocolVersion: z.literal(PROTOCOL_VERSION), token: z.string().min(1) }).parse(await body(request)); await credentials.setGitHubToken(parsed.token); return json(response, 200, { configured: true }); }
      if (url.pathname === "/v1/github/discover" && method === "POST") { const parsed = z.object({ protocolVersion: z.literal(PROTOCOL_VERSION), organisation: z.string().min(1) }).parse(await body(request)); const githubToken = await credentials.getGitHubToken(); if (!githubToken) return json(response, 409, errorBody("CONFLICT", "GitHub credentials are not configured")); return json(response, 200, { repositories: await new GitHubClient(githubToken).listOrganisationRepositories(parsed.organisation, AbortSignal.timeout(60_000)) }); }
      return json(response, 404, errorBody("NOT_FOUND", "Route not found"));
    } catch (error) {
      if (error instanceof z.ZodError) return json(response, 400, errorBody("INVALID_REQUEST", "Request validation failed", error.issues));
      if (error instanceof LensRevisionError) return json(response, 409, errorBody("CONFLICT", error.message, error.details));
      if (error instanceof TemporalRevisionError) return json(response, 404, errorBody("NOT_FOUND", error.message, error.details));
      if (error instanceof ScannerBackpressureError) return json(response, 429, errorBody("CONFLICT", error.message, { capacity: error.capacity }));
      if (error instanceof Error && error.name === "AbortError") return response.destroyed ? undefined : json(response, 499, errorBody("CANCELLED", "Request cancelled"));
      return json(response, 500, errorBody("INTERNAL", error instanceof Error ? error.message : "Internal error"));
    }
  });
  const configuredRepositories = store.listRepositories().filter((repository) => !repository.automatic && (!repository.remoteUrl || !repository.defaultBranch));
  if (options.automaticScan !== false) indexer.start(store.listRepositories());
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.host, () => { server.off("error", reject); resolve(); }); });
  // Metadata discovery must not hold browser authentication or health behind Git I/O.
  void Promise.all(configuredRepositories.map(async (repository) => {
    try { store.upsertRepository(await enrichRepository(repository)); }
    catch { /* A missing or unavailable worktree must not prevent the companion starting. */ }
  }));
  const address = server.address();
  const activePort = typeof address === "object" && address ? address.port : options.port;
  return { close: async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await indexer.close(); store.close(); }, url: `http://${options.host}:${activePort}`, tokenPath, store };
}
