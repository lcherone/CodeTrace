import assert from "node:assert/strict";
import test from "node:test";
import { receiverAnalysisFromMetadata, receiverPrecisionMessage, type ReceiverAnalysisPresentation } from "./receiverPresentation";

const analysis = (overrides: Partial<ReceiverAnalysisPresentation> = {}): ReceiverAnalysisPresentation => ({
  id: "call-1",
  status: "resolved",
  expression: "$this->gateway->charge()",
  methodName: "charge",
  candidateTypes: ["Client\\PaymentGateway"],
  resolutionMethod: "native-property",
  confidence: "confirmed",
  range: { startLine: 18, startColumn: 8, endLine: 18, endColumn: 32 },
  limitations: [],
  ...overrides,
});

test("parses structured receiver analysis and identifies a proven precise candidate", () => {
  const parsed = receiverAnalysisFromMetadata({ receiverAnalysis: [analysis()] });
  assert.equal(parsed.length, 1);
  assert.equal(receiverPrecisionMessage(parsed[0]!), "Precise receiver candidate: Client\\PaymentGateway");
});

test("never claims a precise target for ambiguous or runtime-driven receivers", () => {
  for (const entry of [
    analysis({ status: "ambiguous", candidateTypes: ["A", "B"], confidence: "possible", resolutionMethod: "branch-merge" }),
    analysis({ status: "unresolved", candidateTypes: [], confidence: "unresolved", resolutionMethod: "container-lookup" }),
    analysis({ status: "dynamic", candidateTypes: [], confidence: "unresolved", resolutionMethod: "dynamic-method" }),
    analysis({ status: "unresolved", candidateTypes: [], confidence: "unresolved", resolutionMethod: "reflection" }),
    analysis({ status: "unresolved", candidateTypes: [], confidence: "unresolved", resolutionMethod: "magic-call" }),
  ]) assert.equal(receiverPrecisionMessage(entry), "No precise target was claimed.");
});

test("drops malformed receiver diagnostics instead of rendering untrusted shapes", () => {
  assert.deepEqual(receiverAnalysisFromMetadata({ receiverAnalysis: [{ id: "bad", status: "invented" }] }), []);
});
