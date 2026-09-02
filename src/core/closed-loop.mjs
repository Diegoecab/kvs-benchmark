import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { canonicalKey, operationForSequence } from "./workload.mjs";
import { errorEvidence } from "./errors.mjs";
import { distribution } from "./statistics.mjs";
import { RunnerHealthSampler } from "./runner-health.mjs";
import { normalizeShardOptions } from "./sharding.mjs";
import { canonicalItemSizeBytes } from "./dataset.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const fixed = value => Number(value.toFixed(3));

export async function runClosedLoop({ config, configSha256, provider, target, table, output, startAt, shardCount = 1, shardIndex = 0 }) {
  if (config.load.model !== "closed-loop" || !config.load.fixedConcurrency) throw new Error("runClosedLoop requires fixedConcurrency");
  const shard = normalizeShardOptions({ shardCount, shardIndex });
  if (shard.count > config.load.fixedConcurrency) throw new Error("shardCount cannot exceed fixedConcurrency for a closed-loop workload");
  const workerIds = Array.from({ length: config.load.fixedConcurrency }, (_, index) => index + 1).filter(workerId => (workerId - 1) % shard.count === shard.index);
  fs.mkdirSync(output, { recursive: true });
  const operationsOutput = fs.createWriteStream(path.join(output, "operations.ndjson"), { encoding: "utf8" });
  const telemetryOutput = fs.createWriteStream(path.join(output, "telemetry.ndjson"), { encoding: "utf8" });
  const requestedStart = startAt ? Date.parse(startAt) : Date.now() + 2000;
  if (!Number.isFinite(requestedStart)) throw new Error("invalid --start-at");
  if (startAt && requestedStart < Date.now()) throw new Error("--start-at must be in the future");
  const durationSeconds = config.load.durationSeconds;
  const scheduledEndEpochMs = requestedStart + durationSeconds * 1000;
  const successfulService = [], failedService = [], concurrency = [];
  const errors = {};
  let completed = 0, failed = 0, active = 0, peakInflight = 0, readUnits = 0, writeUnits = 0, retries = 0;
  const cpuStart = process.cpuUsage();
  const loopDelay = monitorEventLoopDelay({ resolution: 10 }); loopDelay.enable();
  const runnerHealth = new RunnerHealthSampler();
  const telemetryTimer = setInterval(() => {
    concurrency.push(active);
    telemetryOutput.write(`${JSON.stringify({ at: new Date().toISOString(), inFlight: active, rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed, runner: runnerHealth.sample() })}\n`);
  }, config.load.telemetryIntervalMs);

  if (requestedStart > Date.now()) await sleep(requestedStart - Date.now());
  const actualStartEpochMs = Date.now();
  const worker = async workerId => {
    let workerSequence = 0;
    while (Date.now() < scheduledEndEpochMs) {
      const sequence = workerId - 1 + workerSequence * config.load.fixedConcurrency;
      workerSequence += 1;
      const operation = { ...operationForSequence(config, sequence), workerId, offeredRate: null };
      const startedPerf = performance.now(), startedEpochMs = Date.now();
      active += 1; peakInflight = Math.max(peakInflight, active); concurrency.push(active);
      let result = null, error = null;
      try {
        const key = canonicalKey(operation.keyIndex, config.dataset.partitionBuckets);
        const writeVersion = config.workload.writeMode === "idempotent" ? 1 : config.dataset.seed * 1_000_000 + operation.sequence;
        result = operation.operation === "read" ? await provider.read(key) : await provider.write(key, writeVersion);
      } catch (caught) { error = errorEvidence(caught); }
      const endedEpochMs = Date.now(), serviceLatencyMs = performance.now() - startedPerf;
      active -= 1;
      const record = { ...operation, scheduledEpochMs: startedEpochMs, startedEpochMs, endedEpochMs, queueDelayMs: 0, serviceLatencyMs: fixed(serviceLatencyMs), intendedLatencyMs: fixed(serviceLatencyMs), inFlightAtStart: active + 1, attempts: result?.attempts ?? error?.attempts ?? 1, readUnits: result?.readUnits || 0, writeUnits: result?.writeUnits || 0, rateLimitDelayMs: result?.rateLimitDelayMs || 0, error };
      operationsOutput.write(`${JSON.stringify(record)}\n`);
      if (error) { failed += 1; errors[error.name] = (errors[error.name] || 0) + 1; failedService.push(serviceLatencyMs); }
      else { completed += 1; successfulService.push(serviceLatencyMs); readUnits += record.readUnits; writeUnits += record.writeUnits; retries += Math.max(0, record.attempts - 1); }
    }
  };
  await Promise.all(workerIds.map(worker));
  const actualEndEpochMs = Date.now();
  clearInterval(telemetryTimer); loopDelay.disable(); operationsOutput.end(); telemetryOutput.end();
  await Promise.all([new Promise(resolve => operationsOutput.on("finish", resolve)), new Promise(resolve => telemetryOutput.on("finish", resolve))]);
  const attempted = completed + failed, actualDurationSeconds = (actualEndEpochMs - actualStartEpochMs) / 1000;
  const summary = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), configName: config.name, configSha256, target, table, consistency: config.workload.consistency, loadModel: "closed-loop",
    startAt: new Date(requestedStart).toISOString(), scheduledStartAt: new Date(requestedStart).toISOString(), scheduledEndAt: new Date(scheduledEndEpochMs).toISOString(), actualStartAt: new Date(actualStartEpochMs).toISOString(), actualEndAt: new Date(actualEndEpochMs).toISOString(), actualDurationMs: actualEndEpochMs - actualStartEpochMs, startSkewMs: actualStartEpochMs - requestedStart, durationSeconds, shard: { ...shard, workerIds, logicalConcurrency: config.load.fixedConcurrency },
    scheduled: attempted, attempted, completed, failed, accounted: attempted, completionRate: attempted ? completed / attempted : 0, serviceSuccessRate: attempted ? completed / attempted : 0, achievedOperationsPerSecond: actualDurationSeconds ? completed / actualDurationSeconds : 0,
    errors, schedulerDrops: 0, retries, workload: { readPercent: config.workload.readPercent, writePercent: config.workload.writePercent, writeMode: config.workload.writeMode || null, executionMode: "fixed-concurrency" }, dataset: { keyCount: config.dataset.keyCount, payloadBytes: config.dataset.payloadBytes, logicalItemBytes: canonicalItemSizeBytes(config) },
    successfulServiceLatencyMs: distribution(successfulService), successfulIntendedLatencyMs: distribution(successfulService), failedServiceLatencyMs: distribution(failedService), queueDelayMs: { samples: attempted, p50: 0, p95: 0, p99: 0, p999: 0, max: 0 },
    concurrency: { executionMode: "fixed-concurrency", configuredMaxInflight: config.load.fixedConcurrency, effectiveMaxInflight: workerIds.length, targetConcurrency: workerIds.length, globalTargetConcurrency: config.load.fixedConcurrency, observedAtOperationStart: { ...distribution(concurrency), max: peakInflight } },
    client: { cpuUsageMicros: process.cpuUsage(cpuStart), memoryAtEnd: process.memoryUsage(), eventLoopDelayMs: { mean: fixed(loopDelay.mean / 1e6), p95: fixed(loopDelay.percentile(95) / 1e6), p99: fixed(loopDelay.percentile(99) / 1e6), max: fixed(loopDelay.max / 1e6) } },
    consumedCapacity: { readUnits: fixed(readUnits), writeUnits: fixed(writeUnits) }, harnessPassed: attempted > 0, passed: attempted > 0
  };
  fs.writeFileSync(path.join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(output, "run-config.json"), `${JSON.stringify({ config, configSha256, target, table, shard: summary.shard, endpointConfigured: Boolean(process.env.DDB_ENDPOINT) }, null, 2)}\n`);
  return summary;
}
