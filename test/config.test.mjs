import test from "node:test";
import assert from "node:assert/strict";
import { readConfig, scheduledOperationCount, validateConfig } from "../src/core/config.mjs";

test("certified x1 profile schedules 72,000 operations", () => {
  const { config } = readConfig(new URL("../configs/x1-read-open-loop.json", import.meta.url));
  assert.equal(scheduledOperationCount(config), 72000);
});

test("x4 profile schedules 288,000 operations", () => {
  const { config } = readConfig(new URL("../configs/x4-read-open-loop.json", import.meta.url));
  assert.equal(scheduledOperationCount(config), 288000);
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
