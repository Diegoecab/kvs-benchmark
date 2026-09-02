#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const preload = Object.keys(state.targetStatus || {}).flatMap(target => {
  const file = path.join(directory, "evidence", "preload", target, "preload-summary.json");
  if (!fs.existsSync(file)) return [];
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  return [{ target, completed: value.completed, requested: value.requested, failures: value.failures, successfulOperationsPerSecond: value.successfulOperationsPerSecond, p95Ms: value.latencyMs?.p95 ?? null, p99Ms: value.latencyMs?.p99 ?? null, startSkewMs: value.startSkewMs, writeUnits: value.writeUnits || null }];
});
const activeStage = state.stages?.find(stage => stage.status === "running")?.name || state.stages?.find(stage => stage.status === "failed")?.name || null;
const live = Object.fromEntries(Object.entries(state.targetMetrics || {}).map(([target, value]) => [target, { completed: value.completed ?? null, scheduled: value.scheduled ?? state.currentSession?.scheduledOperationsPerTarget ?? null, failed: value.failed ?? null, operationsPerSecond: value.operationsPerSecond ?? null, inFlight: value.inFlight ?? null, rollingP95Ms: value.rollingP95Ms ?? value.p95 ?? null, provisional: Boolean(value.provisional) }]));
console.log(JSON.stringify({ runId: state.id, status: state.status, activeStage, targets: Object.keys(state.targetStatus || {}), currentSession: state.currentSession || null, completedSessions: state.sessionResults?.length || 0, totalSessions: state.spec?.matrix?.length || state.matrix?.length || 0, preload, live, lastEvent: state.logs?.at(-1) || null, error: state.error || null, downloadReady: Boolean(state.archiveFile) }, null, 2));
