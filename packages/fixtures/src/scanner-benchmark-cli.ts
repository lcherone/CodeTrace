#!/usr/bin/env node
import { runScannerBenchmark, ScannerBenchmarkError } from "./scanner-benchmark.js";

function values(flag: string): string[] {
  const results: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && process.argv[index + 1]) results.push(process.argv[index + 1]!);
  }
  return results;
}

function value(flag: string): string | undefined {
  return values(flag).at(-1);
}

function integer(flag: string): number | undefined {
  const raw = value(flag);
  return raw === undefined ? undefined : Number(raw);
}

async function main(): Promise<void> {
  const root = value("--root");
  if (!root) throw new ScannerBenchmarkError("invalid-options");
  const rawSource = value("--source");
  const source = rawSource === undefined || rawSource === "auto" || rawSource === "git-tracked" || rawSource === "composer-installed" ? rawSource : "invalid";
  if (source === "invalid") throw new ScannerBenchmarkError("invalid-options");
  const concurrency = value("--concurrency")?.split(",").map(Number);
  const include = values("--include");
  const exclude = values("--exclude");
  const report = await runScannerBenchmark({
    root,
    ...(source ? { source } : {}),
    ...(concurrency ? { concurrency } : {}),
    ...(integer("--iterations") !== undefined ? { iterations: integer("--iterations")! } : {}),
    ...(integer("--warmup") !== undefined ? { warmup: integer("--warmup")! } : {}),
    ...(integer("--max-file-bytes") !== undefined ? { maxFileBytes: integer("--max-file-bytes")! } : {}),
    ...(include.length ? { include } : {}),
    ...(exclude.length ? { exclude } : {}),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const code = error instanceof ScannerBenchmarkError ? error.code : "benchmark-failed";
  process.stderr.write(`${JSON.stringify({ schemaVersion: 1, tool: "trace-scanner-benchmark", outcome: "failed", error: code })}\n`);
  process.exitCode = 1;
});
