import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { canonicalKey } from "./workload.mjs";
import { errorEvidence } from "./errors.mjs";
import { distribution } from "./statistics.mjs";
import { normalizeShardOptions } from "./sharding.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const fixed = value => Number(value.toFixed(3));

export function canonicalRecord(config, index, version = 1) {
  return { ...canonicalKey(index, config.dataset.partitionBuckets), version, payload: "x".repeat(config.dataset.payloadBytes) };
}

export function canonicalItemSizeBytes(config, index = Math.max(0, Number(config.dataset.keyCount || 1) - 1), version = 1) {
  return Buffer.byteLength(JSON.stringify(canonicalRecord(config, index, version)), "utf8");
}

export function canonicalLine(record) {
  return `${JSON.stringify({ pk: record.pk, sk: record.sk, version: record.version, payload: record.payload })}\n`;
}

export function expectedDatasetSha256(config) {
  const hash = crypto.createHash("sha256");
  for (let index = 0; index < config.dataset.keyCount; index += 1) hash.update(canonicalLine(canonicalRecord(config, index)));
  return hash.digest("hex");
}

function retryablePreloadError(error) {
  const status = Number(error?.$metadata?.httpStatusCode ?? error?.statusCode);
  return status === 429 || status >= 500 || Boolean(error?.$retryable);
}

async function rateLimitedMap({ count, rate, maxInflight, operation }) {
  const results = new Array(count);
  const inFlight = new Set();
  const start = performance.now();
  for (let index = 0; index < count; index += 1) {
    const wait = start + index * 1000 / rate - performance.now();
    if (wait > 0) await sleep(wait);
    while (inFlight.size >= maxInflight) await Promise.race(inFlight);
    const task = operation(index).then(result => { results[index] = result; });
    inFlight.add(task); task.finally(() => inFlight.delete(task));
  }
  await Promise.all(inFlight);
  return results;
}

export async function preloadDataset({ config, configSha256, provider, target, table, output, rate = 50, maxInflight = 64, maxWriteAttempts = 1, retryDelayMs = 250, startAt = null, shardCount = 1, shardIndex = 0 }) {
  fs.mkdirSync(output, { recursive: true });
  const shard = normalizeShardOptions({ shardCount, shardIndex });
  const indices = [];
  for (let index = shard.index; index < config.dataset.keyCount; index += shard.count) indices.push(index);
  const scheduledStartAt = startAt ? new Date(startAt).toISOString() : null;
  if (scheduledStartAt) await sleep(new Date(scheduledStartAt).getTime() - Date.now());
  const startedAt = new Date().toISOString(); const started = performance.now();
  const results = await rateLimitedMap({ count: indices.length, rate, maxInflight, operation: async localIndex => {
    const index = indices[localIndex];
    const record = canonicalRecord(config, index); const started = performance.now();
    const transientErrors = [];
    for (let attempt = 1; attempt <= maxWriteAttempts; attempt += 1) {
      try {
        const result = await provider.write({ pk: record.pk, sk: record.sk }, record.version);
        return { index, latencyMs: fixed(performance.now() - started), writeUnits: result.writeUnits || 0, attempts: attempt, transientErrors, error: null };
      } catch (error) {
        const evidence = errorEvidence(error);
        if (attempt >= maxWriteAttempts || !retryablePreloadError(error)) return { index, latencyMs: fixed(performance.now() - started), writeUnits: 0, attempts: attempt, transientErrors, error: evidence };
        transientErrors.push({ attempt, error: evidence });
        await sleep(Math.min(5_000, retryDelayMs * 2 ** (attempt - 1)));
      }
    }
  }});
  const durationMs = fixed(performance.now() - started); const durationSeconds = fixed(durationMs / 1000);
  const failures = results.filter(result => result.error);
  fs.writeFileSync(path.join(output, "preload-operations.ndjson"), `${results.map(JSON.stringify).join("\n")}\n`);
  const completed = results.length - failures.length;
  const summary = { schemaVersion: 2, target, table, configName: config.name, configSha256, scheduledStartAt, actualStartAt: startedAt, startSkewMs: scheduledStartAt ? new Date(startedAt).getTime() - new Date(scheduledStartAt).getTime() : null, startedAt, endedAt: new Date().toISOString(), durationMs, durationSeconds, requested: results.length, logicalRequested: config.dataset.keyCount, completed, failures: failures.length, passed: failures.length === 0, shard, dataset: { keyCount: config.dataset.keyCount, payloadBytes: config.dataset.payloadBytes, logicalItemBytes: canonicalItemSizeBytes(config) }, requestedOperationsPerSecond: rate, attemptedOperationsPerSecond: durationSeconds ? fixed(results.length / durationSeconds) : null, successfulOperationsPerSecond: durationSeconds ? fixed(completed / durationSeconds) : null, rate, maxInflight, maxWriteAttempts, retryDelayMs, latencyMs: distribution(results.filter(x => !x.error).map(x => x.latencyMs)), attempts: results.reduce((sum, x) => sum + x.attempts, 0), retryCount: results.reduce((sum, x) => sum + Math.max(0, x.attempts - 1), 0), writeUnits: fixed(results.reduce((sum, x) => sum + x.writeUnits, 0)), errors: Object.fromEntries(Object.entries(failures.reduce((map, x) => { map[x.error.name] = (map[x.error.name] || 0) + 1; return map; }, {})).sort()) };
  fs.writeFileSync(path.join(output, "preload-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

export async function certifyDataset({ config, configSha256, provider, target, table, output, rate = 25, maxInflight = 64, maxReadAttempts = 3, retryDelayMs = 250 }) {
  fs.mkdirSync(output, { recursive: true });
  const expectedSha256 = expectedDatasetSha256(config); const startedAt = new Date().toISOString();
  const results = await rateLimitedMap({ count: config.dataset.keyCount, rate, maxInflight, operation: async index => {
    const started = performance.now(); const transientErrors = [];
    for (let attempt = 1; attempt <= maxReadAttempts; attempt += 1) {
      try { const result = await provider.read(canonicalKey(index, config.dataset.partitionBuckets)); return { index, record: { ...result.key, version: result.version, payload: result.payload }, latencyMs: fixed(performance.now() - started), readUnits: result.readUnits || 0, attempts: attempt, transientErrors, error: null }; }
      catch (error) {
        const evidence = errorEvidence(error);
        if (error?.name === "CorrectnessMismatch" || attempt === maxReadAttempts) return { index, record: null, latencyMs: fixed(performance.now() - started), readUnits: 0, attempts: attempt, transientErrors, error: evidence };
        transientErrors.push({ attempt, error: evidence });
        await sleep(retryDelayMs * attempt);
      }
    }
  }});
  const observedHash = crypto.createHash("sha256");
  for (const result of results) observedHash.update(result.record ? canonicalLine(result.record) : `${result.index}:READ_ERROR\n`);
  const observedSha256 = observedHash.digest("hex"); const mismatches = results.filter(result => result.error);
  fs.writeFileSync(path.join(output, "audit-operations.ndjson"), `${results.map(result => JSON.stringify({ index: result.index, pk: result.record?.pk ?? null, sk: result.record?.sk ?? null, version: result.record?.version ?? null, latencyMs: result.latencyMs, readUnits: result.readUnits, attempts: result.attempts, transientErrors: result.transientErrors, error: result.error })).join("\n")}\n`);
  const certificate = { schemaVersion: 1, target, table, configName: config.name, configSha256, consistency: "strong", startedAt, endedAt: new Date().toISOString(), keyCount: config.dataset.keyCount, payloadBytes: config.dataset.payloadBytes, logicalItemBytes: canonicalItemSizeBytes(config), partitionBuckets: config.dataset.partitionBuckets, expectedSha256, observedSha256, mismatchCount: mismatches.length, passed: mismatches.length === 0 && observedSha256 === expectedSha256, rate, maxInflight, maxReadAttempts, retryCount: results.reduce((sum, x) => sum + Math.max(0, x.attempts - 1), 0), latencyMs: distribution(results.filter(x => !x.error).map(x => x.latencyMs)), readUnits: fixed(results.reduce((sum, x) => sum + x.readUnits, 0)), mismatches: mismatches.slice(0, 100).map(x => ({ index: x.index, error: x.error })) };
  fs.writeFileSync(path.join(output, "dataset-certificate.json"), `${JSON.stringify(certificate, null, 2)}\n`);
  return certificate;
}
