import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedGitHubUrl } from "./externalLinks";

test("allows exact HTTPS GitHub links", () => {
  assert.equal(isAllowedGitHubUrl("https://github.com/acme/commerce/pull/42"), true);
  assert.equal(isAllowedGitHubUrl("https://github.com/acme/commerce/releases/tag/v2.4.0"), true);
});

test("rejects non-HTTPS, credentialed, port and lookalike GitHub links", () => {
  assert.equal(isAllowedGitHubUrl("http://github.com/acme/commerce/pull/42"), false);
  assert.equal(isAllowedGitHubUrl("https://github.com.evil.example/acme/commerce"), false);
  assert.equal(isAllowedGitHubUrl("https://evil.example/?next=https://github.com/acme/commerce"), false);
  assert.equal(isAllowedGitHubUrl("https://user@github.com/acme/commerce"), false);
  assert.equal(isAllowedGitHubUrl("https://github.com:444/acme/commerce"), false);
});
