import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { buildOperationStream, canonicalKey } from "./workload.mjs";
import { errorEvidence } from "./errors.mjs";
import { distribution } from "./statistics.mjs";
import { RunnerHealthSampler } from "./runner-health.mjs";
import { normalizeShardOptions } from "./sharding.mjs";
import { canonicalItemSizeBytes } from "./dataset.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const fixed = value => Number(value.toFixed(3));

export async function runOpenLoop({ config, configSha256, provider, target, table, output, startAt, onProgress, shardCount = 1, shardIndex = 0 }) {
  if (config.load.model !== "open-loop") throw new Error("run currently supports only open-loop configurations");
  const shard = normalizeShardOptions({ shardCount, shardIndex });
  fs.mkdirSync(output, { recursive: true });
  const operationsOutput = fs.createWriteStream(path.join(output, "operations.ndjson"), { encoding: "utf8" });
  const telemetryOutput = fs.createWriteStream(path.join(output, "telemetry.ndjson"), { encoding: "utf8" });
  const logicalOperations = buildOperationStream(config);
  const operations = logicalOperations.filter(operation => operation.sequence % shard.count === shard.index);
  const executionMode = config.load.executionMode || "concurrent";
  const effectiveMaxInflight = executionMode === "sequential" ? 1 : config.load.maxInflight;
  const requestedStart = startAt ? Date.parse(startAt) : Date.now() + 2000;
  if (!Number.isFinite(requestedStart)) throw new Error("invalid --start-at");
  if (startAt && requestedStart < Date.now()) throw new Error("--start-at must be in the future");
  const startPerf = performance.now() + Math.max(0, requestedStart - Date.now());
  const inFlight = new Set();
  const successfulService = [], successfulIntended = [], failedService = [], queueDelays = [], concurrency = [];
  const errors = {};
  let completed = 0, schedulerDrops = 0, peakInflight = 0, readUnits = 0, writeUnits = 0, retries = 0;
  const cpuStart = process.cpuUsage();
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  const runnerHealth = new RunnerHealthSampler();
  loopDelay.enable();
  const progress = record => {
    if (!onProgress) return;
    const elapsedSeconds = Math.max(0.001, (Date.now() - actualStartEpochMs) / 1000);
    try { onProgress({ scheduled: operations.length, logicalScheduled: logicalOperations.length, shard, accounted: completed + Object.values(errors).reduce((sum, value) => sum + value, 0), completed, failed: Object.values(errors).reduce((sum, value) => sum + value, 0) - schedulerDrops, schedulerDrops, inFlight: inFlight.size, achievedOperationsPerSecond: completed / elapsedSeconds, latestOperation: record?.operation || null, latestLatencyMs: record?.serviceLatencyMs ?? null, latestError: record?.error?.name || null, at: new Date().toISOString() }); } catch {}
  };

  const telemetryTimer = setInterval(() => {
    const sample = { at: new Date().toISOString(), inFlight: inFlight.size, rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed, runner: runnerHealth.sample() };
    concurrency.push(inFlight.size);
    telemetryOutput.write(`${JSON.stringify(sample)}\n`);
  }, config.load.telemetryIntervalMs);

  if (requestedStart > Date.now()) await sleep(requestedStart - Date.now());
  const actualStartEpochMs = Date.now();
  for (const operation of operations) {
    const scheduledPerf = startPerf + operation.offsetMs;
    const delay = scheduledPerf - performance.now();
    if (delay > 0) await sleep(delay);
    if (executionMode === "sequential" && inFlight.size) await Promise.all(inFlight);
    const actualStartPerf = performance.now();
    const scheduledEpochMs = requestedStart + operation.offsetMs;
    const startedEpochMs = requestedStart + actualStartPerf - startPerf;
    const queueDelayMs = actualStartPerf - scheduledPerf;
    if (inFlight.size >= effectiveMaxInflight) {
      schedulerDrops += 1;
      errors.ClientSchedulerDrop = (errors.ClientSchedulerDrop || 0) + 1;
      operationsOutput.write(`${JSON.stringify({ ...operation, scheduledEpochMs, startedEpochMs, endedEpochMs: startedEpochMs, queueDelayMs: fixed(queueDelayMs), serviceLatencyMs: 0, intendedLatencyMs: fixed(queueDelayMs), inFlightAtStart: inFlight.size, error: { name: "ClientSchedulerDrop" } })}\n`);
      progress({ ...operation, serviceLatencyMs: 0, error: { name: "ClientSchedulerDrop" } });
      continue;
    }
    const task = (async () => {
      const inFlightAtStart = inFlight.size + 1;
      peakInflight = Math.max(peakInflight, inFlightAtStart);
      let result = null, error = null;
      try {
        const key = canonicalKey(operation.keyIndex, config.dataset.partitionBuckets);
        const writeVersion = config.workload.writeMode === "idempotent" ? 1 : config.dataset.seed * 1_000_000 + operation.sequence;
        result = operation.operation === "read" ? await provider.read(key) : await provider.write(key, writeVersion);
      } catch (caught) { error = errorEvidence(caught); }
      const endedPerf = performance.now();
      const serviceLatencyMs = endedPerf - actualStartPerf;
      const intendedLatencyMs = endedPerf - scheduledPerf;
      const record = { ...operation, scheduledEpochMs, startedEpochMs, endedEpochMs: requestedStart + endedPerf - startPerf, queueDelayMs: fixed(queueDelayMs), serviceLatencyMs: fixed(serviceLatencyMs), intendedLatencyMs: fixed(intendedLatencyMs), inFlightAtStart, attempts: result?.attempts ?? error?.attempts ?? 1, readUnits: result?.readUnits || 0, writeUnits: result?.writeUnits || 0, rateLimitDelayMs: result?.rateLimitDelayMs || 0, error };
      operationsOutput.write(`${JSON.stringify(record)}\n`);
      queueDelays.push(queueDelayMs);
      if (error) { errors[error.name] = (errors[error.name] || 0) + 1; failedService.push(serviceLatencyMs); }
      else { completed += 1; successfulService.push(serviceLatencyMs); successfulIntended.push(intendedLatencyMs); readUnits += record.readUnits; writeUnits += record.writeUnits; retries += Math.max(0, record.attempts - 1); }
      progress(record);
    })();
    inFlight.add(task);
    task.finally(() => inFlight.delete(task));
  }
  await Promise.all(inFlight);
  const actualEndEpochMs = Date.now();
  clearInterval(telemetryTimer);
  loopDelay.disable();
  operationsOutput.end(); telemetryOutput.end();
  await Promise.all([new Promise(resolve => operationsOutput.on("finish", resolve)), new Promise(resolve => telemetryOutput.on("finish", resolve))]);
  const elapsedSeconds = config.load.schedule.reduce((sum, step) => sum + step.seconds, 0);
  const summary = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), configName: config.name, configSha256, target, table, consistency: config.workload.consistency,
    startAt: new Date(requestedStart).toISOString(), scheduledStartAt: new Date(requestedStart).toISOString(), scheduledEndAt: new Date(requestedStart + elapsedSeconds * 1000).toISOString(), actualStartAt: new Date(actualStartEpochMs).toISOString(), actualEndAt: new Date(actualEndEpochMs).toISOString(), actualDurationMs: actualEndEpochMs - actualStartEpochMs, startSkewMs: actualStartEpochMs - requestedStart, durationSeconds: elapsedSeconds, shard, logicalScheduled: logicalOperations.length, scheduled: operations.length, completed, failed: Object.values(errors).reduce((sum, value) => sum + value, 0) - schedulerDrops, completionRate: operations.length ? completed / operations.length : 0,
    achievedOperationsPerSecond: elapsedSeconds ? completed / elapsedSeconds : 0, errors, schedulerDrops, retries, workload: { readPercent: config.workload.readPercent, writePercent: config.workload.writePercent, executionMode }, dataset: { keyCount: config.dataset.keyCount, payloadBytes: config.dataset.payloadBytes, logicalItemBytes: canonicalItemSizeBytes(config) },
    successfulServiceLatencyMs: distribution(successfulService), successfulIntendedLatencyMs: distribution(successfulIntended), failedServiceLatencyMs: distribution(failedService), queueDelayMs: distribution(queueDelays),
    concurrency: { executionMode, configuredMaxInflight: config.load.maxInflight, effectiveMaxInflight, observedAtOperationStart: { ...distribution(concurrency), max: peakInflight } },
    client: { cpuUsageMicros: process.cpuUsage(cpuStart), memoryAtEnd: process.memoryUsage(), eventLoopDelayMs: { mean: fixed(loopDelay.mean / 1e6), p95: fixed(loopDelay.percentile(95) / 1e6), p99: fixed(loopDelay.percentile(99) / 1e6), max: fixed(loopDelay.max / 1e6) } },
    consumedCapacity: { readUnits: fixed(readUnits), writeUnits: fixed(writeUnits) }
  };
  summary.accounted = completed + summary.failed + schedulerDrops;
  summary.harnessPassed = summary.accounted === operations.length && schedulerDrops === 0;
  summary.serviceSuccessRate = operations.length ? completed / operations.length : 0;
  summary.passed = summary.harnessPassed;
  fs.writeFileSync(path.join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(output, "run-config.json"), `${JSON.stringify({ config, configSha256, target, table, shard, endpointConfigured: Boolean(process.env.DDB_ENDPOINT) }, null, 2)}\n`);
  return summary;
}
