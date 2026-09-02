import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { listBenchmarkConfigs, previewMatrix } from "../src/dashboard/preview.mjs";

const configDirectory = fileURLToPath(new URL("../configs/", import.meta.url));
const targets = {
  aws: { enabled: true, profile: "dynamodb_poc", region: "us-east-1", resource: "aws-table" },
  adb: { enabled: true, profile: "OCI_BENCHMARK", region: "us-ashburn-1", resource: "adb-ocid/table" },
  ndcs: { enabled: true, profile: "OCI_BENCHMARK", region: "us-ashburn-1", resource: "nosql-table" },
};

test("dashboard lists only valid benchmark workload configurations", () => {
  const configs = listBenchmarkConfigs(configDirectory);
  assert.ok(configs.length >= 10);
  assert.ok(configs.some(config => config.file === "smoke.json" && config.durationSeconds === 2));
  assert.equal(configs.some(config => config.file === "report-suite.example.json"), false);
  assert.equal(configs.filter(config => config.file.startsWith("dallas-1000-")).length, 4);
});

test("dashboard previews the complete Dallas matrix with three repetitions", () => {
  const configs = ["dallas-1000-strong-read.json", "dallas-1000-mixed-70-30.json", "dallas-1000-mixed-50-50.json", "dallas-1000-write.json"];
  const preview = previewMatrix({ configs, targets, repetitions: 3, infrastructure: { mode: "existing" } }, { configDirectory });
  assert.equal(preview.rows.length, 12);
  assert.equal(preview.rows.every(row => row.durationSeconds === 1080), true);
  assert.equal(preview.totals.totalScheduledOperations, 14823000);
  assert.equal(preview.totals.totalDatabaseMinutes, 648);
});

test("dashboard preview makes five-minute operation accounting explicit", () => {
  const preview = previewMatrix({ configs: ["x4-mixed-70-30-open-loop.json"], targets, repetitions: 1, infrastructure: { mode: "existing" } }, { configDirectory });
  assert.equal(preview.rows[0].durationSeconds, 300);
  assert.equal(preview.rows[0].scheduledOperationsPerTarget, 96000);
  assert.equal(preview.rows[0].scheduledOperationsPerTarget / preview.rows[0].durationSeconds, 320);
  assert.equal(preview.rows[0].averageScheduledOperationsPerSecond, 320);
  assert.equal(preview.rows[0].averageScheduledOperationsPerMinute, 19200);
  assert.equal(preview.totals.totalScheduledOperations, 288000);
  assert.equal(preview.totals.totalDatabaseMinutes, 15);
});

test("dashboard preview validates resources and applies consistency override", () => {
  const eventual = previewMatrix({ configs: ["x4-mixed-70-30-open-loop.json"], targets, repetitions: 1, infrastructure: { mode: "existing" }, overrides: { consistency: "eventual" } }, { configDirectory });
  assert.equal(eventual.rows[0].consistency, "eventual");
  const inferredMix = previewMatrix({ configs: ["x4-mixed-70-30-open-loop.json"], targets, repetitions: 1, infrastructure: { mode: "existing" }, overrides: { readPercent: 80 } }, { configDirectory });
  assert.equal(inferredMix.rows[0].writePercent, 20);
  const incomplete = structuredClone(targets); incomplete.aws.resource = "";
  assert.throws(() => previewMatrix({ configs: ["x4-mixed-70-30-open-loop.json"], targets: incomplete, infrastructure: { mode: "existing" } }, { configDirectory }), /aws requires an existing/);
});

test("dashboard preview applies repetitions independently per preset", () => {
  const preview = previewMatrix({
    configs: ["x4-mixed-70-30-open-loop.json", "x4-read-fixed-concurrency.json"],
    presetRepetitions: { "x4-mixed-70-30-open-loop.json": 2, "x4-read-fixed-concurrency.json": 3 },
    targets,
    infrastructure: { mode: "existing" },
  }, { configDirectory });
  assert.equal(preview.rows.filter(row => row.configFile === "x4-mixed-70-30-open-loop.json").length, 2);
  assert.equal(preview.rows.filter(row => row.configFile === "x4-read-fixed-concurrency.json").length, 3);
  assert.equal(preview.rows.length, 5);
});

test("dashboard applies model-specific overrides only to compatible profiles", () => {
  const preview = previewMatrix({ configs: ["x4-mixed-70-30-open-loop.json", "x4-read-fixed-concurrency.json"], targets, repetitions: 1, infrastructure: { mode: "existing" }, overrides: { executionMode: "sequential", rateMultiplier: 2, fixedConcurrency: 7 } }, { configDirectory });
  const open = preview.rows.find(row => row.loadModel === "open-loop");
  const closed = preview.rows.find(row => row.loadModel === "closed-loop");
  assert.deepEqual(open.ignoredOverrides, ["fixedConcurrency"]);
  assert.equal(open.executionMode, "sequential");
  assert.deepEqual(closed.ignoredOverrides, ["executionMode", "rateMultiplier"]);
  assert.equal(closed.fixedConcurrency, 7);
  assert.equal(preview.warnings.length, 2);
});

test("dashboard applies independent editable values to each selected preset", () => {
  const preview = previewMatrix({
    configs: ["x4-mixed-70-30-open-loop.json", "x4-read-fixed-concurrency.json"],
    targets,
    infrastructure: { mode: "existing" },
    presetOverrides: {
      "x4-mixed-70-30-open-loop.json": { readPercent: 60, writePercent: 40, writeMode: "idempotent", consistency: "eventual", durationSeconds: 120, rateMultiplier: 0.5 },
      "x4-read-fixed-concurrency.json": { readPercent: 80, writePercent: 20, writeMode: "idempotent", consistency: "strong", durationSeconds: 90, fixedConcurrency: 12 }
    }
  }, { configDirectory });
  const open = preview.rows.find(row => row.loadModel === "open-loop"), closed = preview.rows.find(row => row.loadModel === "closed-loop");
  assert.equal(open.readPercent, 60); assert.equal(open.writePercent, 40); assert.equal(open.consistency, "eventual"); assert.equal(open.durationSeconds, 120); assert.equal(open.averageScheduledOperationsPerSecond, 160);
  assert.equal(closed.readPercent, 80); assert.equal(closed.writePercent, 20); assert.equal(closed.durationSeconds, 90); assert.equal(closed.fixedConcurrency, 12);
  assert.equal(open.effectiveOverrides.writeMode, "idempotent"); assert.equal(closed.effectiveOverrides.fixedConcurrency, 12);
});
