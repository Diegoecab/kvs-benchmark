import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { distribution } from "../core/statistics.mjs";

export const TARGETS = ["aws", "adb", "ndcs"];
export const LABELS = { aws: "AWS DynamoDB", adb: "ADB DynamoDB API", ndcs: "OCI NoSQL" };

const json = file => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const errorName = record => typeof record.error === "string" ? record.error : record.error?.name;
export const isThrottle = record => Boolean(errorName(record)?.match(/thrott|rate.?limit|limit.?exceeded|throughput.?exceeded|too.?many|capacity/i) || record.error?.httpStatusCode === 429 || record.rateLimitDelayMs > 0);

function* lines(file, chunkBytes = 1024 * 1024) {
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(chunkBytes);
  let remainder = "";
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytes) break;
      const text = remainder + buffer.toString("utf8", 0, bytes);
      const parts = text.split(/\r?\n/);
      remainder = parts.pop() || "";
      yield* parts;
    }
    if (remainder) yield remainder;
  } finally {
    fs.closeSync(descriptor);
  }
}

function intervals(counts, t0) {
  const result = [];
  let active = null;
  for (let second = 0; second < counts.length; second += 1) {
    if (counts[second] > 0 && !active) active = { startSecond: second, total: 0, peakPerSecond: 0 };
    if (active && counts[second] > 0) { active.total += counts[second]; active.peakPerSecond = Math.max(active.peakPerSecond, counts[second]); }
    if (active && (counts[second] === 0 || second === counts.length - 1)) {
      const endSecond = counts[second] === 0 ? second - 1 : second;
      result.push({ ...active, endSecond, durationSeconds: endSecond - active.startSecond + 1, startAt: new Date(t0 + active.startSecond * 1000).toISOString(), endAt: new Date(t0 + (endSecond + 1) * 1000).toISOString() });
      active = null;
    }
  }
  return result;
}

function analyzeOperations(file, summary) {
  const t0 = Date.parse(summary.startAt);
  const duration = Math.max(1, Number(summary.durationSeconds || 900));
  const timeline = Array.from({ length: duration }, (_, second) => ({ second, at: new Date(t0 + second * 1000).toISOString(), offeredRate: null, completed: 0, errors: 0, throttles: 0, latency: [] }));
  const successful = [], intended = [], byOperation = { read: [], write: [] }, errorCounts = {}, errorSeconds = {}, throttleSeconds = Array(duration).fill(0);
  const scheduleHash = crypto.createHash("sha256"), scheduleEntries = []; let records = 0, maximum = null;
  const compareLogicalSchedule = (summary.loadModel || "open-loop") === "open-loop";
  for (const line of lines(file)) {
    if (!line) continue;
    const record = JSON.parse(line); records += 1;
    if (compareLogicalSchedule) scheduleEntries.push({ sequence: record.sequence, value: `${record.sequence}|${record.operation}|${record.keyIndex}|${record.scheduledEpochMs}|${record.offeredRate}\n` });
    const second = Math.max(0, Math.min(duration - 1, Math.floor((record.scheduledEpochMs - t0) / 1000)));
    const point = timeline[second]; point.offeredRate = record.offeredRate ?? point.offeredRate;
    const throttled = isThrottle(record);
    if (throttled) { point.throttles += 1; throttleSeconds[second] += 1; }
    if (record.error) {
      const name = errorName(record) || "UnknownError";
      point.errors += 1; errorCounts[name] = (errorCounts[name] || 0) + 1;
      errorSeconds[name] ||= Array(duration).fill(0); errorSeconds[name][second] += 1;
    } else {
      point.completed += 1; point.latency.push(record.serviceLatencyMs); successful.push(record.serviceLatencyMs); intended.push(record.intendedLatencyMs ?? record.serviceLatencyMs);
      if (byOperation[record.operation]) byOperation[record.operation].push(record.serviceLatencyMs);
      if (!maximum || record.serviceLatencyMs > maximum.serviceLatencyMs) maximum = { serviceLatencyMs: record.serviceLatencyMs, at: new Date(record.endedEpochMs).toISOString(), operation: record.operation, sequence: record.sequence };
    }
  }
  if (compareLogicalSchedule) scheduleEntries.sort((a, b) => a.sequence - b.sequence).forEach(entry => scheduleHash.update(entry.value));
  for (const point of timeline) { const stats = distribution(point.latency); delete point.latency; Object.assign(point, { p50Ms: stats.p50, p95Ms: stats.p95, p99Ms: stats.p99, maxMs: stats.max }); }
  const throttleIntervals = intervals(throttleSeconds, t0);
  return {
    recordCount: records,
    scheduleSha256: compareLogicalSchedule ? scheduleHash.digest("hex") : null,
    successfulLatency: distribution(successful),
    intendedLatency: distribution(intended),
    byOperation: Object.fromEntries(Object.entries(byOperation).map(([name, values]) => [name, distribution(values)])),
    maximum,
    errorCounts,
    errorIntervals: Object.fromEntries(Object.entries(errorSeconds).map(([name, counts]) => [name, intervals(counts, t0)])),
    throttling: { count: throttleSeconds.reduce((a, b) => a + b, 0), affectedSeconds: throttleSeconds.filter(Boolean).length, longestSeconds: Math.max(0, ...throttleIntervals.map(value => value.durationSeconds)), intervals: throttleIntervals },
    timeline,
    successfulValues: successful,
  };
}

function targetInput(value) { return typeof value === "string" ? { run: value } : value; }

export function analyzeSuite(suiteFile) {
  const suitePath = path.resolve(suiteFile); const root = path.dirname(suitePath); const suite = json(suitePath);
  if (suite.schemaVersion !== 1 || !suite.title || !Array.isArray(suite.sessions) || !suite.sessions.length) throw new Error("suite requires schemaVersion 1, title, and sessions");
  const certificates = (suite.datasetCertificates || []).map(value => typeof value === "string" ? { path: value.replaceAll("\\", "/"), ...json(path.resolve(root, value)) } : value);
  if (certificates.length !== TARGETS.length) throw new Error("exactly three dataset certificates are required");
  if (certificates.some(value => value.passed !== true || value.expectedSha256 !== value.observedSha256)) throw new Error("a dataset certificate is not accepted");
  const certificateHashes = [...new Set(certificates.map(value => value.observedSha256).filter(Boolean))];
  if (certificateHashes.length > 1) throw new Error("dataset certificate hashes differ across targets");
  const sessions = [];
  for (const definition of suite.sessions) {
    if (!definition.id || !definition.phase || !definition.consistency) throw new Error("every session requires id, phase, and consistency");
    const session = { id: definition.id, phase: definition.phase, consistency: definition.consistency, workload: definition.workload || null, repetition: definition.repetition || definition.id, targets: {} };
    for (const target of TARGETS) {
      const input = targetInput(definition.targets?.[target]); if (!input?.run) throw new Error(`${definition.id} is missing ${target}`);
      const directory = path.resolve(root, input.run); const summary = json(path.join(directory, "summary.json"));
      if (summary.target !== target || summary.consistency !== definition.consistency) throw new Error(`${definition.id}/${target} metadata does not match suite`);
      const raw = analyzeOperations(path.join(directory, "operations.ndjson"), summary);
      const capacityFile = input.capacityEvents ? path.resolve(root, input.capacityEvents) : path.resolve(directory, "..", "capacity-events.json");
      const capacity = definition.phase === "phase1" && fs.existsSync(capacityFile) ? json(capacityFile) : null;
      if (Number(summary.schedulerDrops || 0) !== 0) throw new Error(`${definition.id}/${target} contains client scheduler drops`);
      if (Math.abs(Number(summary.startSkewMs || 0)) > Number(suite.acceptance?.maxStartSkewMs ?? 250)) throw new Error(`${definition.id}/${target} start skew exceeds the acceptance limit`);
      if (definition.phase === "phase1") {
        if (capacity?.passed !== true) throw new Error(`${definition.id}/${target} capacity transition evidence is not accepted`);
        if (capacity.events?.length !== 2 || capacity.events[0]?.name !== "scale-down" || capacity.events[1]?.name !== "scale-up") throw new Error(`${definition.id}/${target} must contain scale-down and scale-up evidence`);
      }
      session.targets[target] = { summary, ...raw, capacity, evidencePath: input.run.replaceAll("\\", "/"), capacityEvidencePath: capacity ? path.relative(root, capacityFile).replaceAll("\\", "/") : null };
    }
    if (new Set(TARGETS.map(target => session.targets[target].summary.configSha256)).size !== 1) throw new Error(`${definition.id} target configuration hashes differ`);
    const loadModels = new Set(TARGETS.map(target => session.targets[target].summary.loadModel || "open-loop"));
    if (loadModels.size !== 1) throw new Error(`${definition.id} target load models differ`);
    const loadModel = [...loadModels][0];
    if (loadModel === "open-loop") {
      const scheduleHashes = new Set(TARGETS.map(target => session.targets[target].scheduleSha256));
      if (scheduleHashes.size !== 1) throw new Error(`${definition.id} target operation schedules differ`);
    } else {
      const concurrencies = new Set(TARGETS.map(target => session.targets[target].summary.concurrency?.targetConcurrency));
      const durations = new Set(TARGETS.map(target => session.targets[target].summary.durationSeconds));
      if (concurrencies.size !== 1 || [...concurrencies][0] == null) throw new Error(`${definition.id} target fixed concurrency differs`);
      if (durations.size !== 1) throw new Error(`${definition.id} target closed-loop durations differ`);
    }
    session.loadModel = loadModel;
    session.workload ||= `${session.targets.aws.summary.workload?.readPercent ?? "?"}R/${session.targets.aws.summary.workload?.writePercent ?? "?"}W ${session.targets.aws.summary.workload?.executionMode || loadModel}`;
    for (const target of TARGETS) if (session.targets[target].recordCount !== session.targets[target].summary.scheduled) throw new Error(`${definition.id}/${target} raw record count does not match scheduled count`);
    sessions.push(session);
  }
  const groups = [];
  for (const key of [...new Set(sessions.map(value => `${value.phase}|${value.consistency}|${value.workload}`))]) {
    const [phase, consistency, workload] = key.split("|"); const selected = sessions.filter(value => value.phase === phase && value.consistency === consistency && value.workload === workload);
    const targets = {};
    for (const target of TARGETS) {
      const values = selected.flatMap(value => value.targets[target].successfulValues);
      const scheduled = selected.reduce((sum, value) => sum + value.targets[target].summary.scheduled, 0);
      const completed = selected.reduce((sum, value) => sum + value.targets[target].summary.completed, 0);
      targets[target] = { scheduled, completed, completionRate: scheduled ? completed / scheduled : 0, successfulLatency: distribution(values), errors: selected.reduce((sum, value) => sum + Object.values(value.targets[target].errorCounts).reduce((a, b) => a + b, 0), 0), throttleAffectedSeconds: selected.reduce((sum, value) => sum + value.targets[target].throttling.affectedSeconds, 0) };
    }
    groups.push({ phase, consistency, workload, loadModel: selected[0].loadModel, sessions: selected.map(value => value.id), targets });
  }
  for (const session of sessions) for (const target of TARGETS) delete session.targets[target].successfulValues;
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), title: suite.title, benchmarkId: suite.benchmarkId || null, scope: suite.scope || {}, executiveSummary: suite.executiveSummary || [], phaseDescriptions: suite.phaseDescriptions || {}, capacityComparison: suite.capacityComparison || {}, pricing: suite.pricing || null, references: suite.references || {}, additionalEvidence: suite.additionalEvidence || [], datasetCertificates: certificates, datasetCertified: certificates.length > 0, labels: LABELS, sessions, groups };
}
