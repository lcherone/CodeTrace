import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionOutboundMessageSchema, parseWebviewMessage } from "./messages";

test("accepts bounded navigation messages", () => {
  assert.deepEqual(parseWebviewMessage({ type: "openEvidence", edgeId: "e1", evidenceIndex: 0 }), {
    type: "openEvidence",
    edgeId: "e1",
    evidenceIndex: 0,
  });
  assert.deepEqual(parseWebviewMessage({ type: "checkInclusion", eventId: "history-1" }), {
    type: "checkInclusion",
    eventId: "history-1",
  });
  assert.deepEqual(parseWebviewMessage({ type: "openGitHub", url: "https://github.com/acme/commerce/pull/42" }), {
    type: "openGitHub",
    url: "https://github.com/acme/commerce/pull/42",
  });
  const commit = "a".repeat(40);
  assert.deepEqual(parseWebviewMessage({ type: "compare", beforeRevisions: { client: commit }, afterRevisions: { client: "b".repeat(40) } }), {
    type: "compare",
    beforeRevisions: { client: commit },
    afterRevisions: { client: "b".repeat(40) },
  });
});

test("rejects unknown commands and malformed identifiers", () => {
  assert.equal(parseWebviewMessage({ type: "runShell", command: "rm" }), undefined);
  assert.equal(parseWebviewMessage({ type: "openSource", nodeId: "" }), undefined);
  assert.equal(parseWebviewMessage({ type: "compare", beforeRevisions: { client: "main" }, afterRevisions: { client: "head" } }), undefined);
  assert.equal(parseWebviewMessage({ type: "openGitHub", url: "https://github.com.evil.example/acme/commerce" }), undefined);
  assert.equal(parseWebviewMessage({ type: "openGitHub", url: "http://github.com/acme/commerce" }), undefined);
});

test("validates separate release inclusion and active behaviour assessments", () => {
  const commit = "a".repeat(40);
  const parsed = ExtensionOutboundMessageSchema.parse({
    type: "inclusion",
    eventId: "history-1",
    result: {
      protocolVersion: "1.0",
      symbolId: "symbol-1",
      commit,
      releases: ["v2.0.0"],
      releaseAssessments: [{
        release: "v2.0.0",
        revision: commit,
        state: "contains-original",
        activeBehaviour: "reverted",
        basisCommit: commit,
        revertCommit: "b".repeat(40),
        evidence: [],
        limitations: [],
      }],
      consumers: [],
      limitations: [],
    },
  });
  assert.equal(parsed.type, "inclusion");
  if (parsed.type === "inclusion") {
    assert.equal(parsed.result.releaseAssessments[0]?.activeBehaviour, "reverted");
    assert.equal(parsed.result.releaseAssessments[0]?.state, "contains-original");
  }
});
