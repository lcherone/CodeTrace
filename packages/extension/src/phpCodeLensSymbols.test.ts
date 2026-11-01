import assert from "node:assert/strict";
import test from "node:test";
import { parsePhpCodeLensSymbols } from "./phpCodeLensSymbols";

test("extracts PHP type and member ranges when no document-symbol provider is available", () => {
  const symbols = parsePhpCodeLensSymbols(`<?php
namespace Example;

interface Priced { public function price(): int; }

final class Order implements Priced
{
    public function price(): int
    {
        return 1;
    }
}

function helper(): void {}
`);
  assert.deepEqual(symbols.map(({ name }) => name), ["Priced", "price", "Order", "price", "helper"]);
  assert.deepEqual(symbols.find(({ name, range }) => name === "Order" && range.startLine === 5)?.range, {
    startLine: 5,
    startColumn: 0,
    endLine: 11,
    endColumn: 1,
  });
  assert.equal(symbols.find(({ name, range }) => name === "price" && range.startLine === 7)?.selection.line, 7);
});

test("returns no fallback symbols for syntactically invalid PHP", () => {
  assert.deepEqual(parsePhpCodeLensSymbols("<?php final class {"), []);
});
