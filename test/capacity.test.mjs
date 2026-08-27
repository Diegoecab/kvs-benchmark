import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCapacityPlan, runCapacityPlan, validateCapacityPlan } from "../src/core/capacity.mjs";
import { readConfig } from "../src/core/config.mjs";

function plan() {
  const definition = baseline => ({ baseline, events: [{ name: "scale-down", atSecond: 1, capacity: { ...baseline, read: baseline.read / 2, write: baseline.write / 2 } }, { name: "scale-up", atSecond: 2, capacity: baseline }] });
  return { schemaVersion: 1, name: "test", durationSeconds: 3, maxRequestSkewMs: 1, minimumLeadTimeSeconds: 0, targets: { aws: definition({ read: 100, write: 100 }), adb: definition({ read: 100, write: 100 }), ndcs: definition({ read: 200, write: 200, storageGB: 10 }) } };
}

test("capacity plan applies ordered events and restores baseline", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z"); let current = { state: "ACTIVE", read: 100, write: 100 }; const applied = [];
  const provider = { async inspect() { return current; }, async apply(capacity) { applied.push(capacity); current = { state: "ACTIVE", ...capacity }; return current; } };
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kvs-capacity-")), "events.json");
  const report = await runCapacityPlan({ plan: plan(), target: "aws", table: "test", startAt: new Date(now).toISOString(), output, provider, clock: () => now, wait: async ms => { now += ms; } });
  assert.equal(report.passed, true); assert.equal(applied.length, 2); assert.deepEqual(report.events.map(value => value.requestSkewMs), [0, 0]); assert.equal(JSON.parse(fs.readFileSync(output)).events.length, 2);
});

test("capacity dry-run authenticates and inspects but never applies", async () => {
  let applied = 0; const provider = { async inspect() { return { state: "ACTIVE", read: 100, write: 100 }; }, async apply() { applied += 1; } };
  const report = await runCapacityPlan({ plan: plan(), target: "aws", table: "test", startAt: "2026-01-01T00:00:00Z", provider, dryRun: true });
  assert.equal(report.dryRun, true); assert.equal(applied, 0);
});

test("failed final scale-up triggers recorded baseline recovery", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z"), calls = 0; let current = { state: "ACTIVE", read: 100, write: 100 };
  const provider = { async inspect() { return current; }, async apply(capacity) { calls += 1; if (calls === 2) throw new Error("transition failed"); current = { state: "ACTIVE", ...capacity }; return current; } };
  const report = await runCapacityPlan({ plan: plan(), target: "aws", table: "test", startAt: new Date(now).toISOString(), provider, clock: () => now, wait: async ms => { now += ms; } });
  assert.equal(report.passed, false); assert.equal(report.events[1].status, "failed"); assert.equal(report.recovery.status, "applied"); assert.equal(calls, 3);
});

test("capacity plans must restore every target baseline", () => {
  const invalid = plan(); invalid.targets.aws.events.at(-1).capacity = { ...invalid.targets.aws.events.at(-1).capacity, read: 101 };
  assert.throws(() => validateCapacityPlan(invalid), /restore baseline/);
});

test("checked-in Phase 1 baselines match their workload profiles", () => {
  for (const name of ["x1-strong", "x1-eventual", "x4-strong", "x4-eventual"]) {
    const [size, consistency] = name.split("-");
    const workloadName = `${size}-read-${consistency === "strong" ? "" : "eventual-"}open-loop.json`;
    const workload = readConfig(new URL(`../configs/${workloadName}`, import.meta.url)).config;
    const capacity = readCapacityPlan(new URL(`../configs/phase1-${name}-capacity.json`, import.meta.url));
    assert.deepEqual(capacity.targets.aws.baseline, { read: workload.capacity.awsDynamodb.readCapacityUnits, write: workload.capacity.awsDynamodb.writeCapacityUnits });
    assert.deepEqual(capacity.targets.adb.baseline, { read: workload.capacity.adbDynamodbApi.readCapacityUnits, write: workload.capacity.adbDynamodbApi.writeCapacityUnits });
    assert.deepEqual(capacity.targets.ndcs.baseline, { read: workload.capacity.ociNosql.readUnits, write: workload.capacity.ociNosql.writeUnits, storageGB: workload.capacity.ociNosql.storageGb });
  }
});
