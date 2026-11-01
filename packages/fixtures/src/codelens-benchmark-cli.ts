#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  CodeLensBenchmarkError,
  CodeLensTransportError,
  runCodeLensBenchmark,
  validateCodeLensWorkload,
  type CodeLensBenchmarkRequest,
  type CodeLensBenchmarkResponse,
  type CodeLensBenchmarkTransport,
} from "./codelens-benchmark.js";

const PROTOCOL_VERSION = "1.0";

function value(flag: string): string | undefined {
  const index = process.argv.lastIndexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function integer(flag: string): number | undefined {
  const raw = value(flag);
  return raw === undefined ? undefined : Number(raw);
}

function loopbackUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new CodeLensBenchmarkError("invalid-options"); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host)) throw new CodeLensBenchmarkError("invalid-options");
  return url;
}

class HttpTransport implements CodeLensBenchmarkTransport {
  constructor(private readonly endpoint: URL, private readonly token: string) {}

  async query(request: CodeLensBenchmarkRequest, signal: AbortSignal): Promise<CodeLensBenchmarkResponse> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Trace-Protocol": PROTOCOL_VERSION, Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...request }),
        signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new CodeLensTransportError("client");
    }
    if (!response.ok) throw new CodeLensTransportError(response.status === 499 ? "cancelled" : response.status >= 500 ? "server" : "protocol", response.status);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new CodeLensTransportError("protocol"); }
    if (!payload || typeof payload !== "object" || !("counts" in payload) || !Array.isArray(payload.counts) || !("cache" in payload) || !payload.cache || typeof payload.cache !== "object") throw new CodeLensTransportError("protocol");
    const cache = payload.cache as Record<string, unknown>;
    if (!Number.isSafeInteger(cache.hits) || !Number.isSafeInteger(cache.misses) || typeof cache.rebuilt !== "boolean") throw new CodeLensTransportError("protocol");
    return payload as CodeLensBenchmarkResponse;
  }
}

async function main(): Promise<void> {
  const workloadPath = value("--workload");
  const tokenFile = value("--token-file");
  const baseUrl = value("--base-url") ?? "http://127.0.0.1:47173";
  if (!workloadPath || !tokenFile) throw new CodeLensBenchmarkError("invalid-options");
  const endpoint = new URL("/v1/lenses/counts", loopbackUrl(baseUrl));
  let workload: unknown; let token: string;
  try {
    workload = JSON.parse(await readFile(workloadPath, "utf8"));
    token = (await readFile(tokenFile, "utf8")).trim();
  } catch {
    throw new CodeLensBenchmarkError("invalid-options");
  }
  if (!token) throw new CodeLensBenchmarkError("invalid-options");
  validateCodeLensWorkload(workload);
  const report = await runCodeLensBenchmark(workload, new HttpTransport(endpoint, token), {
    ...(integer("--iterations") !== undefined ? { iterations: integer("--iterations")! } : {}),
    ...(integer("--warmup") !== undefined ? { warmup: integer("--warmup")! } : {}),
    ...(integer("--cancellation-attempts") !== undefined ? { cancellationAttempts: integer("--cancellation-attempts")! } : {}),
    ...(integer("--cancel-after-ms") !== undefined ? { cancelAfterMs: integer("--cancel-after-ms")! } : {}),
    thresholds: {
      ...(integer("--cold-p95-ms") !== undefined ? { coldP95Ms: integer("--cold-p95-ms")! } : {}),
      ...(integer("--warm-p95-ms") !== undefined ? { warmP95Ms: integer("--warm-p95-ms")! } : {}),
      ...(integer("--cancellation-p95-ms") !== undefined ? { cancellationP95Ms: integer("--cancellation-p95-ms")! } : {}),
    },
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (process.argv.includes("--enforce-thresholds") && report.assessment.overall !== "passed") process.exitCode = 2;
}

main().catch((error: unknown) => {
  const code = error instanceof CodeLensBenchmarkError ? error.code : error instanceof CodeLensTransportError ? error.category : "benchmark-failed";
  process.stderr.write(`${JSON.stringify({ schemaVersion: 1, tool: "trace-codelens-query-benchmark", outcome: "failed", error: code })}\n`);
  process.exitCode = 1;
});
