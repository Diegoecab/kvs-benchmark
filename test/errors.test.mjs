import test from "node:test";
import assert from "node:assert/strict";
import { errorEvidence } from "../src/core/errors.mjs";

test("captures HTTP and request metadata", () => {
  const error = Object.assign(new SyntaxError("Unexpected token"), { $metadata: { httpStatusCode: 502, requestId: "request-1", attempts: 1 } });
  assert.deepEqual({ ...errorEvidence(error), stack: null }, { name: "SyntaxError", message: "Unexpected token", httpStatusCode: 502, requestId: "request-1", attempts: 1, totalRetryDelayMs: null, fault: null, retryable: null, stack: null });
});

