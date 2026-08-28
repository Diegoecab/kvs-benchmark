import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOpenLoop } from "../src/core/open-loop.mjs";

const config = {
  schemaVersion: 1, name: "acceptance-fixture",
  dataset: { keyCount: 1, payloadBytes: 1, partitionBuckets: 1, seed: 1, distribution: "uniform" },
  workload: { readPercent: 100, writePercent: 0, consistency: "strong" },
  load: { model: "open-loop", schedule: [{ seconds: 0.02, operationsPerSecond: 50 }], maxInflight: 2, telemetryIntervalMs: 5 },
  client: { maxConnections: 1, requestTimeoutMs: 100, connectionTimeoutMs: 100, maxAttempts: 1 },
};

test("open-loop summary fails closed when any scheduled operation fails", async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-open-loop-fail-"));
  const provider = { read: async () => { throw Object.assign(new Error("fixture"), { name: "FixtureError" }); } };
  const summary = await runOpenLoop({ config, configSha256: "fixture", provider, target: "mock", table: "mock", output, startAt: new Date(Date.now() + 20).toISOString() });
  assert.equal(summary.scheduled, 1); assert.equal(summary.completed, 0); assert.equal(summary.passed, false); assert.equal(summary.errors.FixtureError, 1);
});

test("open-loop summary passes only with complete error-free execution", async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-open-loop-pass-"));
  const provider = { read: async () => ({ readUnits: 1, attempts: 1 }) };
  const summary = await runOpenLoop({ config, configSha256: "fixture", provider, target: "mock", table: "mock", output, startAt: new Date(Date.now() + 20).toISOString() });
  assert.equal(summary.completed, 1); assert.equal(summary.passed, true);
});
