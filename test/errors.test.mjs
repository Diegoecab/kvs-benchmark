import test from "node:test";
import assert from "node:assert/strict";
import { errorEvidence } from "../src/core/errors.mjs";
import { isThrottle } from "../src/report/analyze.mjs";

test("captures HTTP and request metadata", () => {
  const error = Object.assign(new SyntaxError("Unexpected token"), { $metadata: { httpStatusCode: 502, requestId: "request-1", attempts: 1 } });
  assert.deepEqual({ ...errorEvidence(error), stack: null }, { name: "SyntaxError", message: "Unexpected token", httpStatusCode: 502, requestId: "request-1", attempts: 1, totalRetryDelayMs: null, fault: null, retryable: null, stack: null });
});

test("classifies provider capacity-limit responses without mislabeling transition errors", () => {
  assert.equal(isThrottle({ error: "READ_LIMIT_EXCEEDED" }), true);
  assert.equal(isThrottle({ error: "ProvisionedThroughputExceededException" }), true);
  assert.equal(isThrottle({ error: { name: "AnyError", httpStatusCode: 429 } }), true);
  assert.equal(isThrottle({ error: "ResourceInUseException" }), false);
  assert.equal(isThrottle({ error: "SyntaxError" }), false);
});
