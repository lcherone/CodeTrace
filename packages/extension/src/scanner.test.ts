import assert from "node:assert/strict";
import test from "node:test";
import type { IndexState } from "@trace/contracts";
import { ScanCoordinator, type ScanSummary } from "./scanner";

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const readyJob = (repositoryId: string): IndexState => ({ repositoryId, state: "ready", generation: 1, completedFiles: 10, totalFiles: 10, indexedCommit: "abc123" });

test("workspace discovery is coalesced and already-published repositories are not requeued", async () => {
  let discoveries = 0;
  const enqueued: string[] = [];
  const coordinator = new ScanCoordinator({
    discover: async () => { discoveries++; return { roots: ["/work/catalog", "/work/shared", "/work/shared"], truncated: false }; },
    snapshot: async () => [{ root: "/work/catalog", repositoryId: "catalog", state: "ready" }],
    enqueue: async (root) => { enqueued.push(root); return { queued: root }; },
    jobs: async () => [readyJob("/work/shared")],
    errorCode: () => undefined,
    onSummary: () => undefined,
    pollIntervalMs: 2,
  });

  coordinator.scheduleDiscovery(5);
  coordinator.scheduleDiscovery(5);
  await wait(30);
  assert.equal(discoveries, 1);
  assert.deepEqual(enqueued, ["/work/shared"]);
  coordinator.dispose();
});

test("index progress is bucketed and reaches a terminal ready state", async () => {
  const summaries: ScanSummary[] = [];
  let poll = 0;
  const coordinator = new ScanCoordinator({
    discover: async () => ({ roots: [], truncated: false }),
    snapshot: async () => [],
    enqueue: async () => ({ queued: "catalog" }),
    jobs: async () => {
      poll++;
      if (poll === 1) return [{ ...readyJob("catalog"), state: "running", completedFiles: 1, totalFiles: 100 }];
      if (poll === 2) return [{ ...readyJob("catalog"), state: "running", completedFiles: 2, totalFiles: 100 }];
      return [readyJob("catalog")];
    },
    errorCode: () => undefined,
    onSummary: (summary) => summaries.push(summary),
    pollIntervalMs: 3,
  });

  coordinator.requestRepository("/work/catalog");
  await wait(35);
  assert.equal(summaries.some((summary) => summary.phase === "indexing"), true);
  assert.equal(summaries.at(-1)?.phase, "ready");
  assert.equal(summaries.filter((summary) => summary.phase === "indexing").length, 1, "1% and 2% share a 5% progress bucket");
  coordinator.dispose();
});

test("a save during indexing schedules one follow-up generation", async () => {
  let enqueues = 0;
  let polls = 0;
  const coordinator = new ScanCoordinator({
    discover: async () => ({ roots: [], truncated: false }),
    snapshot: async () => [],
    enqueue: async () => ({ queued: `catalog-${++enqueues}` }),
    jobs: async () => [readyJob(`catalog-${++polls}`)],
    errorCode: () => undefined,
    onSummary: () => undefined,
    pollIntervalMs: 3,
  });

  coordinator.requestRepository("/work/catalog");
  await wait(2);
  coordinator.requestRepository("/work/catalog", true);
  await wait(35);
  assert.equal(enqueues, 2);
  coordinator.dispose();
});

test("authentication failures pause without a hot retry and resume explicitly", async () => {
  const summaries: ScanSummary[] = [];
  let authenticated = false;
  let enqueues = 0;
  const coordinator = new ScanCoordinator({
    discover: async () => ({ roots: [], truncated: false }),
    snapshot: async () => {
      if (!authenticated) throw Object.assign(new Error("token required"), { code: "TOKEN_REQUIRED" });
      return [];
    },
    enqueue: async () => { enqueues++; return { queued: "catalog" }; },
    jobs: async () => [readyJob("catalog")],
    errorCode: (error) => error && typeof error === "object" && "code" in error ? String(error.code) : undefined,
    onSummary: (summary) => summaries.push(summary),
    pollIntervalMs: 2,
  });

  coordinator.requestRepository("/work/catalog");
  await wait(10);
  assert.equal(summaries.at(-1)?.phase, "paused");
  assert.equal(enqueues, 0);
  authenticated = true;
  coordinator.resume();
  await wait(20);
  assert.equal(enqueues, 1);
  assert.equal(summaries.at(-1)?.phase, "ready");
  coordinator.dispose();
});

test("large discoveries only hand a bounded number of repositories to the companion at once", async () => {
  const enqueued: string[] = [];
  let release = false;
  const coordinator = new ScanCoordinator({
    discover: async () => ({ roots: ["/work/a", "/work/b", "/work/c", "/work/d", "/work/e"], truncated: false }),
    snapshot: async () => [],
    enqueue: async (root) => { enqueued.push(root); return { queued: root }; },
    jobs: async () => enqueued.map((repositoryId) => ({ ...readyJob(repositoryId), state: release ? "ready" : "running" })),
    errorCode: () => undefined,
    onSummary: () => undefined,
    maxConcurrentRepositories: 2,
    pollIntervalMs: 3,
  });

  coordinator.scheduleDiscovery(0);
  await wait(15);
  assert.equal(enqueued.length, 2);
  release = true;
  await wait(35);
  assert.equal(enqueued.length, 5);
  coordinator.dispose();
});
