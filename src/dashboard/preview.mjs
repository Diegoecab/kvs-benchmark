import fs from "node:fs";
import path from "node:path";
import { applyRuntimeOverrides, readConfig, scheduledOperationCount } from "../core/config.mjs";

const CONFIG_NAME = /^[a-z0-9-]+\.json$/;

export function listBenchmarkConfigs(configDirectory) {
  return fs.readdirSync(configDirectory).filter(name => CONFIG_NAME.test(name)).sort().map(name => {
    try {
      const { config } = readConfig(path.join(configDirectory, name));
      const rates = (config.load.schedule || []).map(step => step.operationsPerSecond).filter(Number.isFinite), levels = config.load.concurrencyLevels || [];
      const loadSummary = config.load.model === "closed-loop" ? config.load.fixedConcurrency ? `${config.load.fixedConcurrency} workers` : levels.length ? `${levels.join(" / ")} workers` : "profile-defined workers" : rates.length ? `${Math.min(...rates)}${Math.max(...rates) === Math.min(...rates) ? "" : `–${Math.max(...rates)}`} ops/s` : "profile-defined";
      const durationSeconds = config.load.durationSeconds || config.load.schedule?.reduce((sum, step) => sum + step.seconds, 0) || (levels.length ? levels.length * (Number(config.load.warmupSecondsPerLevel || 0) + Number(config.load.measurementSecondsPerLevel || 0)) : null);
      return { file: name, name: config.name, model: config.load.model, consistency: config.workload.consistency, readPercent: config.workload.readPercent, writePercent: config.workload.writePercent, durationSeconds, loadSummary };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function positiveInteger(value, fallback, label) {
  const parsed = value == null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function selectedTargets(targets = {}) {
  return ["aws", "adb", "ndcs"].filter(target => targets[target]?.enabled).map(target => ({ target, profile: String(targets[target].profile || "").trim(), region: String(targets[target].region || "").trim(), resource: String(targets[target].resource || "").trim() }));
}

export function previewMatrix(spec, { configDirectory }) {
  const files = [...new Set(Array.isArray(spec.configs) ? spec.configs : [])];
  if (!files.length) throw new Error("Select at least one workload profile");
  if (files.some(file => !CONFIG_NAME.test(file))) throw new Error("A workload profile name is invalid");
  const targets = selectedTargets(spec.targets);
  if (!targets.length) throw new Error("Enable at least one database target");
  const infrastructure = spec.infrastructure || { mode: "existing" };
  if (!["existing", "managed"].includes(infrastructure.mode)) throw new Error("infrastructure.mode must be existing or managed");
  if (infrastructure.mode === "managed" && !String(infrastructure.repositoryPath || "").trim()) throw new Error("Managed infrastructure requires a repository path");
  for (const target of targets) {
    if (!target.profile) throw new Error(`${target.target} requires a credential profile`);
    if (!target.region) throw new Error(`${target.target} requires a region`);
    if (infrastructure.mode === "existing" && !target.resource) throw new Error(`${target.target} requires an existing database/table reference`);
  }
  const repetitions = positiveInteger(spec.repetitions, 1, "repetitions"), presetRepetitions = spec.presetRepetitions || {};
  const overrides = spec.overrides || {};
  if (overrides.readPercent != null && overrides.writePercent != null) {
    if (Number(overrides.readPercent) + Number(overrides.writePercent) !== 100) throw new Error("readPercent + writePercent must equal 100");
  }
  const rows = [];
  for (const file of files) {
    const fullPath = path.resolve(configDirectory, file);
    if (!fullPath.startsWith(path.resolve(configDirectory) + path.sep)) throw new Error("Workload profile path escapes config directory");
    const base = readConfig(fullPath);
    const compatibleOverrides = { ...overrides };
    const ignoredOverrides = [];
    if (base.config.load.model === "open-loop" && compatibleOverrides.fixedConcurrency != null) {
      delete compatibleOverrides.fixedConcurrency;
      ignoredOverrides.push("fixedConcurrency");
    }
    if (base.config.load.model === "closed-loop") {
      for (const name of ["executionMode", "rateMultiplier"]) {
        if (compatibleOverrides[name] != null) { delete compatibleOverrides[name]; ignoredOverrides.push(name); }
      }
    }
    const loaded = applyRuntimeOverrides(base, compatibleOverrides);
    const repetitionsForPreset = positiveInteger(presetRepetitions[file], repetitions, `${file} repetitions`);
    for (let repetition = 1; repetition <= repetitionsForPreset; repetition += 1) {
      const durationSeconds = loaded.config.load.durationSeconds || loaded.config.load.schedule?.reduce((sum, step) => sum + step.seconds, 0) || null;
      const scheduledOperationsPerTarget = loaded.config.load.model === "open-loop" ? scheduledOperationCount(loaded.config) : null;
      rows.push({ id: `${loaded.config.name}-r${repetition}`, configFile: file, configName: loaded.config.name, configSha256: loaded.sha256, repetition, loadModel: loaded.config.load.model, executionMode: loaded.config.load.executionMode || "fixed-concurrency", durationSeconds, consistency: loaded.config.workload.consistency, readPercent: loaded.config.workload.readPercent, writePercent: loaded.config.workload.writePercent, fixedConcurrency: loaded.config.load.fixedConcurrency || null, ignoredOverrides, scheduledOperationsPerTarget, averageScheduledOperationsPerSecond: scheduledOperationsPerTarget == null ? null : scheduledOperationsPerTarget / durationSeconds, averageScheduledOperationsPerMinute: scheduledOperationsPerTarget == null ? null : scheduledOperationsPerTarget * 60 / durationSeconds, targets: targets.map(value => value.target) });
    }
  }
  const totalScheduledOperations = rows.reduce((sum, row) => sum + (row.scheduledOperationsPerTarget || 0) * row.targets.length, 0);
  const totalDatabaseMinutes = rows.reduce((sum, row) => sum + Number(row.durationSeconds || 0) * row.targets.length / 60, 0);
  const warnings = rows.filter(row => row.ignoredOverrides.length).map(row => `${row.id}: ignored ${row.ignoredOverrides.join(", ")} because the profile uses ${row.loadModel}`);
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), infrastructure, targets, rows, warnings, totals: { tripletSessions: rows.length, targetExecutions: rows.reduce((sum, row) => sum + row.targets.length, 0), totalScheduledOperations, totalDatabaseMinutes } };
}
