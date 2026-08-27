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

test("invalid workload mix is rejected", () => {
  const config = structuredClone(readConfig(new URL("../configs/smoke.json", import.meta.url)).config);
  config.workload.writePercent = 1;
  assert.throws(() => validateConfig(config), /must equal 100/);
});
