#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { PROTOCOL_VERSION } from "@trace/contracts";
import { startServer } from "./server.js";

const host = process.env.TRACE_HOST ?? "127.0.0.1";
const port = Number(process.env.TRACE_PORT ?? "47173");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("TRACE_PORT must be a valid TCP port");
const dataDirectory = process.env.TRACE_DATA_DIR ?? path.join(os.homedir(), ".trace");
const fixtureMode = process.env.TRACE_FIXTURE_MODE === "1";
const numeric = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
};
const companion = await startServer({
  host,
  port,
  dataDirectory,
  fixtureMode,
  automaticScan: process.env.TRACE_AUTO_SCAN !== "0",
  scanner: {
    repositoryConcurrency: numeric("TRACE_REPOSITORY_CONCURRENCY", 2),
    analysisConcurrency: numeric("TRACE_ANALYSIS_CONCURRENCY", 8),
    maxQueue: numeric("TRACE_MAX_QUEUE", 512),
    watchFileSystem: process.env.TRACE_WATCH !== "0",
  },
});
console.log(`Trace companion listening at ${companion.url}`);
console.log(`Client token file: ${companion.tokenPath}`);
console.log("The token itself is intentionally not written to logs.");
if (fixtureMode) await configureFixtures(companion.url, companion.tokenPath);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, async () => { await companion.close(); process.exit(0); });

async function configureFixtures(url: string, tokenPath: string): Promise<void> {
  const fixtureRoot = process.env.TRACE_FIXTURE_ROOT ?? path.resolve(process.cwd(), "packages/fixtures/generated");
  try {
    const manifest = JSON.parse(await readFile(path.join(fixtureRoot, "fixture-manifest.json"), "utf8")) as { repositories?: Array<{ id: string; path: string }> };
    const token = (await readFile(tokenPath, "utf8")).trim();
    const headers = { Authorization: `Bearer ${token}`, "X-Trace-Protocol": PROTOCOL_VERSION, "Content-Type": "application/json" };
    for (const repository of manifest.repositories ?? []) {
      const configured = await fetch(new URL("/v1/repositories", url), { method: "POST", headers, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, id: repository.id, root: repository.path }) });
      if (!configured.ok) throw new Error(`Could not configure fixture repository ${repository.id}: ${configured.status}`);
      const indexed = await fetch(new URL("/v1/index", url), { method: "POST", headers, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, repositoryId: repository.id }) });
      if (!indexed.ok) throw new Error(`Could not index fixture repository ${repository.id}: ${indexed.status}`);
    }
    console.log(`Fixture mode indexed ${(manifest.repositories ?? []).length} repositories from ${fixtureRoot}`);
  } catch (error) {
    console.warn(`Fixture mode is active but automatic setup was unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
