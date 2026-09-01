import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runClosedLoop } from "../src/core/closed-loop.mjs";

test("fixed closed-loop execution keeps the configured worker concurrency and accounts for every attempt", async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-closed-loop-"));
  const config = {
    schemaVersion: 1, name: "closed-loop-fixture",
    dataset: { keyCount: 20, payloadBytes: 1, partitionBuckets: 2, seed: 7, distribution: "uniform" },
    workload: { readPercent: 100, writePercent: 0, consistency: "strong" },
    load: { model: "closed-loop", fixedConcurrency: 3, durationSeconds: 0.05, telemetryIntervalMs: 2 },
    client: { maxConnections: 3, requestTimeoutMs: 100, connectionTimeoutMs: 100, maxAttempts: 1 },
  };
  let active = 0, peak = 0;
  const provider = { read: async () => { active += 1; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active -= 1; return { attempts: 1, readUnits: 1 }; } };
  const summary = await runClosedLoop({ config, configSha256: "fixture", provider, target: "mock", table: "mock", output, startAt: new Date(Date.now() + 200).toISOString() });
  const records = fs.readFileSync(path.join(output, "operations.ndjson"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
  assert.ok(summary.attempted > 3); assert.equal(summary.attempted, records.length); assert.equal(summary.accounted, records.length); assert.equal(summary.schedulerDrops, 0);
  assert.equal(summary.concurrency.targetConcurrency, 3); assert.equal(summary.concurrency.observedAtOperationStart.max, 3); assert.equal(peak, 3);
  assert.equal(new Set(records.map(record => record.sequence)).size, records.length); assert.equal(summary.harnessPassed, true);
});
