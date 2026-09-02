import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { preloadDataset } from "../src/core/dataset.mjs";

test("preload captures synchronized timing, throughput, latency, attempts, and units", async t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-preload-"));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const config = { name: "preload-test", dataset: { keyCount: 4, payloadBytes: 8, partitionBuckets: 2 } };
  const startAt = new Date(Date.now() + 30).toISOString();
  const provider = { write: async () => ({ writeUnits: 1, attempts: 1 }) };
  const summary = await preloadDataset({ config, configSha256: "c".repeat(64), provider, target: "aws", table: "table", output, rate: 1000, maxInflight: 2, startAt });
  assert.equal(summary.scheduledStartAt, startAt);
  assert.ok(Math.abs(summary.startSkewMs) < 100);
  assert.equal(summary.requested, 4);
  assert.equal(summary.completed, 4);
  assert.equal(summary.failures, 0);
  assert.equal(summary.attempts, 4);
  assert.equal(summary.retryCount, 0);
  assert.equal(summary.writeUnits, 4);
  assert.ok(summary.durationMs >= 0);
  assert.ok(summary.attemptedOperationsPerSecond > 0);
  assert.ok(summary.successfulOperationsPerSecond > 0);
  assert.equal(summary.latencyMs.samples, 4);
  assert.ok(Object.hasOwn(summary.latencyMs, "p90"));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, "preload-summary.json"), "utf8")), summary);
});

test("preload shards cover the canonical dataset exactly once", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-preload-shards-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { name: "preload-shards", dataset: { keyCount: 10, payloadBytes: 8, partitionBuckets: 3 } };
  const written = [];
  for (let shardIndex = 0; shardIndex < 3; shardIndex += 1) {
    const provider = { write: async key => { written.push(`${key.pk}/${key.sk}`); return { writeUnits: 1, attempts: 1 }; } };
    const summary = await preloadDataset({ config, configSha256: "d".repeat(64), provider, target: "aws", table: "table", output: path.join(root, `source-${shardIndex}`), rate: 10_000, maxInflight: 4, shardCount: 3, shardIndex });
    assert.deepEqual(summary.shard, { count: 3, index: shardIndex });
    assert.equal(summary.logicalRequested, 10);
  }
  assert.equal(written.length, 10);
  assert.equal(new Set(written).size, 10);
});
