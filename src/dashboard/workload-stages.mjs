import fs from "node:fs";
import readline from "node:readline";

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.toSorted((left, right) => left - right);
  return Number(sorted[Math.floor((sorted.length - 1) * fraction)].toFixed(3));
}

export async function summarizeWorkloadStages(file, loadSchedule = []) {
  const stages = loadSchedule.map((step, index) => ({
    index,
    step: index + 1,
    seconds: Number(step.seconds),
    offeredOperationsPerSecond: Number(step.operationsPerSecond),
    accounted: 0,
    completed: 0,
    failed: 0,
    reads: 0,
    writes: 0,
    errors: {},
    successfulLatency: [],
    failedLatency: [],
  }));
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const operation = JSON.parse(line), stage = stages[Number(operation.step) - 1];
    if (!stage) throw new Error(`Operation ${operation.sequence ?? "-"} references unknown load step ${operation.step}`);
    stage.accounted += 1;
    if (operation.operation === "read") stage.reads += 1;
    if (operation.operation === "write") stage.writes += 1;
    if (operation.error == null) {
      stage.completed += 1;
      if (Number.isFinite(Number(operation.serviceLatencyMs))) stage.successfulLatency.push(Number(operation.serviceLatencyMs));
    } else {
      stage.failed += 1;
      const name = operation.error.name || "Error"; stage.errors[name] = Number(stage.errors[name] || 0) + 1;
      if (Number.isFinite(Number(operation.serviceLatencyMs))) stage.failedLatency.push(Number(operation.serviceLatencyMs));
    }
  }
  return stages.map(stage => ({
    index: stage.index,
    step: stage.step,
    seconds: stage.seconds,
    offeredOperationsPerSecond: stage.offeredOperationsPerSecond,
    scheduled: stage.offeredOperationsPerSecond * stage.seconds,
    accounted: stage.accounted,
    completed: stage.completed,
    failed: stage.failed,
    reads: stage.reads,
    writes: stage.writes,
    attemptedOperationsPerSecond: stage.seconds ? stage.accounted / stage.seconds : null,
    successfulOperationsPerSecond: stage.seconds ? stage.completed / stage.seconds : null,
    serviceSuccessRate: stage.accounted ? stage.completed / stage.accounted : null,
    errors: stage.errors,
    successfulServiceLatencyMs: {
      samples: stage.successfulLatency.length,
      p50: percentile(stage.successfulLatency, 0.5),
      p95: percentile(stage.successfulLatency, 0.95),
      p99: percentile(stage.successfulLatency, 0.99),
      max: stage.successfulLatency.length ? stage.successfulLatency.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : null,
    },
    failedServiceLatencyMs: {
      samples: stage.failedLatency.length,
      p50: percentile(stage.failedLatency, 0.5),
      p95: percentile(stage.failedLatency, 0.95),
      p99: percentile(stage.failedLatency, 0.99),
      max: stage.failedLatency.length ? stage.failedLatency.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : null,
    },
  }));
}

export async function writeWorkloadStageSummary(directory, loadSchedule) {
  const summary = await summarizeWorkloadStages(`${directory}/operations.ndjson`, loadSchedule);
  fs.writeFileSync(`${directory}/stage-summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}
