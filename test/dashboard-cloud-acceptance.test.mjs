import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CloudAcceptanceRuns } from "../src/dashboard/cloud-acceptance.mjs";

const hash = "a".repeat(64);
const input = {
  writeAuthorization: true, artifactBucket: "benchmark-artifacts-123", imageDigest: `ghcr.io/example/runner@sha256:${"b".repeat(64)}`, execution: { mode: "async" },
  infrastructure: { mode: "existing" }, configs: ["smoke.json"], presetRepetitions: { "smoke.json": 1 }, overrides: {},
  targets: {
    aws: { enabled: true, profile: "aws-test", region: "us-east-1", resource: "aws-table", runnerId: "i-012345" },
    adb: { enabled: true, profile: "OCI_TEST", region: "us-ashburn-1", resource: "adb_table", runnerId: "ocid1.instance.test.adb", runnerCompartmentId: "ocid1.compartment.test", evidenceBucket: "adb-evidence" },
    ndcs: { enabled: true, profile: "OCI_NOSQL_TEST", region: "us-ashburn-1", resource: "ndcs_table", runnerId: "ocid1.instance.test.ndcs", runnerCompartmentId: "ocid1.compartment.test", evidenceBucket: "ndcs-evidence", compartmentId: "ocid1.compartment.test" },
  },
};

test("cloud acceptance exposes every preflight, dataset, synchronization, evidence, and packaging stage", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-cloud-test-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = {
    preflight: async () => ({ aws: "Online", adb: "ready", ndcs: "ready" }),
    validateResources: async () => ({ ready: true }),
    stage: async () => [{ stdout: "ok" }, { stdout: "ok" }, { stdout: "ok" }],
    collect: async (spec, action) => {
      for (const target of ["aws", "adb", "ndcs"]) {
        const dir = path.join(spec.localOutput, "evidence", action, target); fs.mkdirSync(dir, { recursive: true });
        if (action === "certify") fs.writeFileSync(path.join(dir, "dataset-certificate.json"), JSON.stringify({ target, observedSha256: hash, passed: true }));
        else fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ target, configSha256: hash, scheduledStartAt: "2026-01-01T00:00:00.000Z", actualStartAt: "2026-01-01T00:00:00.000Z", startSkewMs: 0, scheduled: 20, accounted: 20, completed: 20, failed: 0, harnessPassed: true, successfulServiceLatencyMs: { p95: 1, p99: 2, max: 3 } }));
      }
    },
  };
  const runs = new CloudAcceptanceRuns({ outputRoot: root, adapter }); const started = runs.start(input);
  assert.equal(started.stages.length, 10); let current = started;
  for (let attempt = 0; attempt < 100 && !["complete", "failed"].includes(current.status); attempt += 1) { await new Promise(resolve => setTimeout(resolve, 10)); current = runs.get(started.id); }
  assert.equal(current.status, "complete"); assert.ok(current.stages.every(stage => stage.status === "complete")); assert.equal(current.certificates.aws.observedSha256, hash); assert.equal(current.sessionResults.length, 1); assert.ok(fs.existsSync(runs.download(started.id)));
  assert.ok(current.logs.length >= 20); assert.ok(current.logs.some(item => item.stage === "runner-readiness" && item.level === "success")); assert.ok(current.logs.some(item => item.stage === "workload" && item.target === "aws")); assert.equal(current.logs.at(-1).message, "Benchmark pipeline completed");
  assert.ok(fs.existsSync(path.join(root, started.id, "pipeline-log.ndjson"))); assert.match(fs.readFileSync(path.join(root, started.id, "pipeline-log.ndjson"), "utf8"), /Benchmark pipeline completed/);
  assert.ok(current.logs.some(item => item.stage === "t0-scheduled" && /480s delivery window/.test(item.message)));
  const restored = new CloudAcceptanceRuns({ outputRoot: root, adapter }); const recovered = restored.get(started.id); assert.equal(recovered.status, "complete"); assert.equal(recovered.sessionResults.length, 1); assert.ok(restored.download(started.id));
});

test("cloud adapter source remains platform-neutral", () => {
  const source = fs.readFileSync(new URL("../src/dashboard/cloud-acceptance.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.cmd\b|powershell|[A-Z]:\\\\/i);
  for (const executable of ["aws", "oci"]) assert.match(source, new RegExp(`"${executable}"`));
  assert.doesNotMatch(source, /"ssh"|"scp"|KVS_OCI_SSH_KEY/);
});

test("cloud acceptance can run a single enabled target without requiring OCI settings", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-cloud-single-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = {
    preflight: async spec => ({ aws: spec.enabled.includes("aws") ? "Online" : null }), validateResources: async () => ({ aws: { state: "ACTIVE" } }), stage: async () => [{ stdout: "ok" }],
    collect: async (spec, action) => { const dir = path.join(spec.localOutput, "evidence", action, "aws"); fs.mkdirSync(dir, { recursive: true }); if (action === "certify") fs.writeFileSync(path.join(dir, "dataset-certificate.json"), JSON.stringify({ target: "aws", observedSha256: hash, passed: true })); else fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ target: "aws", configSha256: hash, scheduledStartAt: "2026-01-01T00:00:00.000Z", actualStartAt: "2026-01-01T00:00:00.000Z", startSkewMs: 0, scheduled: 20, accounted: 20, completed: 20, failed: 0, harnessPassed: true, successfulServiceLatencyMs: { p95: 1, p99: 2, max: 3 } })); },
  };
  const single = structuredClone(input); single.targets.adb.enabled = false; single.targets.ndcs.enabled = false;
  const runs = new CloudAcceptanceRuns({ outputRoot: root, adapter }); const started = runs.start(single); let current = started;
  for (let attempt = 0; attempt < 100 && !["complete", "failed"].includes(current.status); attempt += 1) { await new Promise(resolve => setTimeout(resolve, 10)); current = runs.get(started.id); }
  assert.equal(current.status, "complete"); assert.deepEqual(Object.keys(current.targetStatus), ["aws"]); assert.deepEqual(Object.keys(current.summaries), ["aws"]);
});
