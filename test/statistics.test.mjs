import assert from "node:assert/strict";
import test from "node:test";
import { distribution } from "../src/core/statistics.mjs";

test("distribution handles closed-loop sized sample arrays without overflowing the stack", () => {
  const values = Array.from({ length: 500_000 }, (_, index) => index % 10_000 / 10);
  const result = distribution(values);

  assert.equal(result.samples, 500_000);
  assert.equal(result.max, 999.9);
  assert.equal(result.p50, 499.9);
  assert.equal(result.p90, 899.9);
  assert.equal(result.p99, 989.9);
});
