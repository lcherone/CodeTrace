import {
  ChangeInclusionResponseSchema,
  CodeLensCountsRequestSchema,
  CodeLensCountsResponseSchema,
  ErrorResponseSchema,
  GraphResponseSchema,
  IndexStateSchema,
  PROTOCOL_VERSION,
  TemporalGraphComparisonResponseSchema,
  type CompanionStatus,
  type ChangeInclusionResponse,
  type CodeLensCountsRequest,
  type CodeLensCountsResponse,
  type GraphResponse,
  type IndexState,
  type Selection,
  type RepositoryRevisionMap,
  type TemporalGraphComparisonResponse,
} from "@trace/contracts";
import * as vscode from "vscode";
import { z } from "zod";
import type { TraceMode } from "./messages";
import { buildTemporalComparisonRequest } from "./comparison";

const TOKEN_KEY = "trace.companionClientToken";
const QueuedRepositorySchema = z.object({ queued: z.string().min(1) });
const RepositoryListSchema = z.object({ repositories: z.array(z.object({
  id: z.string().min(1),
  root: z.string().min(1),
  activeGeneration: z.number().int().positive().optional(),
}).passthrough()) });
const JobsSchema = z.object({ jobs: z.array(IndexStateSchema) }).passthrough();
export type CompanionRepository = z.infer<typeof RepositoryListSchema>["repositories"][number];

export class CompanionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CompanionError";
  }
}

function companionUrl(): URL {
  const configured = vscode.workspace.getConfiguration("trace").get<string>("companionUrl", "http://127.0.0.1:47173");
  const url = new URL(configured);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new CompanionError("Trace only connects to a loopback HTTP companion.", "INVALID_COMPANION_URL");
  }
  return url;
}

export class CompanionClient {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async setToken(): Promise<boolean> {
    const token = await vscode.window.showInputBox({
      title: "Trace companion client token",
      prompt: "Paste the local client token printed by the companion",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => value.trim().length < 20 ? "The token is unexpectedly short" : undefined,
    });
    if (!token) return false;
    await this.secrets.store(TOKEN_KEY, token.trim());
    return true;
  }

  async status(signal?: AbortSignal): Promise<CompanionStatus> {
    return this.request<CompanionStatus>("/v1/status", { method: "GET" }, signal, false);
  }

  async trace(selection: Selection, mode: TraceMode, signal?: AbortSignal): Promise<GraphResponse> {
    const raw = await this.request<unknown>("/v1/trace", {
      method: "POST",
      body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, mode, selection }),
    }, signal);
    const result = GraphResponseSchema.safeParse(raw);
    if (!result.success) throw new CompanionError("The companion returned an invalid graph response.", "INVALID_RESPONSE");
    const maxNodes = vscode.workspace.getConfiguration("trace").get<number>("maxGraphNodes", 180);
    if (result.data.nodes.length > maxNodes) {
      throw new CompanionError(`Graph has ${result.data.nodes.length} nodes; the configured limit is ${maxNodes}.`, "GRAPH_TOO_LARGE");
    }
    return result.data;
  }

  async lensCounts(request: CodeLensCountsRequest, signal?: AbortSignal): Promise<CodeLensCountsResponse> {
    const body = CodeLensCountsRequestSchema.parse(request);
    const raw = await this.request<unknown>("/v1/lenses/counts", { method: "POST", body: JSON.stringify(body) }, signal);
    const result = CodeLensCountsResponseSchema.safeParse(raw);
    if (!result.success) throw new CompanionError("The companion returned invalid CodeLens counts.", "INVALID_RESPONSE");
    return result.data;
  }

  async compare(
    selection: Selection,
    mode: TraceMode,
    beforeRevisions: RepositoryRevisionMap,
    afterRevisions: RepositoryRevisionMap,
    signal?: AbortSignal,
  ): Promise<TemporalGraphComparisonResponse> {
    const limit = vscode.workspace.getConfiguration("trace").get<number>("maxGraphNodes", 180);
    const request = buildTemporalComparisonRequest(selection, mode, beforeRevisions, afterRevisions, limit);
    const raw = await this.request<unknown>("/v1/trace/compare", { method: "POST", body: JSON.stringify(request) }, signal);
    const result = TemporalGraphComparisonResponseSchema.safeParse(raw);
    if (!result.success) throw new CompanionError("The companion returned an invalid temporal comparison.", "INVALID_RESPONSE");
    if (result.data.before.nodes.length > limit || result.data.after.nodes.length > limit) {
      throw new CompanionError(`Comparison exceeds the configured ${limit}-node limit.`, "GRAPH_TOO_LARGE");
    }
    return result.data;
  }

  async expand(queryId: string, nodeId: string, direction: "in" | "out" | "both", signal?: AbortSignal): Promise<GraphResponse> {
    const raw = await this.request<unknown>("/v1/graph/expand", {
      method: "POST",
      body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, queryId, nodeId, direction }),
    }, signal);
    return GraphResponseSchema.parse(raw);
  }

  async refresh(repositoryPath: string, signal?: AbortSignal): Promise<{ queued: string }> {
    const raw = await this.request<unknown>("/v1/repositories/refresh", {
      method: "POST",
      body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, repositoryPath }),
    }, signal);
    return QueuedRepositorySchema.parse(raw);
  }

  async jobs(signal?: AbortSignal): Promise<IndexState[]> {
    const raw = await this.request<unknown>("/v1/jobs", { method: "GET" }, signal);
    return JobsSchema.parse(raw).jobs;
  }

  async scanSnapshot(signal?: AbortSignal): Promise<Array<{ root: string; repositoryId: string; state: "ready" | "running" | "queued" | "failed" | "cancelled" }>> {
    const [repositories, jobs] = await Promise.all([this.repositories(signal), this.jobs(signal)]);
    const jobsByRepository = new Map(jobs.map((job) => [job.repositoryId, job.state]));
    return repositories.map((repository) => ({
      root: repository.root,
      repositoryId: repository.id,
      state: jobsByRepository.get(repository.id) ?? (repository.activeGeneration ? "ready" : "failed"),
    }));
  }

  async repositories(signal?: AbortSignal): Promise<CompanionRepository[]> {
    const raw = await this.request<unknown>("/v1/repositories", { method: "GET" }, signal);
    return RepositoryListSchema.parse(raw).repositories;
  }

  async source(repositoryId: string, path: string, commit: string, signal?: AbortSignal): Promise<{ repositoryId: string; path: string; commit: string | null; source: string }> {
    const query = new URLSearchParams({ repositoryId, path, commit });
    const raw = await this.request<unknown>(`/v1/source?${query.toString()}`, { method: "GET" }, signal);
    return z.object({ repositoryId: z.string(), path: z.string(), commit: z.string().nullable(), source: z.string() }).parse(raw);
  }

  async inclusion(symbolId: string, commit: string, signal?: AbortSignal): Promise<ChangeInclusionResponse> {
    const raw = await this.request<unknown>("/v1/inclusion", {
      method: "POST",
      body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, symbolId, commit }),
    }, signal);
    return ChangeInclusionResponseSchema.parse(raw);
  }

  dashboardUrl(): vscode.Uri {
    return vscode.Uri.parse(new URL("/", companionUrl()).toString());
  }

  private async request<T>(path: string, init: RequestInit, outerSignal?: AbortSignal, requireToken = true): Promise<T> {
    const token = requireToken ? await this.secrets.get(TOKEN_KEY) : undefined;
    if (requireToken && !token) throw new CompanionError("Set the companion client token before tracing.", "TOKEN_REQUIRED");
    const timeoutMs = vscode.workspace.getConfiguration("trace").get<number>("requestTimeoutMs", 30_000);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("X-Trace-Protocol", PROTOCOL_VERSION);
    if (init.body) headers.set("Content-Type", "application/json");
    if (token) headers.set("Authorization", `Bearer ${token}`);

    let response: Response;
    try {
      response = await fetch(new URL(path, companionUrl()), { ...init, headers, signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw new CompanionError("Trace request was cancelled.", "CANCELLED");
      throw new CompanionError(`Cannot reach the Trace companion: ${error instanceof Error ? error.message : String(error)}`, "OFFLINE");
    }
    const body: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined);
    if (!response.ok) {
      const parsed = ErrorResponseSchema.safeParse(body);
      throw new CompanionError(parsed.success ? parsed.data.error.message : `Companion request failed (${response.status}).`, parsed.success ? parsed.data.error.code : "HTTP_ERROR", response.status);
    }
    return body as T;
  }
}
