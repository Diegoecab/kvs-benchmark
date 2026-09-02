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

test("closed-loop assigns stable global worker IDs and unique sequences to each shard", async () => {
  const config = {
    schemaVersion: 1, name: "closed-loop-sharded-fixture",
    dataset: { keyCount: 20, payloadBytes: 1, partitionBuckets: 2, seed: 7, distribution: "uniform" },
    workload: { readPercent: 100, writePercent: 0, consistency: "strong" },
    load: { model: "closed-loop", fixedConcurrency: 4, durationSeconds: 0.04, telemetryIntervalMs: 2 },
    client: { maxConnections: 4, requestTimeoutMs: 100, connectionTimeoutMs: 100, maxAttempts: 1 },
  };
  const outputs = [0, 1].map(index => fs.mkdtempSync(path.join(os.tmpdir(), `kvs-closed-loop-shard-${index}-`)));
  const provider = { read: async () => { await new Promise(resolve => setTimeout(resolve, 4)); return { attempts: 1 }; } };
  const startAt = new Date(Date.now() + 50).toISOString();
  const summaries = await Promise.all(outputs.map((output, shardIndex) => runClosedLoop({ config, configSha256: "fixture", provider, target: "mock", table: "mock", output, startAt, shardCount: 2, shardIndex })));
  const records = outputs.map(output => fs.readFileSync(path.join(output, "operations.ndjson"), "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse));
  assert.deepEqual(summaries.map(summary => summary.shard.workerIds), [[1, 3], [2, 4]]);
  assert.deepEqual(summaries.map(summary => summary.concurrency.targetConcurrency), [2, 2]);
  assert.deepEqual(summaries.map(summary => summary.concurrency.globalTargetConcurrency), [4, 4]);
  assert.deepEqual([...new Set(records[0].map(record => record.workerId))].sort(), [1, 3]);
  assert.deepEqual([...new Set(records[1].map(record => record.workerId))].sort(), [2, 4]);
  const allSequences = records.flat().map(record => record.sequence);
  assert.equal(new Set(allSequences).size, allSequences.length);
  for (const record of records.flat()) assert.equal(record.sequence % 4, record.workerId - 1);
});

test("closed-loop rejects more shards than global workers", async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-closed-loop-invalid-shard-"));
  const config = {
    schemaVersion: 1, name: "closed-loop-invalid-shard-fixture",
    dataset: { keyCount: 1, payloadBytes: 1, partitionBuckets: 1, seed: 1, distribution: "uniform" },
    workload: { readPercent: 100, writePercent: 0, consistency: "strong" },
    load: { model: "closed-loop", fixedConcurrency: 2, durationSeconds: 0.01, telemetryIntervalMs: 2 },
    client: { maxConnections: 2, requestTimeoutMs: 100, connectionTimeoutMs: 100, maxAttempts: 1 },
  };
  await assert.rejects(() => runClosedLoop({ config, configSha256: "fixture", provider: {}, target: "mock", table: "mock", output, shardCount: 3, shardIndex: 0 }), /shardCount cannot exceed fixedConcurrency/);
});
