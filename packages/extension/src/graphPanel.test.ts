import assert from "node:assert/strict";
import test from "node:test";
import { isWithin } from "./paths";

test("source containment rejects sibling-prefix traversal", () => {
  assert.equal(isWithin("/work/client", "/work/client/src/Order.php"), true);
  assert.equal(isWithin("/work/client", "/work/client-old/secret"), false);
  assert.equal(isWithin("/work/client", "/work/package"), false);
});
