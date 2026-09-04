import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { certifyDataset } from "../src/core/dataset.mjs";

const config = { name: "certification-test", dataset: { keyCount: 2, payloadBytes: 8, partitionBuckets: 2 } };

test("dataset certification retries transport errors without changing workload retry semantics", async t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-certify-")); t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  let calls = 0;
  const provider = { read: async key => { calls += 1; if (calls === 1) throw Object.assign(new SyntaxError("transient HTML response"), { statusCode: 502 }); return { key, version: 1, payload: "x".repeat(config.dataset.payloadBytes), readUnits: 1 }; } };
  const certificate = await certifyDataset({ config, configSha256: "a".repeat(64), provider, target: "adb", table: "table", output, rate: 1000, maxInflight: 1, maxReadAttempts: 2, retryDelayMs: 0 });
  assert.equal(certificate.passed, true); assert.equal(certificate.retryCount, 1); assert.equal(certificate.mismatchCount, 0);
  const audit = fs.readFileSync(path.join(output, "audit-operations.ndjson"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(audit[0].attempts, 2); assert.equal(audit[0].transientErrors.length, 1); assert.equal(audit[0].error, null);
});

test("dataset certification never retries a correctness mismatch", async t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-certify-")); t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  let calls = 0;
  const provider = { read: async () => { calls += 1; throw Object.assign(new Error("bad canonical value"), { name: "CorrectnessMismatch" }); } };
  const certificate = await certifyDataset({ config: { ...config, dataset: { ...config.dataset, keyCount: 1 } }, configSha256: "b".repeat(64), provider, target: "adb", table: "table", output, rate: 1000, maxInflight: 1, maxReadAttempts: 3, retryDelayMs: 0 });
  assert.equal(certificate.passed, false); assert.equal(certificate.retryCount, 0); assert.equal(calls, 1);
});

test("dataset certification keeps large payloads outside the retained result set", t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-certify-large-")); t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const moduleUrl = new URL("../src/core/dataset.mjs", import.meta.url).href;
  const script = `import { certifyDataset } from ${JSON.stringify(moduleUrl)};const config={name:"large-certification-test",dataset:{keyCount:750,payloadBytes:100000,partitionBuckets:64}};const provider={read:async key=>({key,version:1,payload:Buffer.alloc(config.dataset.payloadBytes,120).toString("utf8"),readUnits:1})};const result=await certifyDataset({config,configSha256:"c".repeat(64),provider,target:"mock",table:"table",output:${JSON.stringify(output)},rate:100000,maxInflight:64,maxReadAttempts:1,retryDelayMs:0});if(!result.passed)process.exit(2);`;
  const result = spawnSync(process.execPath, ["--max-old-space-size=64", "--input-type=module", "--eval", script], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
