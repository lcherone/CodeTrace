import assert from "node:assert/strict";
import test from "node:test";
import { pastedClientToken } from "./clientToken.js";

test("clipboard token accepts surrounding whitespace, invisible markers, quotes, and bearer prefix", () => {
  for (const value of ["local_trace-token", "\ufeff local_trace-token\n", "\u200blocal_trace-token\u200e", "Bearer local_trace-token", "“local_trace-token”"]) {
    assert.equal(pastedClientToken(value), "local_trace-token");
    assert.doesNotThrow(() => new Headers({ Authorization: `Bearer ${pastedClientToken(value)}` }));
  }
});

test("invalid clipboard content is rejected without echoing the credential or constructing headers", () => {
  for (const value of ["secret…", "secret\u200btoken", "secret\r\nAuthorization: other", "🔑 secret", "Connect to Trace"]) {
    assert.throws(() => pastedClientToken(value), (error: unknown) => error instanceof Error && error.message.includes("Copy the complete token again") && !error.message.includes(value));
  }
  assert.throws(() => pastedClientToken("\u200b \n"), /Paste the local Trace client token/);
});
