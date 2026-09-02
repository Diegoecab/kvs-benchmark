import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { summarizeWorkloadStages, writeWorkloadStageSummary } from "../src/dashboard/workload-stages.mjs";

test("workload stage summaries preserve per-ramp accounting, failures, throughput, and latency", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-stages-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const operations = [
    { sequence: 0, step: 1, operation: "read", serviceLatencyMs: 1, error: null },
    { sequence: 1, step: 1, operation: "read", serviceLatencyMs: 3, error: { name: "TimeoutError" } },
    { sequence: 2, step: 2, operation: "write", serviceLatencyMs: 2, error: null },
    { sequence: 3, step: 2, operation: "write", serviceLatencyMs: 4, error: null },
  ];
  fs.writeFileSync(path.join(root, "operations.ndjson"), `${operations.map(item => JSON.stringify(item)).join("\n")}\n`);
  const schedule = [{ seconds: 2, operationsPerSecond: 1 }, { seconds: 1, operationsPerSecond: 2 }];
  const summary = await summarizeWorkloadStages(path.join(root, "operations.ndjson"), schedule);
  assert.equal(summary[0].accounted, 2); assert.equal(summary[0].failed, 1); assert.equal(summary[0].errors.TimeoutError, 1); assert.equal(summary[0].successfulOperationsPerSecond, 0.5); assert.equal(summary[0].successfulServiceLatencyMs.p95, 1);
  assert.equal(summary[1].writes, 2); assert.equal(summary[1].successfulOperationsPerSecond, 2); assert.equal(summary[1].successfulServiceLatencyMs.p99, 2);
  await writeWorkloadStageSummary(root, schedule); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "stage-summary.json"), "utf8")), summary);
});
