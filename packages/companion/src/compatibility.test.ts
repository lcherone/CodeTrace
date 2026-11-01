import assert from "node:assert/strict";
import test from "node:test";
import { assessOverride } from "./compatibility.js";
import { parsePhp } from "./php.js";

const method = (signature: string) => parsePhp(`<?php class Example { ${signature} }`, "Example.php").types[0]!.methods[0]!;
test("installed and proposed scalar contracts are assessed independently", () => {
  const child = method("public function total(): string { return 'ok'; }");
  assert.equal(assessOverride(child, method("public function total(): string { return 'old'; }")).state, "no-signature-incompatibility");
  assert.equal(assessOverride(child, method("public function total(): bool { return true; }")).state, "incompatible");
});
test("native contract checks distinguish variance, optionality, references, finality, and named arguments", () => {
  const parent = method("public function total(int $value = 1): int|string { return 1; }");
  assert.equal(assessOverride(method("public function total(int|string $value = 1): int { return 1; }"), parent).state, "no-signature-incompatibility");
  assert.equal(assessOverride(method("public function total(int $value): int { return 1; }"), parent).state, "incompatible");
  assert.equal(assessOverride(method("protected function total(int &$value = 1): int { return 1; }"), parent).state, "incompatible");
  assert.equal(assessOverride(method("public function total(int $renamed = 1): int { return 1; }"), parent).state, "review");
  assert.equal(assessOverride(method("public function total(): int { return 1; }"), method("final public function total(): int { return 1; }")).state, "incompatible");
  assert.equal(assessOverride(method("public function total(): ChildType { return new ChildType(); }"), method("public function total(): ParentType { return new ParentType(); }")).state, "unknown");
  assert.equal(assessOverride(method("public function __construct(string $name) {}"), method("public function __construct(int $id) {}")).state, "review");
});
test("nominal and composite variance uses hierarchy evidence and the configured PHP version", () => {
  const hierarchy = (left: string, right: string) => left.toLowerCase() === right.toLowerCase() || left.toLowerCase() === "childtype" && right.toLowerCase() === "parenttype";
  assert.equal(assessOverride(method("public function total(ParentType $x): ChildType {}"), method("public function total(ChildType $x): ParentType {}"), { phpVersion: "8.2", isSubtype: hierarchy }).state, "no-signature-incompatibility");
  assert.equal(assessOverride(method("public function total(): A&B {}"), method("public function total(): A {}"), { phpVersion: "8.2", isSubtype: hierarchy }).state, "no-signature-incompatibility");
  assert.equal(assessOverride(method("public function total(): A {}"), method("public function total(): A&B {}"), { phpVersion: "8.2", isSubtype: hierarchy }).state, "incompatible");
  assert.equal(assessOverride(method("public function total(): (A&B)|C {}"), method("public function total(): A|C {}"), { phpVersion: "8.2", isSubtype: hierarchy }).state, "no-signature-incompatibility");
  assert.equal(assessOverride(method("public function total(): int|string {}"), method("public function total(): int|string {}"), { phpVersion: "7.4" }).state, "incompatible");
  assert.equal(assessOverride(method("public function &total(): int {}"), method("public function total(): int {}"), { phpVersion: "8.2" }).state, "no-signature-incompatibility");
  assert.equal(assessOverride(method("public function total(): int {}"), method("public function &total(): int {}"), { phpVersion: "8.2" }).state, "incompatible");
});
