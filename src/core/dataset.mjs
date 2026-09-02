import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { canonicalKey } from "./workload.mjs";
import { errorEvidence } from "./errors.mjs";
import { distribution } from "./statistics.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const fixed = value => Number(value.toFixed(3));

export function canonicalRecord(config, index, version = 1) {
  return { ...canonicalKey(index, config.dataset.partitionBuckets), version, payload: "x".repeat(config.dataset.payloadBytes) };
}

export function canonicalLine(record) {
  return `${JSON.stringify({ pk: record.pk, sk: record.sk, version: record.version, payload: record.payload })}\n`;
}

export function expectedDatasetSha256(config) {
  const hash = crypto.createHash("sha256");
  for (let index = 0; index < config.dataset.keyCount; index += 1) hash.update(canonicalLine(canonicalRecord(config, index)));
  return hash.digest("hex");
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

export async function preloadDataset({ config, configSha256, provider, target, table, output, rate = 50, maxInflight = 64 }) {
  fs.mkdirSync(output, { recursive: true });
  const startedAt = new Date().toISOString();
  const results = await rateLimitedMap({ count: config.dataset.keyCount, rate, maxInflight, operation: async index => {
    const record = canonicalRecord(config, index); const started = performance.now();
    try { const result = await provider.write({ pk: record.pk, sk: record.sk }, record.version); return { index, latencyMs: fixed(performance.now() - started), writeUnits: result.writeUnits || 0, attempts: result.attempts || 1, error: null }; }
    catch (error) { return { index, latencyMs: fixed(performance.now() - started), writeUnits: 0, attempts: error?.$metadata?.attempts || 1, error: errorEvidence(error) }; }
  }});
  const failures = results.filter(result => result.error);
  fs.writeFileSync(path.join(output, "preload-operations.ndjson"), `${results.map(JSON.stringify).join("\n")}\n`);
  const summary = { schemaVersion: 1, target, table, configName: config.name, configSha256, startedAt, endedAt: new Date().toISOString(), requested: results.length, completed: results.length - failures.length, failures: failures.length, passed: failures.length === 0, rate, maxInflight, latencyMs: distribution(results.filter(x => !x.error).map(x => x.latencyMs)), writeUnits: fixed(results.reduce((sum, x) => sum + x.writeUnits, 0)), errors: Object.fromEntries(Object.entries(failures.reduce((map, x) => { map[x.error.name] = (map[x.error.name] || 0) + 1; return map; }, {})).sort()) };
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
  const certificate = { schemaVersion: 1, target, table, configName: config.name, configSha256, consistency: "strong", startedAt, endedAt: new Date().toISOString(), keyCount: config.dataset.keyCount, payloadBytes: config.dataset.payloadBytes, partitionBuckets: config.dataset.partitionBuckets, expectedSha256, observedSha256, mismatchCount: mismatches.length, passed: mismatches.length === 0 && observedSha256 === expectedSha256, rate, maxInflight, maxReadAttempts, retryCount: results.reduce((sum, x) => sum + Math.max(0, x.attempts - 1), 0), latencyMs: distribution(results.filter(x => !x.error).map(x => x.latencyMs)), readUnits: fixed(results.reduce((sum, x) => sum + x.readUnits, 0)), mismatches: mismatches.slice(0, 100).map(x => ({ index: x.index, error: x.error })) };
  fs.writeFileSync(path.join(output, "dataset-certificate.json"), `${JSON.stringify(certificate, null, 2)}\n`);
  return certificate;
}
