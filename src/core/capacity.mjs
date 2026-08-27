import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { errorEvidence } from "./errors.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

export function validateCapacityPlan(plan) {
  if (plan?.schemaVersion !== 1 || !plan.name) throw new Error("capacity plan schemaVersion 1 and name are required");
  if (!Number.isFinite(plan.durationSeconds) || plan.durationSeconds <= 0) throw new Error("durationSeconds must be positive");
  if (!Number.isFinite(plan.maxRequestSkewMs) || plan.maxRequestSkewMs < 0) throw new Error("maxRequestSkewMs must be zero or positive");
  if (!Number.isFinite(plan.minimumLeadTimeSeconds) || plan.minimumLeadTimeSeconds < 0) throw new Error("minimumLeadTimeSeconds must be zero or positive");
  for (const target of ["aws", "adb", "ndcs"]) {
    const definition = plan.targets?.[target];
    if (!definition?.baseline || !Array.isArray(definition.events) || !definition.events.length) throw new Error(`targets.${target} baseline and events are required`);
    const capacities = [definition.baseline, ...definition.events.map(event => event.capacity)];
    for (const capacity of capacities) {
      if (!Number.isInteger(capacity.read) || capacity.read <= 0 || !Number.isInteger(capacity.write) || capacity.write <= 0) throw new Error(`${target} capacity must contain positive integer read/write values`);
      if (target === "ndcs" && (!Number.isInteger(capacity.storageGB) || capacity.storageGB <= 0)) throw new Error("ndcs capacity requires positive integer storageGB");
    }
    let previous = -1;
    for (const event of definition.events) {
      if (!event.name || !Number.isFinite(event.atSecond) || event.atSecond <= previous || event.atSecond >= plan.durationSeconds) throw new Error(`${target} events must be named, ordered, and inside the run window`);
      previous = event.atSecond;
    }
    const final = definition.events.at(-1).capacity;
    for (const field of target === "ndcs" ? ["read", "write", "storageGB"] : ["read", "write"]) {
      if (final[field] !== definition.baseline[field]) throw new Error(`${target} final event must restore baseline ${field}`);
    }
  }
  return plan;
}

export function readCapacityPlan(file) {
  return validateCapacityPlan(JSON.parse(fs.readFileSync(file, "utf8")));
}

async function waitUntil(epochMs, wait = sleep, clock = Date.now) {
  while (clock() < epochMs) await wait(Math.min(1000, epochMs - clock()));
}

function sameCapacity(target, observed, expected) {
  const fields = target === "ndcs" ? ["read", "write", "storageGB"] : ["read", "write"];
  return fields.every(field => Number(observed?.[field]) === expected[field]);
}

export async function runCapacityPlan({ plan, target, table, startAt, output, provider, dryRun = false, wait = sleep, clock = Date.now }) {
  validateCapacityPlan(plan);
  if (!plan.targets[target]) throw new Error(`target ${target} is not in the capacity plan`);
  const benchmarkT0 = Date.parse(startAt);
  if (!Number.isFinite(benchmarkT0)) throw new Error("invalid --start-at");
  if (!dryRun && benchmarkT0 - clock() < plan.minimumLeadTimeSeconds * 1000) throw new Error(`--start-at must be at least ${plan.minimumLeadTimeSeconds} seconds in the future`);
  const definition = plan.targets[target];
  const initialCapacity = await provider.inspect();
  if (initialCapacity.state !== "ACTIVE" || !sameCapacity(target, initialCapacity, definition.baseline)) throw new Error(`Initial ${target} capacity is not ACTIVE at the declared baseline`);
  const report = { schemaVersion: 1, planName: plan.name, target, table, benchmarkT0: new Date(benchmarkT0).toISOString(), initialCapacity, dryRun, schedule: definition.events, events: [], generatedAt: new Date(clock()).toISOString() };
  const persist = () => {
    report.generatedAt = new Date(clock()).toISOString();
    if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`); }
  };
  persist();
  if (dryRun) return report;
  for (const scheduled of definition.events) {
    const scheduledEpochMs = benchmarkT0 + scheduled.atSecond * 1000;
    await waitUntil(scheduledEpochMs, wait, clock);
    const requestedEpochMs = clock();
    const startedPerf = performance.now();
    const event = { name: scheduled.name, atSecond: scheduled.atSecond, scheduledAt: new Date(scheduledEpochMs).toISOString(), requestedAt: new Date(requestedEpochMs).toISOString(), requestSkewMs: requestedEpochMs - scheduledEpochMs, requestedCapacity: scheduled.capacity };
    try {
      event.appliedCapacity = await provider.apply(scheduled.capacity);
      event.appliedAt = new Date(clock()).toISOString();
      event.applyDurationMs = Number((performance.now() - startedPerf).toFixed(3));
      event.status = "applied";
    } catch (error) {
      event.failedAt = new Date(clock()).toISOString();
      event.applyDurationMs = Number((performance.now() - startedPerf).toFixed(3));
      event.status = "failed";
      event.error = errorEvidence(error);
    }
    report.events.push(event);
    persist();
  }
  report.passed = report.events.length === definition.events.length && report.events.every(event => event.status === "applied" && Math.abs(event.requestSkewMs) <= plan.maxRequestSkewMs && sameCapacity(target, event.appliedCapacity, event.requestedCapacity));
  if (!sameCapacity(target, report.events.at(-1)?.appliedCapacity, definition.baseline)) {
    const startedPerf = performance.now(); report.recovery = { requestedAt: new Date(clock()).toISOString(), requestedCapacity: definition.baseline };
    try {
      report.recovery.appliedCapacity = await provider.apply(definition.baseline); report.recovery.appliedAt = new Date(clock()).toISOString(); report.recovery.status = "applied";
    } catch (error) {
      report.recovery.failedAt = new Date(clock()).toISOString(); report.recovery.status = "failed"; report.recovery.error = errorEvidence(error);
    }
    report.recovery.applyDurationMs = Number((performance.now() - startedPerf).toFixed(3));
  }
  persist();
  return report;
}
