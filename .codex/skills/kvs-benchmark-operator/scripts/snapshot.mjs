#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyRuntimeOverrides, readConfig } from "../../../../src/core/config.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const runsRoot = path.join(repository, ".kvs", "cloud-runs");
const requested = process.argv.find(argument => argument.startsWith("--run-id="))?.slice(9);
const candidates = fs.existsSync(runsRoot) ? fs.readdirSync(runsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
  const file = path.join(runsRoot, entry.name, ".dashboard-state.json");
  if (!fs.existsSync(file)) return null;
  try { return { directory: path.join(runsRoot, entry.name), state: JSON.parse(fs.readFileSync(file, "utf8")) }; } catch { return null; }
}).filter(Boolean) : [];
const selected = requested
  ? candidates.find(candidate => candidate.state.id === requested)
  : candidates.find(candidate => ["queued", "running"].includes(candidate.state.status)) || candidates.sort((left, right) => String(right.state.createdAt).localeCompare(String(left.state.createdAt)))[0];
if (!selected) throw new Error(requested ? `Run not found: ${requested}` : "No cloud benchmark run was found");

const { state, directory } = selected;
const matrixSession = (state.spec?.matrix || state.matrix || []).find(session => session.id === state.currentSession?.id) || null;
let effectiveConfig = null;
if (matrixSession?.configFile) {
  try { effectiveConfig = applyRuntimeOverrides(readConfig(path.join(repository, "configs", matrixSession.configFile)), matrixSession.effectiveOverrides || {}).config; } catch {}
}
const properties = state.currentSession?.properties || (matrixSession ? {
  readPercent: matrixSession.readPercent,
  writePercent: matrixSession.writePercent,
  consistency: matrixSession.consistency,
  loadModel: matrixSession.loadModel,
  executionMode: matrixSession.executionMode,
  loadSchedule: effectiveConfig?.load?.schedule || [],
  fixedConcurrency: matrixSession.fixedConcurrency,
  maxInflight: effectiveConfig?.load?.maxInflight || null,
  scheduledOperationsPerTarget: matrixSession.scheduledOperationsPerTarget,
  averageScheduledOperationsPerSecond: matrixSession.averageScheduledOperationsPerSecond,
  maxAttempts: effectiveConfig?.client?.maxAttempts ?? null,
  requestTimeoutMs: effectiveConfig?.client?.requestTimeoutMs ?? null,
  keyCount: effectiveConfig?.dataset?.keyCount ?? null,
  payloadBytes: effectiveConfig?.dataset?.payloadBytes ?? null,
} : null);
const mix = properties ? properties.readPercent === 100 ? "100% reads" : properties.writePercent === 100 ? "100% writes" : `${properties.readPercent}% reads / ${properties.writePercent}% writes` : null;
const loadDescription = properties ? properties.loadModel === "open-loop" ? `${properties.executionMode} open-loop: ${properties.loadSchedule.map(step => `${step.operationsPerSecond} ops/s for ${step.seconds}s`).join(" → ")}` : `fixed concurrency: ${properties.fixedConcurrency} workers` : null;
const currentSession = state.currentSession ? { ...state.currentSession, name: state.currentSession.name || matrixSession?.name || matrixSession?.configName, description: state.currentSession.description || (properties ? `${mix}, ${properties.consistency} consistency; ${loadDescription}` : null), properties } : null;
const preload = Object.keys(state.targetStatus || {}).flatMap(target => {
  const file = path.join(directory, "evidence", "preload", target, "preload-summary.json");
  if (!fs.existsSync(file)) return [];
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  return [{ target, completed: value.completed, requested: value.requested, failures: value.failures, successfulOperationsPerSecond: value.successfulOperationsPerSecond, p95Ms: value.latencyMs?.p95 ?? null, p99Ms: value.latencyMs?.p99 ?? null, startSkewMs: value.startSkewMs, writeUnits: value.writeUnits || null }];
});
const activeStage = state.stages?.find(stage => stage.status === "running")?.name || state.stages?.find(stage => stage.status === "failed")?.name || null;
const live = Object.fromEntries(Object.entries(state.targetMetrics || {}).map(([target, value]) => {
  const completed = value.completed ?? null, failed = value.failed ?? null, scheduled = value.scheduled ?? properties?.scheduledOperationsPerTarget ?? null;
  const accounted = completed == null ? null : completed + Number(failed || 0);
  return [target, { completed, scheduled, completionPercent: accounted != null && scheduled ? Number((accounted * 100 / scheduled).toFixed(2)) : null, failed, operationsPerSecond: value.operationsPerSecond ?? null, inFlight: value.inFlight ?? null, rollingP95Ms: value.rollingP95Ms ?? value.p95 ?? null, provisional: Boolean(value.provisional) }];
}));
console.log(JSON.stringify({ runId: state.id, status: state.status, activeStage, targets: Object.keys(state.targetStatus || {}), currentSession, sharedStartAt: state.sharedStartAt || null, completedSessions: state.sessionResults?.length || 0, totalSessions: state.spec?.matrix?.length || state.matrix?.length || 0, preload, live, lastEvent: state.logs?.at(-1) || null, error: state.error || null, downloadReady: Boolean(state.archiveFile) }, null, 2));
