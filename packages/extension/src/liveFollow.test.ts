import assert from "node:assert/strict";
import test from "node:test";
import { canFollowEditor, LiveFollowScheduler } from "./liveFollow";

test("live follow is limited to visible Trace panels and local PHP workspace files", () => {
  const supported = { enabled: true, panelVisible: true, languageId: "php", scheme: "file", inWorkspace: true };
  assert.equal(canFollowEditor(supported), true);
  assert.equal(canFollowEditor({ ...supported, enabled: false }), false);
  assert.equal(canFollowEditor({ ...supported, panelVisible: false }), false);
  assert.equal(canFollowEditor({ ...supported, languageId: "typescript" }), false);
  assert.equal(canFollowEditor({ ...supported, scheme: "trace-history" }), false);
  assert.equal(canFollowEditor({ ...supported, inWorkspace: false }), false);
});

test("live follow coalesces rapid cursor moves and can be cancelled", async () => {
  const scheduler = new LiveFollowScheduler();
  const runs: string[] = [];
  scheduler.schedule(15, () => runs.push("first"));
  scheduler.schedule(15, () => runs.push("latest"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(runs, ["latest"]);

  scheduler.schedule(15, () => runs.push("cancelled"));
  scheduler.cancel();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(runs, ["latest"]);
  scheduler.dispose();
});
