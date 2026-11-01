import assert from "node:assert/strict";
import test from "node:test";
import { immutableGitHubSource } from "./source-navigation.js";

test("source URLs preserve indexed commits and encode each path segment and line range", () => {
  const commit = "a".repeat(40);
  assert.equal(immutableGitHubSource("git@github.com:Acme/Core.git", commit, "src/Order #1.php", { startLine: 4, startColumn: 0, endLine: 8, endColumn: 1 }), `https://github.com/acme/core/blob/${commit}/src/Order%20%231.php#L4-L8`);
  for (const file of ["../secret", "/absolute", "src/../secret", "src\\file.php"]) assert.equal(immutableGitHubSource("https://github.com/acme/core", commit, file), undefined);
  assert.equal(immutableGitHubSource("https://github.com/acme/core", "main", "A.php"), undefined);
  assert.equal(immutableGitHubSource("https://example.test/acme/core", commit, "A.php"), undefined);
});
