import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { GitHubApiError, GitHubClient, parseGitHubRepository } from "./github.js";

test("normalizes GitHub repository identity across SSH and HTTPS forms", () => {
  assert.deepEqual(parseGitHubRepository("git@github.com:Acme/Shared.git"), { owner: "acme", name: "shared", fullName: "acme/shared", url: "https://github.com/acme/shared" });
  assert.deepEqual(parseGitHubRepository("https://github.com/ACME/SHARED/"), { owner: "acme", name: "shared", fullName: "acme/shared", url: "https://github.com/acme/shared" });
  assert.equal(parseGitHubRepository("https://git.example.test/acme/shared"), undefined);
});

test("bounds commit pull-request lookup and distinguishes exact releases, absence, and API failure", async () => {
  let pullRequestsCalls = 0;
  const server = createServer((request, response) => {
    if (request.url?.includes("/commits/") && request.url.includes("/pulls")) {
      pullRequestsCalls++;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({
        number: (pullRequestsCalls - 1) * 100 + index + 1,
        html_url: `https://github.com/acme/shared/pull/${index + 1}`,
        title: `PR ${index + 1}`,
        state: "closed",
        merged_at: "2025-01-01T00:00:00Z",
        head: { sha: "b".repeat(40), repo: { full_name: "fork/shared", html_url: "https://github.com/fork/shared" } },
      }))));
      return;
    }
    if (request.url?.endsWith("/releases/tags/v1.0.0")) {
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ html_url: "https://github.com/acme/shared/releases/tag/v1.0.0", name: "One", published_at: "2025-01-01T00:00:00Z", draft: false, prerelease: true, target_commitish: "main" })); return;
    }
    if (request.url?.endsWith("/releases/tags/missing")) { response.writeHead(404); response.end(); return; }
    response.writeHead(503); response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const client = new GitHubClient("token", `http://127.0.0.1:${address.port}`);
  const repository = parseGitHubRepository("https://github.com/acme/shared"); assert.ok(repository);
  try {
    const pulls = await client.pullRequestsForCommit(repository, "a".repeat(40), undefined, 2, 150);
    assert.equal(pulls.pullRequests.length, 150); assert.equal(pulls.truncated, true); assert.equal(pullRequestsCalls, 2);
    assert.equal(pulls.pullRequests[0]?.headRepository, "fork/shared");
    const release = await client.releaseForTag(repository, "v1.0.0");
    assert.equal(release?.prerelease, true); assert.equal(release?.targetCommitish, "main");
    assert.equal(await client.releaseForTag(repository, "missing"), undefined);
    await assert.rejects(client.releaseForTag(repository, "failure"), (error: unknown) => error instanceof GitHubApiError && error.status === 503);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
