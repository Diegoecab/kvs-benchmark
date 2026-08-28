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

test("open-loop accounts for a recorded service failure without rejecting harness integrity", async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-open-loop-fail-"));
  const provider = { read: async () => { throw Object.assign(new Error("fixture"), { name: "FixtureError" }); } };
  const summary = await runOpenLoop({ config, configSha256: "fixture", provider, target: "mock", table: "mock", output, startAt: new Date(Date.now() + 20).toISOString() });
  assert.equal(summary.scheduled, 1); assert.equal(summary.completed, 0); assert.equal(summary.failed, 1); assert.equal(summary.accounted, 1); assert.equal(summary.harnessPassed, true); assert.equal(summary.passed, true); assert.equal(summary.serviceSuccessRate, 0); assert.equal(summary.errors.FixtureError, 1);
});

test("open-loop summary passes only with complete error-free execution", async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-open-loop-pass-"));
  const provider = { read: async () => ({ readUnits: 1, attempts: 1 }) };
  const summary = await runOpenLoop({ config, configSha256: "fixture", provider, target: "mock", table: "mock", output, startAt: new Date(Date.now() + 20).toISOString() });
  assert.equal(summary.completed, 1); assert.equal(summary.passed, true);
  assert.ok(Date.parse(summary.actualEndAt) >= Date.parse(summary.actualStartAt));
  assert.equal(Date.parse(summary.scheduledEndAt) - Date.parse(summary.scheduledStartAt), 20);
});

test("sequential execution never exceeds one in-flight operation and preserves the configured mix", async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-open-loop-sequential-"));
  const sequential = structuredClone(config);
  sequential.workload = { readPercent: 50, writePercent: 50, consistency: "strong" };
  sequential.load = { model: "open-loop", executionMode: "sequential", schedule: [{ seconds: 0.08, operationsPerSecond: 50 }], maxInflight: 1, telemetryIntervalMs: 2 };
  let active = 0, peak = 0, reads = 0, writes = 0;
  const operation = async kind => { active += 1; peak = Math.max(peak, active); kind === "read" ? reads += 1 : writes += 1; await new Promise(resolve => setTimeout(resolve, 8)); active -= 1; return { attempts: 1 }; };
  const provider = { read: () => operation("read"), write: () => operation("write") };
  const summary = await runOpenLoop({ config: sequential, configSha256: "fixture", provider, target: "mock", table: "mock", output, startAt: new Date(Date.now() + 20).toISOString() });
  assert.equal(summary.scheduled, 4); assert.equal(summary.completed, 4); assert.equal(summary.schedulerDrops, 0);
  assert.equal(summary.workload.executionMode, "sequential"); assert.equal(summary.workload.readPercent, 50); assert.equal(summary.workload.writePercent, 50);
  assert.equal(summary.concurrency.effectiveMaxInflight, 1); assert.equal(summary.concurrency.observedAtOperationStart.max, 1); assert.equal(peak, 1); assert.equal(reads + writes, 4);
});

test("a client scheduler drop rejects harness integrity", async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-open-loop-drop-"));
  const overloaded = structuredClone(config);
  overloaded.load = { model: "open-loop", executionMode: "concurrent", schedule: [{ seconds: 0.04, operationsPerSecond: 50 }], maxInflight: 1, telemetryIntervalMs: 2 };
  const provider = { read: async () => { await new Promise(resolve => setTimeout(resolve, 60)); return { attempts: 1 }; } };
  const summary = await runOpenLoop({ config: overloaded, configSha256: "fixture", provider, target: "mock", table: "mock", output, startAt: new Date(Date.now() + 20).toISOString() });
  assert.equal(summary.scheduled, 2); assert.equal(summary.accounted, 2); assert.equal(summary.schedulerDrops, 1);
  assert.equal(summary.harnessPassed, false); assert.equal(summary.passed, false);
});
