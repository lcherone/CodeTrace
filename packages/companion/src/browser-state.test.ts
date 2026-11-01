import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSessionBroker, EditorContextHub } from "./browser-state.js";

test("browser launch tickets are short-lived, single-use, and exchange for HttpOnly sessions", () => {
  const broker = new BrowserSessionBroker(1_000, 10_000);
  const launch = broker.launch("http://127.0.0.1:47173", 1_000);
  const ticket = new URL(launch.url).searchParams.get("ticket"); assert.ok(ticket);
  const exchanged = broker.exchange(ticket, 1_100); assert.ok(exchanged);
  assert.match(exchanged.cookie, /^trace_browser_session=/);
  assert.match(exchanged.cookie, /HttpOnly/);
  assert.match(exchanged.cookie, /SameSite=Strict/);
  assert.equal(broker.authenticate(exchanged.cookie, 1_200), true);
  assert.equal(broker.exchange(ticket, 1_300), undefined);
  const expiring = new URL(broker.launch("http://127.0.0.1:47173", 2_000).url).searchParams.get("ticket"); assert.ok(expiring);
  assert.equal(broker.exchange(expiring, 3_001), undefined);
  assert.equal(broker.authenticate(exchanged.cookie, 11_101), false);
});

test("editor context long polls resolve on update and cancel without leaking stale client clears", async () => {
  const hub = new EditorContextHub();
  const selection = { repositoryPath: "/repo", relativePath: "src/Order.php", revision: { repositoryId: "repo", commit: "a".repeat(40), dirty: true }, range: { startLine: 5, startColumn: 2, endLine: 5, endColumn: 2 } };
  const waiting = hub.poll(0, 2_000);
  setImmediate(() => hub.publish("window-1", { selection, mode: "impact", theme: "dark" }, 7));
  const updated = await waiting;
  assert.equal(updated.version, 1); assert.equal(updated.context?.generation, 7); assert.equal(updated.context?.selection.revision.dirty, true);
  const staleClear = hub.publish("window-old", null); assert.equal(staleClear.version, 1); assert.equal(staleClear.context?.clientId, "window-1");
  const controller = new AbortController(); const cancelled = hub.poll(1, 2_000, controller.signal); controller.abort();
  await assert.rejects(cancelled, (error: unknown) => error instanceof Error && error.name === "AbortError");
  const cleared = hub.publish("window-1", null); assert.equal(cleared.version, 2); assert.equal(cleared.context, null);
});
