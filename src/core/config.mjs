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
  for (const name of ["readPercent", "writePercent"]) {
    const value = config.workload?.[name];
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`workload.${name} must be between 0 and 100`);
  }
  if (!['strong', 'eventual'].includes(config.workload?.consistency)) throw new Error("unsupported consistency");
  if (config.workload.writePercent > 0 && !["idempotent", "versioned"].includes(config.workload.writeMode)) throw new Error("workloads with writes require writeMode idempotent or versioned");
  if (config.load?.model === "open-loop") {
    if (!Array.isArray(config.load.schedule) || !config.load.schedule.length) throw new Error("load.schedule is required");
    for (const [index, step] of config.load.schedule.entries()) {
      positive(step.seconds, `load.schedule[${index}].seconds`);
      positive(step.operationsPerSecond, `load.schedule[${index}].operationsPerSecond`);
    }
    positive(config.load.maxInflight, "load.maxInflight");
    positive(config.load.telemetryIntervalMs, "load.telemetryIntervalMs");
    config.load.executionMode ??= "concurrent";
    if (!["concurrent", "sequential"].includes(config.load.executionMode)) throw new Error("load.executionMode must be concurrent or sequential");
    if (config.load.executionMode === "sequential" && config.load.maxInflight !== 1) throw new Error("sequential execution requires load.maxInflight = 1");
  } else if (config.load?.model === "closed-loop") {
    if (config.load.fixedConcurrency != null) {
      positive(config.load.fixedConcurrency, "load.fixedConcurrency");
      if (!Number.isInteger(config.load.fixedConcurrency)) throw new Error("load.fixedConcurrency must be an integer");
      positive(config.load.durationSeconds, "load.durationSeconds");
      positive(config.load.telemetryIntervalMs, "load.telemetryIntervalMs");
    } else {
      if (!Array.isArray(config.load.concurrencyLevels) || !config.load.concurrencyLevels.length) throw new Error("concurrencyLevels are required");
      config.load.concurrencyLevels.forEach((value, index) => positive(value, `concurrencyLevels[${index}]`));
      positive(config.load.warmupSecondsPerLevel, "warmupSecondsPerLevel");
      positive(config.load.measurementSecondsPerLevel, "measurementSecondsPerLevel");
    }
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

export function applyRuntimeOverrides(loaded, overrides = {}) {
  const supplied = Object.values(overrides).some(value => value !== undefined && value !== null && value !== "");
  if (!supplied) return loaded;
  const config = structuredClone(loaded.config);
  const number = (value, name) => { const parsed = Number(value); if (!Number.isFinite(parsed)) throw new Error(`${name} must be numeric`); return parsed; };
  if (overrides.readPercent != null || overrides.writePercent != null) {
    if (overrides.readPercent != null && overrides.writePercent != null) {
      config.workload.readPercent = number(overrides.readPercent, "readPercent"); config.workload.writePercent = number(overrides.writePercent, "writePercent");
    } else if (overrides.readPercent != null) {
      config.workload.readPercent = number(overrides.readPercent, "readPercent"); config.workload.writePercent = 100 - config.workload.readPercent;
    } else {
      config.workload.writePercent = number(overrides.writePercent, "writePercent"); config.workload.readPercent = 100 - config.workload.writePercent;
    }
  }
  if (overrides.writeMode != null) config.workload.writeMode = overrides.writeMode;
  if (overrides.consistency != null) config.workload.consistency = overrides.consistency;
  if (overrides.durationSeconds != null) {
    const duration = number(overrides.durationSeconds, "durationSeconds"); positive(duration, "durationSeconds");
    if (config.load.model === "open-loop") {
      const original = config.load.schedule.reduce((sum, step) => sum + step.seconds, 0); let assigned = 0;
      config.load.schedule = config.load.schedule.map((step, index) => { const seconds = index === config.load.schedule.length - 1 ? duration - assigned : Number((duration * step.seconds / original).toFixed(6)); assigned += seconds; return { ...step, seconds }; });
    } else config.load.durationSeconds = duration;
  }
  if (overrides.rateMultiplier != null) {
    if (config.load.model !== "open-loop") throw new Error("rateMultiplier applies only to open-loop profiles");
    const multiplier = number(overrides.rateMultiplier, "rateMultiplier"); positive(multiplier, "rateMultiplier");
    config.load.schedule = config.load.schedule.map(step => ({ ...step, operationsPerSecond: step.operationsPerSecond * multiplier }));
  }
  if (overrides.executionMode != null) {
    if (config.load.model !== "open-loop") throw new Error("executionMode applies only to open-loop profiles");
    config.load.executionMode = overrides.executionMode;
  }
  if (overrides.fixedConcurrency != null) {
    if (config.load.model !== "closed-loop" || config.load.fixedConcurrency == null) throw new Error("fixedConcurrency requires a fixed closed-loop profile");
    config.load.fixedConcurrency = number(overrides.fixedConcurrency, "fixedConcurrency");
  }
  validateConfig(config);
  const effective = `${JSON.stringify(config)}\n`;
  return { config, sha256: crypto.createHash("sha256").update(effective).digest("hex"), baseSha256: loaded.sha256, overridden: true };
}

export function scheduledOperationCount(config) {
  return config.load.schedule.reduce((sum, step) => sum + Math.floor(step.seconds * step.operationsPerSecond), 0);
}
