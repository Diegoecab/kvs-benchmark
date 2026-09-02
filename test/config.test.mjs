import test from "node:test";
import assert from "node:assert/strict";
import { applyRuntimeOverrides, readConfig, scheduledOperationCount, validateConfig } from "../src/core/config.mjs";
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

test("execution mode is explicit and sequential mode enforces one in-flight operation", () => {
  const concurrent = structuredClone(readConfig(new URL("../configs/smoke.json", import.meta.url)).config);
  assert.equal(concurrent.load.executionMode, "concurrent");
  const sequential = structuredClone(concurrent); sequential.load.executionMode = "sequential";
  assert.throws(() => validateConfig(sequential), /maxInflight = 1/);
  sequential.load.maxInflight = 1;
  assert.equal(validateConfig(sequential).load.executionMode, "sequential");
});

test("runtime overrides are validated, applied, and included in a new effective hash", () => {
  const loaded = readConfig(new URL("../configs/x4-read-open-loop.json", import.meta.url));
  const effective = applyRuntimeOverrides(loaded, { durationSeconds: 300, rateMultiplier: 0.5 });
  assert.equal(effective.config.load.schedule.reduce((sum, step) => sum + step.seconds, 0), 300);
  assert.deepEqual(effective.config.load.schedule.map(step => step.operationsPerSecond), [50, 100, 200, 300, 150]);
  assert.notEqual(effective.sha256, loaded.sha256); assert.equal(effective.baseSha256, loaded.sha256);
  const fixed = applyRuntimeOverrides(readConfig(new URL("../configs/x4-read-fixed-concurrency.json", import.meta.url)), { durationSeconds: 60, fixedConcurrency: 4 });
  assert.equal(fixed.config.load.durationSeconds, 60); assert.equal(fixed.config.load.fixedConcurrency, 4);
  const eventual = applyRuntimeOverrides(loaded, { consistency: "eventual" });
  assert.equal(eventual.config.workload.consistency, "eventual");
  assert.throws(() => applyRuntimeOverrides(loaded, { consistency: "unknown" }), /unsupported consistency/);
});

test("a concurrency sweep can be pinned to one editable fixed-worker value", () => {
  const loaded = applyRuntimeOverrides(readConfig(new URL("../configs/concurrency-sweep.json", import.meta.url)), { durationSeconds: 120, fixedConcurrency: 16 });
  assert.equal(loaded.config.load.fixedConcurrency, 16); assert.equal(loaded.config.load.durationSeconds, 120); assert.equal(loaded.config.load.telemetryIntervalMs, 100);
  assert.equal("concurrencyLevels" in loaded.config.load, false);
});

test("workloads with writes require an explicit write mode", () => {
  const config = structuredClone(readConfig(new URL("../configs/smoke.json", import.meta.url)).config); config.workload = { readPercent: 70, writePercent: 30, consistency: "strong" };
  assert.throws(() => validateConfig(config), /writeMode/); config.workload.writeMode = "idempotent"; assert.doesNotThrow(() => validateConfig(config));
});

test("capacity-covered 50/50 profile normalizes strong reads and writes with equal headroom", () => {
  const config = readConfig(new URL("../configs/x4-mixed-50-50-capacity-covered.json", import.meta.url)).config;
  assert.equal(config.load.schedule.reduce((sum, step) => sum + step.seconds, 0), 300);
  assert.equal(Math.max(...config.load.schedule.map(step => step.operationsPerSecond)), 600);
  assert.deepEqual(config.capacityCoverage.awsAndAdbRequired, { read: 300, write: 300 });
  assert.deepEqual(config.capacityCoverage.ociNosqlRequired, { read: 600, write: 600 });
  assert.deepEqual(config.capacity.ociNosql, { readUnits: 800, writeUnits: 800, storageGb: 10 });
  assert.equal(config.capacityCoverage.awsAndAdbRequired.read / config.capacity.awsDynamodb.readCapacityUnits, 0.75);
  assert.equal(config.capacityCoverage.awsAndAdbRequired.write / config.capacity.awsDynamodb.writeCapacityUnits, 0.75);
  assert.equal(config.capacityCoverage.ociNosqlRequired.read / config.capacity.ociNosql.readUnits, 0.75);
  assert.equal(config.capacityCoverage.ociNosqlRequired.write / config.capacity.ociNosql.writeUnits, 0.75);
});

test("Dallas profiles reach but never exceed the 1,000 RU/WU NoSQL ceiling", () => {
  const cases = [
    ["dallas-1000-strong-read.json", 500, { read: 1000, write: 0 }, 102000],
    ["dallas-1000-mixed-70-30.json", 700, { read: 980, write: 420 }, 153000],
    ["dallas-1000-mixed-50-50.json", 1000, { read: 1000, write: 1000 }, 192000],
    ["dallas-1000-write.json", 500, { read: 0, write: 1000 }, 102000],
  ];
  for (const [file, peak, required, operations] of cases) {
    const config = readConfig(new URL(`../configs/${file}`, import.meta.url)).config;
    assert.equal(config.load.schedule.reduce((sum, step) => sum + step.seconds, 0), 360);
    assert.equal(Math.max(...config.load.schedule.map(step => step.operationsPerSecond)), peak);
    assert.deepEqual(config.capacityCoverage.ociNosqlRequired, required);
    assert.ok(required.read <= config.capacity.ociNosql.readUnits);
    assert.ok(required.write <= config.capacity.ociNosql.writeUnits);
    assert.deepEqual(config.load.schedule.at(-1), { seconds: 60, operationsPerSecond: 200 });
    assert.equal(scheduledOperationCount(config), operations);
  }
});

test("canonical dataset hash is deterministic and content-sensitive", () => {
  const config = readConfig(new URL("../configs/smoke.json", import.meta.url)).config;
  assert.equal(expectedDatasetSha256(config), expectedDatasetSha256(config));
  assert.deepEqual(Object.keys(canonicalRecord(config, 0)).sort(), ["payload", "pk", "sk", "version"]);
  const changed = structuredClone(config); changed.dataset.payloadBytes += 1;
  assert.notEqual(expectedDatasetSha256(config), expectedDatasetSha256(changed));
});
