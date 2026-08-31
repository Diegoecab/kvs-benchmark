import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { listBenchmarkConfigs, previewMatrix } from "../src/dashboard/preview.mjs";

const configDirectory = fileURLToPath(new URL("../configs/", import.meta.url));
const targets = {
  aws: { enabled: true, profile: "dynamodb_poc", region: "us-east-1", resource: "aws-table" },
  adb: { enabled: true, profile: "PITWALL_API", region: "us-ashburn-1", resource: "adb-ocid/table" },
  ndcs: { enabled: true, profile: "PITWALL_API", region: "us-ashburn-1", resource: "nosql-table" },
};

test("dashboard lists only valid benchmark workload configurations", () => {
  const configs = listBenchmarkConfigs(configDirectory);
  assert.ok(configs.length >= 10);
  assert.ok(configs.some(config => config.file === "smoke.json" && config.durationSeconds === 2));
  assert.equal(configs.some(config => config.file === "report-suite.example.json"), false);
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
  const incomplete = structuredClone(targets); incomplete.aws.resource = "";
  assert.throws(() => previewMatrix({ configs: ["x4-mixed-70-30-open-loop.json"], targets: incomplete, infrastructure: { mode: "existing" } }, { configDirectory }), /aws requires an existing/);
});
