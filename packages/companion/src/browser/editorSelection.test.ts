import assert from "node:assert/strict";
import test from "node:test";
import { sameEditorSymbol } from "./editorSelection.js";
import type { EditorContextSelection, SymbolOccurrence } from "@trace/contracts";
test("cursor jitter on a class declaration preserves exploration, moving into another method does not", () => {
  const original: SymbolOccurrence = { id: "class", logical: { kind: "class", fullyQualifiedName: "App\\Customer" }, revision: { repositoryId: "repo", commit: "a".repeat(40), dirty: false }, path: "Customer.php", range: { startLine: 30, startColumn: 0, endLine: 100, endColumn: 1 } };
  const selection: EditorContextSelection = { repositoryPath: "/repo", relativePath: original.path, revision: original.revision, range: { startLine: 30, startColumn: 26, endLine: 30, endColumn: 26 } };
  assert.equal(sameEditorSymbol(selection, original), true);
  assert.equal(sameEditorSymbol({ ...selection, range: { ...selection.range, startLine: 40, endLine: 40 } }, original), false);
  assert.equal(sameEditorSymbol({ ...selection, symbolHint: "App\\Customer::save" }, original), false);
  assert.equal(sameEditorSymbol({ ...selection, revision: { ...selection.revision, commit: "b".repeat(40) } }, original), false);
});
