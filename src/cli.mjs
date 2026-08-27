#!/usr/bin/env node
import { readConfig, scheduledOperationCount } from "./core/config.mjs";
import { createProvider } from "./providers/index.mjs";
import { runOpenLoop } from "./core/open-loop.mjs";
import { certifyDataset, preloadDataset } from "./core/dataset.mjs";

function args() {
  const values = { command: process.argv[2] };
  for (const entry of process.argv.slice(3)) {
    if (!entry.startsWith("--")) continue;
    const [key, ...rest] = entry.slice(2).split("="); values[key] = rest.join("=");
  }
  return values;
}

const options = args();
if (!options.config) throw new Error("--config is required");
const loaded = readConfig(options.config);
if (options.command === "validate") {
  process.stdout.write(`${JSON.stringify({ valid: true, name: loaded.config.name, model: loaded.config.load.model, scheduledOperations: loaded.config.load.model === "open-loop" ? scheduledOperationCount(loaded.config) : null, sha256: loaded.sha256 }, null, 2)}\n`);
} else if (["run", "preload", "certify"].includes(options.command)) {
  if (!options.target || !options.table || !options.output) throw new Error("--target, --table, and --output are required");
  const executionConfig = options.command === "certify" ? { ...loaded.config, workload: { ...loaded.config.workload, consistency: "strong" } } : loaded.config;
  const provider = await createProvider({ config: executionConfig, target: options.target, table: options.table, endpoint: options.endpoint });
  try {
    const common = { config: executionConfig, configSha256: loaded.sha256, provider, target: options.target, table: options.table, output: options.output };
    const summary = options.command === "run"
      ? await runOpenLoop({ ...common, startAt: options["start-at"] })
      : options.command === "preload"
        ? await preloadDataset({ ...common, rate: Number(options.rate || 50), maxInflight: Number(options["max-inflight"] || 64) })
        : await certifyDataset({ ...common, rate: Number(options.rate || 25), maxInflight: Number(options["max-inflight"] || 64) });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (summary.passed === false) process.exitCode = 2;
  } finally { await provider.close(); }
} else throw new Error("command must be validate, run, preload, or certify");
