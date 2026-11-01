import {
  BrowserLaunchResponseSchema,
  ErrorResponseSchema,
  IndexStateSchema,
  EditorContextResponseSchema,
  EditorContextUpdateRequestSchema,
  PROTOCOL_VERSION,
  type CompanionStatus,
  type EditorContextResponse,
  type EditorContextUpdateRequest,
  type IndexState,
} from "@trace/contracts";
import * as vscode from "vscode";
import { z } from "zod";

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

  async hasToken(): Promise<boolean> {
    return Boolean(await this.secrets.get(TOKEN_KEY));
  }

  async updateEditorContext(request: EditorContextUpdateRequest, signal?: AbortSignal): Promise<EditorContextResponse> {
    const body = EditorContextUpdateRequestSchema.parse(request);
    const raw = await this.request<unknown>("/v1/editor-context", { method: "POST", body: JSON.stringify(body) }, signal);
    return EditorContextResponseSchema.parse(raw);
  }

  async browserLaunch(signal?: AbortSignal): Promise<vscode.Uri> {
    const raw = await this.request<unknown>("/v1/browser-launch", {
      method: "POST",
      body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION }),
    }, signal);
    const response = BrowserLaunchResponseSchema.parse(raw);
    const launch = new URL(response.url);
    const companion = companionUrl();
    if (launch.protocol !== "http:" || launch.origin !== companion.origin || !["127.0.0.1", "localhost", "[::1]"].includes(launch.hostname)) {
      throw new CompanionError("The companion returned an unsafe browser launch URL.", "INVALID_RESPONSE");
    }
    return vscode.Uri.parse(launch.toString(), true);
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
