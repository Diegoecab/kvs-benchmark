import test from "node:test";
import assert from "node:assert/strict";
import { readConfig, scheduledOperationCount, validateConfig } from "../src/core/config.mjs";
import { canonicalRecord, expectedDatasetSha256 } from "../src/core/dataset.mjs";

test("certified x1 profile schedules 72,000 operations", () => {
  const { config } = readConfig(new URL("../configs/x1-read-open-loop.json", import.meta.url));
  assert.equal(scheduledOperationCount(config), 72000);
});

test("x4 profile schedules 288,000 operations", () => {
  const { config } = readConfig(new URL("../configs/x4-read-open-loop.json", import.meta.url));
  assert.equal(scheduledOperationCount(config), 288000);
});

test("three-minute E2E profile preserves all five load levels", () => {
  const { config } = readConfig(new URL("../configs/e2e-3m-read-open-loop.json", import.meta.url));
  assert.equal(scheduledOperationCount(config), 14400);
  assert.deepEqual(config.load.schedule.map(step => step.operationsPerSecond), [25, 50, 100, 150, 75]);
  assert.equal(config.load.schedule.reduce((sum, step) => sum + step.seconds, 0), 180);
});

test("eventual profiles preserve the workload and halve normalized read capacity", () => {
  const strong = readConfig(new URL("../configs/x1-read-open-loop.json", import.meta.url)).config;
  const eventual = readConfig(new URL("../configs/x1-read-eventual-open-loop.json", import.meta.url)).config;
  assert.equal(eventual.workload.consistency, "eventual");
  assert.deepEqual(eventual.load.schedule, strong.load.schedule);
  assert.equal(eventual.capacity.awsDynamodb.readCapacityUnits, strong.capacity.awsDynamodb.readCapacityUnits / 2);
  assert.equal(eventual.capacity.ociNosql.readUnits, strong.capacity.ociNosql.readUnits / 2);
});

test("invalid workload mix is rejected", () => {
  const config = structuredClone(readConfig(new URL("../configs/smoke.json", import.meta.url)).config);
  config.workload.writePercent = 1;
  assert.throws(() => validateConfig(config), /must equal 100/);
});

test("canonical dataset hash is deterministic and content-sensitive", () => {
  const config = readConfig(new URL("../configs/smoke.json", import.meta.url)).config;
  assert.equal(expectedDatasetSha256(config), expectedDatasetSha256(config));
  assert.deepEqual(Object.keys(canonicalRecord(config, 0)).sort(), ["payload", "pk", "sk", "version"]);
  const changed = structuredClone(config); changed.dataset.payloadBytes += 1;
  assert.notEqual(expectedDatasetSha256(config), expectedDatasetSha256(changed));
});
