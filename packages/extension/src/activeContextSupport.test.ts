import assert from "node:assert/strict";
import test from "node:test";
import { ActiveContextPublisher, editorContextRequest, editorThemeKind, phpSymbolHint } from "./activeContextSupport";

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("switching editors and rapid cursor moves publishes only the latest context", async () => {
  const published: string[] = [];
  const publisher = new ActiveContextPublisher<string>(async (value) => { published.push(value); });
  publisher.setConnected(true);
  publisher.update(10, async () => "editor-a:4:1");
  publisher.update(10, async () => "editor-b:8:3");
  publisher.update(10, async () => "editor-b:9:2");
  await wait(30);
  assert.deepEqual(published, ["editor-b:9:2"]);
  publisher.dispose();
});

test("a new position cancels in-flight context resolution", async () => {
  const published: string[] = [];
  let firstAborted = false;
  const publisher = new ActiveContextPublisher<string>(async (value) => { published.push(value); });
  publisher.setConnected(true);
  publisher.update(0, (signal) => new Promise((resolve) => {
    signal.addEventListener("abort", () => { firstAborted = true; resolve("stale"); }, { once: true });
  }));
  await wait(5);
  publisher.update(0, async () => "current");
  await wait(15);
  assert.equal(firstAborted, true);
  assert.deepEqual(published, ["current"]);
  publisher.dispose();
});

test("disconnect and disabled follow cancel work and suppress publishing", async () => {
  const published: string[] = [];
  const publisher = new ActiveContextPublisher<string>(async (value) => { published.push(value); });
  publisher.update(0, async () => "offline");
  await wait(5);
  publisher.setConnected(true);
  publisher.setEnabled(false);
  await wait(5);
  assert.deepEqual(published, []);
  publisher.dispose();
});

test("an explicit trace publishes immediately even when automatic follow is disabled", async () => {
  const published: string[] = [];
  const publisher = new ActiveContextPublisher<string>(async (value) => { published.push(value); });
  publisher.setConnected(true);
  publisher.update(50, async () => "stale-follow");
  publisher.setEnabled(false);
  await publisher.publishNow(async () => "explicit-selection");
  await wait(60);
  assert.deepEqual(published, ["explicit-selection"]);
  publisher.dispose();
});

test("editor context contains position metadata and never document source", () => {
  const request = editorContextRequest("vscode-client", {
    repositoryPath: "/work/client",
    repositoryId: "client-store",
    relativePath: "src/Order.php",
    revision: { commit: "a".repeat(40), dirty: true },
    range: { startLine: 14, startColumn: 8, endLine: 14, endColumn: 8 },
    symbolHint: "Soho\\Pos\\Model\\OrderTrait",
  }, "impact", "high-contrast");
  assert.equal(request.context?.selection.revision.repositoryId, "client-store");
  assert.equal(request.context?.theme, "high-contrast");
  assert.equal(request.context?.selection.symbolHint, "Soho\\Pos\\Model\\OrderTrait");
  assert.equal("selectedText" in (request.context?.selection ?? {}), false);
  assert.equal("documentText" in (request.context?.selection ?? {}), false);
  assert.equal("documentVersion" in (request.context?.selection ?? {}), false);
  assert.equal(JSON.stringify(request).includes("<?php"), false);
});

test("symbol hints resolve imported aliases but reject arbitrary selected source", () => {
  const source = `<?php
use Soho\\Pos\\Model\\OrderTrait as SohoPosOrderTrait;
class Order { use SohoPosOrderTrait; }`;
  assert.equal(phpSymbolHint("SohoPosOrderTrait", source), "Soho\\Pos\\Model\\OrderTrait");
  assert.equal(phpSymbolHint("calculateTotal", source), "calculateTotal");
  assert.equal(phpSymbolHint("$this->secret", source), undefined);
  assert.equal(phpSymbolHint("return $secret;", source), undefined);
});

test("maps all VS Code theme variants to the bounded browser theme kinds", () => {
  assert.equal(editorThemeKind(1), "light");
  assert.equal(editorThemeKind(2), "dark");
  assert.equal(editorThemeKind(3), "high-contrast");
  assert.equal(editorThemeKind(4), "high-contrast");
});
