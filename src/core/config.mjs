import fs from "node:fs";
import crypto from "node:crypto";

function positive(value, path) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${path} must be positive`);
}

export function validateConfig(config) {
  if (config?.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (!config.name) throw new Error("name is required");
  positive(config.dataset?.keyCount, "dataset.keyCount");
  positive(config.dataset?.payloadBytes, "dataset.payloadBytes");
  positive(config.dataset?.partitionBuckets, "dataset.partitionBuckets");
  if (!Number.isInteger(config.dataset?.seed)) throw new Error("dataset.seed must be an integer");
  if (config.dataset?.distribution !== "uniform") throw new Error("v0.1 supports only uniform distribution");
  const mix = (config.workload?.readPercent ?? -1) + (config.workload?.writePercent ?? -1);
  if (mix !== 100) throw new Error("readPercent + writePercent must equal 100");
  if (!['strong', 'eventual'].includes(config.workload?.consistency)) throw new Error("unsupported consistency");
  if (config.load?.model === "open-loop") {
    if (!Array.isArray(config.load.schedule) || !config.load.schedule.length) throw new Error("load.schedule is required");
    for (const [index, step] of config.load.schedule.entries()) {
      positive(step.seconds, `load.schedule[${index}].seconds`);
      positive(step.operationsPerSecond, `load.schedule[${index}].operationsPerSecond`);
    }
    positive(config.load.maxInflight, "load.maxInflight");
    positive(config.load.telemetryIntervalMs, "load.telemetryIntervalMs");
  } else if (config.load?.model === "closed-loop") {
    if (!Array.isArray(config.load.concurrencyLevels) || !config.load.concurrencyLevels.length) throw new Error("concurrencyLevels are required");
    config.load.concurrencyLevels.forEach((value, index) => positive(value, `concurrencyLevels[${index}]`));
    positive(config.load.warmupSecondsPerLevel, "warmupSecondsPerLevel");
    positive(config.load.measurementSecondsPerLevel, "measurementSecondsPerLevel");
  } else throw new Error("unsupported load.model");
  positive(config.client?.maxConnections, "client.maxConnections");
  positive(config.client?.requestTimeoutMs, "client.requestTimeoutMs");
  positive(config.client?.connectionTimeoutMs, "client.connectionTimeoutMs");
  positive(config.client?.maxAttempts, "client.maxAttempts");
  return config;
}

export function readConfig(path) {
  const raw = fs.readFileSync(path, "utf8");
  const config = validateConfig(JSON.parse(raw));
  return { config, sha256: crypto.createHash("sha256").update(raw).digest("hex") };
}

export function scheduledOperationCount(config) {
  return config.load.schedule.reduce((sum, step) => sum + Math.floor(step.seconds * step.operationsPerSecond), 0);
}

