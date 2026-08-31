#!/usr/bin/env node
import { applyRuntimeOverrides, readConfig, scheduledOperationCount } from "./core/config.mjs";
import { createProvider } from "./providers/index.mjs";
import { runOpenLoop } from "./core/open-loop.mjs";
import { runClosedLoop } from "./core/closed-loop.mjs";
import { certifyDataset, preloadDataset } from "./core/dataset.mjs";
import { doctor } from "./core/doctor.mjs";
import fs from "node:fs";
import path from "node:path";
import { readCapacityPlan, runCapacityPlan } from "./core/capacity.mjs";
import { createCapacityProvider } from "./capacity/providers.mjs";
import { generateReport } from "./report/html.mjs";
import { generatePackage } from "./report/package.mjs";
import { coordinate, readCoordinationPlan } from "./core/coordinator.mjs";
import { collectMetrics } from "./collectors/metrics.mjs";
import { startDashboard } from "./dashboard/server.mjs";

function args() {
  const values = { command: process.argv[2] };
  for (const entry of process.argv.slice(3)) {
    if (!entry.startsWith("--")) continue;
    const [key, ...rest] = entry.slice(2).split("="); values[key] = rest.join("=");
  }
  return values;
}

const options = args();
const configCommands = ["validate", "doctor", "run", "preload", "certify", "phase1"];
if (configCommands.includes(options.command) && !options.config) throw new Error("--config is required");
const runtimeOverrides = {
  durationSeconds: options["duration-seconds"] ?? process.env.KVS_DURATION_SECONDS,
  fixedConcurrency: options["fixed-concurrency"] ?? process.env.KVS_FIXED_CONCURRENCY,
  readPercent: options["read-percent"] ?? process.env.KVS_READ_PERCENT,
  writePercent: options["write-percent"] ?? process.env.KVS_WRITE_PERCENT,
  writeMode: options["write-mode"] ?? process.env.KVS_WRITE_MODE,
  rateMultiplier: options["rate-multiplier"] ?? process.env.KVS_RATE_MULTIPLIER,
  executionMode: options["execution-mode"] ?? process.env.KVS_EXECUTION_MODE,
  consistency: options.consistency ?? process.env.KVS_CONSISTENCY,
};
const loaded = options.config ? applyRuntimeOverrides(readConfig(options.config), runtimeOverrides) : null;
if (options.command === "validate") {
  process.stdout.write(`${JSON.stringify({ valid: true, name: loaded.config.name, model: loaded.config.load.model, scheduledOperations: loaded.config.load.model === "open-loop" ? scheduledOperationCount(loaded.config) : null, sha256: loaded.sha256 }, null, 2)}\n`);
} else if (options.command === "doctor") {
  if (!options.target) throw new Error("--target is required");
  const report = await doctor({ config: loaded.config, target: options.target, table: options.table, endpoint: options.endpoint, skipNetwork: options["skip-network"] === "true", hostEvidence: options["clock-evidence"] });
  if (options.output) fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ready) process.exitCode = 2;
} else if (["run", "preload", "certify"].includes(options.command)) {
  if (!options.target || !options.table || !options.output) throw new Error("--target, --table, and --output are required");
  const executionConfig = options.command === "certify" ? { ...loaded.config, workload: { ...loaded.config.workload, consistency: "strong" } } : loaded.config;
  const provider = await createProvider({ config: executionConfig, target: options.target, table: options.table, endpoint: options.endpoint });
  try {
    const common = { config: executionConfig, configSha256: loaded.sha256, provider, target: options.target, table: options.table, output: options.output };
    const summary = options.command === "run"
      ? loaded.config.load.model === "closed-loop"
        ? await runClosedLoop({ ...common, startAt: options["start-at"] })
        : await runOpenLoop({ ...common, startAt: options["start-at"] })
      : options.command === "preload"
        ? await preloadDataset({ ...common, rate: Number(options.rate || 50), maxInflight: Number(options["max-inflight"] || 64) })
        : await certifyDataset({ ...common, rate: Number(options.rate || 25), maxInflight: Number(options["max-inflight"] || 64) });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (summary.passed === false) process.exitCode = 2;
  } finally { await provider.close(); }
} else if (options.command === "capacity") {
  if (!options.plan || !options.target || !options.table || !options.output || !options["start-at"]) throw new Error("capacity requires --plan, --target, --table, --output, and --start-at");
  const plan = readCapacityPlan(options.plan);
  const provider = createCapacityProvider({ target: options.target, table: options.table, endpoint: options.endpoint });
  try {
    const report = await runCapacityPlan({ plan, target: options.target, table: options.table, startAt: options["start-at"], output: options.output, provider, dryRun: options["dry-run"] === "true" });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.passed === false) process.exitCode = 2;
  } finally { await provider.close(); }
} else if (options.command === "phase1") {
  if (!options.plan || !options.target || !options.table || !options.output || !options["start-at"]) throw new Error("phase1 requires --config, --plan, --target, --table, --output, and --start-at");
  const plan = readCapacityPlan(options.plan);
  const workloadProvider = await createProvider({ config: loaded.config, target: options.target, table: options.table, endpoint: options.endpoint });
  const capacityProvider = createCapacityProvider({ target: options.target, table: options.table, endpoint: options.endpoint });
  try {
    await runCapacityPlan({ plan, target: options.target, table: options.table, startAt: options["start-at"], provider: capacityProvider, dryRun: true });
    const [workloadResult, capacityResult] = await Promise.allSettled([
      runOpenLoop({ config: loaded.config, configSha256: loaded.sha256, provider: workloadProvider, target: options.target, table: options.table, output: path.join(options.output, "workload"), startAt: options["start-at"] }),
      runCapacityPlan({ plan, target: options.target, table: options.table, startAt: options["start-at"], output: path.join(options.output, "capacity-events.json"), provider: capacityProvider }),
    ]);
    if (capacityResult.status === "rejected") throw capacityResult.reason;
    if (workloadResult.status === "rejected") throw workloadResult.reason;
    const summary = workloadResult.value, capacity = capacityResult.value;
    process.stdout.write(`${JSON.stringify({ summary, capacity }, null, 2)}\n`);
    if (summary.passed === false || capacity.passed === false) process.exitCode = 2;
  } finally {
    await Promise.all([workloadProvider.close(), capacityProvider.close()]);
  }
} else if (options.command === "report") {
  if (!options.suite || !options.output) throw new Error("report requires --suite and --output");
  const report = generateReport({ suite: options.suite, output: options.output });
  process.stdout.write(`${JSON.stringify({ output: path.resolve(options.output), sessions: report.sessions.length, groups: report.groups.length }, null, 2)}\n`);
} else if (options.command === "package") {
  if (!options.suite || !options.output) throw new Error("package requires --suite and --output");
  const manifest = generatePackage({ suite: options.suite, output: options.output });
  process.stdout.write(`${JSON.stringify({ output: path.resolve(options.output), fileCount: manifest.fileCount }, null, 2)}\n`);
} else if (options.command === "coordinate") {
  if (!options.plan || !options.output) throw new Error("coordinate requires --plan and --output");
  const report = await coordinate({ plan: readCoordinationPlan(options.plan), output: options.output, startAt: options["start-at"], dryRun: options["dry-run"] === "true" });
  process.stdout.write(`${JSON.stringify({ sharedStartAt: report.sharedStartAt, passed: report.passed ?? null, runners: report.runners.map(value => ({ target: value.target, exitCode: value.exitCode ?? null, commandSha256: value.commandSha256 })) }, null, 2)}\n`);
  if (report.passed === false) process.exitCode = 2;
} else if (options.command === "metrics") {
  if (!options.target || !options["start-at"] || !options["end-at"] || !options.output) throw new Error("metrics requires --target, --start-at, --end-at, and --output");
  const report = await collectMetrics({ target: options.target, table: options.table, startAt: options["start-at"], endAt: options["end-at"], output: options.output, region: options.region, compartment: options.compartment, resourceId: options["resource-id"], profile: options.profile });
  process.stdout.write(`${JSON.stringify({ target: report.target, startAt: report.startAt, endAt: report.endAt, metricCount: report.metrics.length, output: path.resolve(options.output) }, null, 2)}\n`);
} else if (options.command === "dashboard") {
  await startDashboard({ host: options.host || "127.0.0.1", port: Number(options.port || 4177) });
} else throw new Error("command must be validate, doctor, run, preload, certify, capacity, phase1, report, package, coordinate, metrics, or dashboard");
