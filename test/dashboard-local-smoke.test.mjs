import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalSmokeRuns } from "../src/dashboard/local-smoke.mjs";

test("local dashboard smoke run executes the real harness and persists evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-dashboard-smoke-"));
  const configFile = path.join(root, "smoke.json");
  fs.writeFileSync(configFile, JSON.stringify({
    schemaVersion: 1,
    name: "dashboard-test-smoke",
    dataset: { keyCount: 10, payloadBytes: 100, partitionBuckets: 2, seed: 1, distribution: "uniform" },
    workload: { readPercent: 100, writePercent: 0, consistency: "strong" },
    load: { model: "open-loop", schedule: [{ seconds: 0.2, operationsPerSecond: 10 }], maxInflight: 4, telemetryIntervalMs: 20 },
    client: { maxConnections: 4, requestTimeoutMs: 1000, connectionTimeoutMs: 1000, maxAttempts: 1 },
  }));
  const runs = new LocalSmokeRuns({ configFile, outputRoot: path.join(root, "runs"), startDelayMs: 20 });
  const started = runs.start({ mode: "async" });
  assert.equal(started.mode, "async");
  assert.equal(started.progress.scheduled, 2);
  let current = started;
  for (let attempt = 0; attempt < 50 && !["complete", "failed"].includes(current.status); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 20));
    current = runs.get(started.id);
  }
  assert.equal(current.status, "complete");
  assert.equal(current.summary.completed, 2);
  assert.equal(current.summary.harnessPassed, true);
  const output = path.join(root, "runs", started.id);
  for (const file of ["operations.ndjson", "telemetry.ndjson", "summary.json", "run-config.json"]) assert.equal(fs.existsSync(path.join(output, file)), true);
  for (const file of ["index.html", "manifest-sha256.json", `${started.id}-benchmark-output.zip`]) assert.equal(fs.existsSync(path.join(output, file)), true);
  assert.match(fs.readFileSync(path.join(output, "index.html"), "utf8"), /KVS local smoke benchmark/);
  assert.equal(fs.readFileSync(runs.download(started.id)).readUInt32LE(0), 0x04034b50);
});
