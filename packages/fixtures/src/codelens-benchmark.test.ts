import assert from "node:assert/strict";
import test from "node:test";
import {
  CodeLensBenchmarkError,
  runCodeLensBenchmark,
  validateCodeLensWorkload,
  type CodeLensBenchmarkTransport,
  type CodeLensBenchmarkWorkload,
} from "./codelens-benchmark.js";

const privateRepository = "private-customer-repository";
const privateCommit = "0123456789abcdef0123456789abcdef01234567";
const privatePath = "src/PrivateModule/SecretSymbol.php";
const privateSymbol = "Private\\Module\\SecretSymbol::calculate";

const workload: CodeLensBenchmarkWorkload = {
  requests: [{
    repository: { repositoryId: privateRepository, commit: privateCommit },
    items: [{ id: "private-lens-id", path: privatePath, range: { startLine: 12, startColumn: 4, endLine: 12, endColumn: 13 }, symbol: privateSymbol }],
  }],
};

test("reports anonymized cold, warm, and cancellation aggregates", async () => {
  let completedQueries = 0;
  const transport: CodeLensBenchmarkTransport = {
    async query(request, signal) {
      if (!completedQueries && !signal.aborted) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 25);
          signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("cancelled", "AbortError")); }, { once: true });
        });
        if (signal.aborted) throw new DOMException("cancelled", "AbortError");
      }
      const cold = completedQueries === 0;
      completedQueries += 1;
      return {
        counts: request.items.map((item) => ({ id: item.id, callers: 1, consumers: 2, partial: false, limitations: [] })),
        cache: { hits: cold ? 0 : request.items.length, misses: cold ? request.items.length : 0, rebuilt: cold },
      };
    },
  };

  const report = await runCodeLensBenchmark(workload, transport, { iterations: 4, warmup: 1, cancellationAttempts: 2, cancelAfterMs: 1, thresholds: { coldP95Ms: 1_000, warmP95Ms: 100, cancellationP95Ms: 100 } });
  assert.equal(report.samples.total, 4);
  assert.equal(report.samples.cold.observed, 1);
  assert.equal(report.samples.warm.observed, 3);
  assert.equal(report.cache.rebuilds, 1);
  assert.equal(report.cancellation.clientAborted, 2);
  assert.equal(report.cancellation.completedBeforeAbort, 0);
  assert.equal(report.assessment.overall, "passed");
  assert.equal(report.errors.count, 0);

  const output = JSON.stringify(report);
  for (const secret of [privateRepository, privateCommit, privatePath, "PrivateModule", "SecretSymbol", privateSymbol, "private-lens-id"]) {
    assert.equal(output.includes(secret), false, `${secret} must not appear in report`);
  }
});

test("validates revision-qualified bounded workloads without echoing invalid values", () => {
  assert.equal(validateCodeLensWorkload(workload).requests.length, 1);
  assert.throws(
    () => validateCodeLensWorkload({ requests: [{ ...workload.requests[0], items: Array.from({ length: 201 }, (_, index) => ({ ...workload.requests[0]!.items[0], id: `item-${index}` })) }] }),
    (error: unknown) => error instanceof CodeLensBenchmarkError && error.code === "invalid-workload",
  );
  assert.throws(
    () => validateCodeLensWorkload({ requests: [{ ...workload.requests[0], items: [{ ...workload.requests[0]!.items[0], path: "../private.php" }] }] }),
    (error: unknown) => error instanceof CodeLensBenchmarkError && error.code === "invalid-workload",
  );
});
