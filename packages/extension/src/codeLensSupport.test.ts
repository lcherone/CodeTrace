import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_VERSION, type CodeLensCountsResponse } from "@trace/contracts";
import { configuredRepositoryId, DebouncedLensRequests, LensResultCache, lensLabels, RepositoryIdentityCache } from "./codeLensSupport";

const response = (generation: number): CodeLensCountsResponse => ({
  protocolVersion: PROTOCOL_VERSION,
  repository: { repositoryId: "/repo", commit: "a".repeat(40) },
  generation,
  counts: [],
  cache: { hits: 0, misses: 1, rebuilt: true },
});

test("cache is revision scoped, blocks edited documents, and clears across generations", () => {
  const cache = new LensResultCache<string>();
  cache.set("file:///a.php", 1, response(1), "one");
  assert.equal(cache.get("file:///a.php", 1, "/repo", "a".repeat(40)), "one");
  assert.equal(cache.get("file:///a.php", 2, "/repo", "a".repeat(40)), undefined);
  cache.blockDocument("file:///a.php");
  assert.equal(cache.get("file:///a.php", 1, "/repo", "a".repeat(40)), undefined);
  cache.clearValues();
  assert.equal(cache.isBlocked("file:///a.php"), true);
  cache.releaseAfterGenerationChange();
  cache.set("file:///b.php", 1, response(1), "other");
  assert.equal(cache.set("file:///a.php", 2, response(2), "two"), true);
  assert.equal(cache.get("file:///a.php", 2, "/repo", "a".repeat(40)), "two");
  assert.equal(cache.get("file:///b.php", 1, "/repo", "a".repeat(40)), undefined);
});

test("debounce replaces stale work and cancellation prevents the request", async () => {
  const scheduler = new DebouncedLensRequests();
  const first = scheduler.schedule("doc", 20, new AbortController().signal, async () => "first");
  const firstRejected = assert.rejects(first, { name: "AbortError" });
  const second = scheduler.schedule("doc", 0, new AbortController().signal, async () => "second");
  await firstRejected;
  assert.equal(await second, "second");
  const cancelled = new AbortController();
  const pending = scheduler.schedule("other", 20, cancelled.signal, async () => "never");
  cancelled.abort();
  await assert.rejects(pending, { name: "AbortError" });
  let backendAborted = false;
  const active = scheduler.schedule("active", 0, new AbortController().signal, (signal) => new Promise<string>((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      backendAborted = true;
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  scheduler.cancel("active");
  await assert.rejects(active, { name: "AbortError" });
  assert.equal(backendAborted, true);
});

test("labels keep callers separate from package consumers and suppress zero clutter", () => {
  assert.deepEqual(lensLabels({ id: "x", callers: 2, consumers: 1, partial: true, limitations: [] }), [
    { mode: "callers", title: "$(references) 2 callers · partial" },
    { mode: "consumers", title: "$(package) 1 package consumer · partial" },
  ]);
  assert.deepEqual(lensLabels({ id: "x", callers: 0, consumers: 0, partial: false, limitations: [] }), []);
});

test("resolves a configured repository id without assuming it equals the Git root", () => {
  assert.equal(configuredRepositoryId([{ id: "client-store", root: "/work/client" }], "/work/client"), "client-store");
  assert.equal(configuredRepositoryId([{ id: "client-store", root: "/work/client" }], "/work/other"), undefined);
});

test("generation invalidation prevents an old repository lookup from repopulating the same root", async () => {
  const cache = new RepositoryIdentityCache();
  let finishOld!: (id: string) => void;
  const oldLookup = cache.resolve("/work/client", () => new Promise<string>((resolve) => { finishOld = resolve; }));
  cache.clear();
  finishOld("old-client");
  assert.equal(await oldLookup, undefined);
  assert.equal(await cache.resolve("/work/client", async () => "new-client"), "new-client");
  assert.equal(await cache.resolve("/work/client", async () => "unexpected"), "new-client");
});
