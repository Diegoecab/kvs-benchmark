import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CliCloudAdapter, CloudAcceptanceRuns } from "../src/dashboard/cloud-acceptance.mjs";
import { writeStateAtomic } from "../src/dashboard/file-state.mjs";

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
  assert.equal(runs.list().length, 1); assert.equal(runs.list()[0].id, started.id); assert.equal(runs.list()[0].completedSessions, 1);
  assert.ok(current.logs.length >= 20); assert.ok(current.logs.some(item => item.stage === "runner-readiness" && item.level === "success")); assert.ok(current.logs.some(item => item.stage === "workload" && item.target === "aws")); assert.equal(current.logs.at(-1).message, "Benchmark pipeline completed");
  assert.ok(fs.existsSync(path.join(root, started.id, "pipeline-log.ndjson"))); assert.match(fs.readFileSync(path.join(root, started.id, "pipeline-log.ndjson"), "utf8"), /Benchmark pipeline completed/);
  const packagedState = JSON.parse(fs.readFileSync(path.join(root, started.id, "run-state.json"), "utf8"));
  assert.equal(packagedState.status, "complete"); assert.equal(packagedState.stages.find(stage => stage.name === "package-generation").status, "complete"); assert.equal(packagedState.logs.at(-1).message, "Benchmark pipeline completed");
  assert.ok(current.logs.some(item => item.stage === "t0-scheduled" && /900s delivery window/.test(item.message)));
  const restored = new CloudAcceptanceRuns({ outputRoot: root, adapter }); const recovered = restored.get(started.id); assert.equal(recovered.status, "complete"); assert.equal(recovered.sessionResults.length, 1); assert.ok(restored.download(started.id));
});

test("cloud adapter source remains platform-neutral", () => {
  const source = fs.readFileSync(new URL("../src/dashboard/cloud-acceptance.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.cmd\b|powershell|[A-Z]:\\\\/i);
  for (const executable of ["aws", "oci"]) assert.match(source, new RegExp(`"${executable}"`));
  assert.doesNotMatch(source, /"ssh"|"scp"|KVS_OCI_SSH_KEY/);
  assert.ok((source.match(/\/app\/results:z/g) || []).length >= 2, "OCI workload and evidence uploader must share the SELinux label");
  assert.match(source, /runtimeArguments\(spec, session, \{ workload: isRun \}\)/);
  assert.match(source, /datasetOptions = new Set\(\["consistency"\]\)/);
  assert.match(source, /uploader_pid=\$!\\nset \+e\\n\(\\n\$\{guardedInvocation\}\\n\)\\ncode=\$\?/);
  assert.doesNotMatch(source, /AWS_REGION=us-ashburn-1/);
  assert.match(source, /AWS_REGION=\$\{spec\.adbOciRegion\}/);
  assert.match(source, /podman pull/);
  assert.match(source, /\.adb-admin-password/);
  assert.match(source, /KVS_REQUIRED_SECONDS/);
  assert.match(source, /expiration_minutes:5256000/);
  assert.match(source, /Automatically renewed table-scoped benchmark credential/);
  assert.match(source, /awk '\/\^\\\\\{\.\*\\\\\}\$\//);
  assert.doesNotMatch(source, /completed=\$\(grep -c/);
  assert.match(source, /startDelayMs \+ workloadMs \+ 15 \* 60_000/);
  assert.doesNotMatch(source, /attempt < 450/);
});

test("AWS polling tolerates a transient local control-plane failure", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-cloud-poll-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let polls = 0;
  const execute = async (_file, args) => {
    if (args[1] === "send-command") return "command-123\n";
    if (args[1] === "get-command-invocation") {
      polls += 1;
      if (polls === 1) throw new Error("temporary network failure");
      return JSON.stringify({ Status: "Success", StandardOutputContent: "done" });
    }
    throw new Error(`unexpected command ${args.join(" ")}`);
  };
  const adapter = new CliCloudAdapter({ execute });
  const result = await adapter.aws({ runId: "poll-test", localOutput: root, awsProfile: "test", awsRegion: "us-east-1", awsRunner: "i-test", image: input.imageDigest, awsTable: "table", bucket: "bucket", overrides: {}, matrix: [] }, "preflight", "/tmp/preflight", null);
  assert.equal(result.stdout, "done"); assert.equal(polls, 2);
});

test("service errors remain benchmark results when every operation is accounted", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-cloud-errors-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = {
    preflight: async () => ({ ready: true }), validateResources: async () => ({ ready: true }),
    stage: async (_spec, action) => { if (action.startsWith("run/")) throw new Error("ADB runner returned exit code 1"); return [{ stdout: "ok" }]; },
    collect: async (spec, action) => { for (const target of spec.enabled) { const dir = path.join(spec.localOutput, "evidence", action, target); fs.mkdirSync(dir, { recursive: true }); if (action === "certify") fs.writeFileSync(path.join(dir, "dataset-certificate.json"), JSON.stringify({ target, observedSha256: hash, passed: true })); else fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ target, configSha256: hash, scheduledStartAt: "2026-01-01T00:00:00.000Z", actualStartAt: "2026-01-01T00:00:00.000Z", startSkewMs: 0, scheduled: 20, accounted: 20, completed: target === "adb" ? 15 : 20, failed: target === "adb" ? 5 : 0, harnessPassed: true, successfulServiceLatencyMs: { p95: 1, p99: 2, max: 3 } })); } },
  };
  const runs = new CloudAcceptanceRuns({ outputRoot: root, adapter }); const started = runs.start(input); let current = started;
  for (let attempt = 0; attempt < 100 && !["complete", "failed"].includes(current.status); attempt += 1) { await new Promise(resolve => setTimeout(resolve, 10)); current = runs.get(started.id); }
  assert.equal(current.status, "complete"); assert.equal(current.sessionResults[0].summaries.adb.failed, 5);
  assert.match(current.stages.find(stage => stage.name === "acceptance-validation").detail, /"serviceFailures":5/);
});

test("a failed workload checkpoint recovers its final evidence and resumes without repeating prerequisites", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-cloud-resume-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let recoverEvidence = false, sharedStartAt = null, preflights = 0;
  const adapter = {
    preflight: async () => { preflights += 1; return { ready: true }; }, validateResources: async () => ({ ready: true }),
    stage: async (_spec, action, startAt) => { if (action.startsWith("run/")) { sharedStartAt = startAt; throw new Error("polling interrupted"); } return [{ stdout: "ok" }]; },
    collect: async (spec, action) => { for (const target of spec.enabled) { const dir = path.join(spec.localOutput, "evidence", action, target); fs.mkdirSync(dir, { recursive: true }); if (action === "certify") fs.writeFileSync(path.join(dir, "dataset-certificate.json"), JSON.stringify({ target, observedSha256: hash, passed: true })); else if (recoverEvidence || target !== "adb") fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ target, configSha256: hash, scheduledStartAt: sharedStartAt, actualStartAt: sharedStartAt, startSkewMs: 0, scheduled: 20, accounted: 20, completed: 20, failed: 0, harnessPassed: true, successfulServiceLatencyMs: { p95: 1, p99: 2, max: 3 } })); } },
  };
  const runs = new CloudAcceptanceRuns({ outputRoot: root, adapter }); const started = runs.start(input); let current = started;
  for (let attempt = 0; attempt < 100 && current.status !== "failed"; attempt += 1) { await new Promise(resolve => setTimeout(resolve, 10)); current = runs.get(started.id); }
  assert.equal(current.status, "failed"); assert.equal(current.canResume, true); assert.equal(preflights, 1);
  recoverEvidence = true; runs.resume(started.id);
  for (let attempt = 0; attempt < 100 && current.status !== "complete"; attempt += 1) { await new Promise(resolve => setTimeout(resolve, 10)); current = runs.get(started.id); }
  assert.equal(current.status, "complete"); assert.equal(current.sessionResults.length, 1); assert.equal(preflights, 1);
  assert.ok(current.logs.some(item => /Recovered session/.test(item.message)));
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

test("optional preload measurement synchronizes targets and packages comparable summaries", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-cloud-preload-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = [];
  const adapter = {
    preflight: async () => ({ aws: "Online" }), validateResources: async () => ({ ready: true }),
    stage: async (spec, action, startAt) => { staged.push({ action, startAt, rate: spec.preloadRate, maxInflight: spec.preloadMaxInflight }); return spec.enabled.map(() => ({ stdout: "ok" })); },
    collect: async (spec, action) => {
      for (const target of spec.enabled) {
        const dir = path.join(spec.localOutput, "evidence", action, target); fs.mkdirSync(dir, { recursive: true });
        if (action === "preload") fs.writeFileSync(path.join(dir, "preload-summary.json"), JSON.stringify({ target, actualStartAt: "2026-01-01T00:00:00.001Z", startSkewMs: 1, requested: 10_000, completed: 10_000, failures: 0, successfulOperationsPerSecond: 399.5, latencyMs: { p95: 4, p99: 7 }, writeUnits: 10_000 }));
        else if (action === "certify") fs.writeFileSync(path.join(dir, "dataset-certificate.json"), JSON.stringify({ target, observedSha256: hash, passed: true }));
        else fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ target, configSha256: hash, scheduledStartAt: "2026-01-01T00:00:00.000Z", actualStartAt: "2026-01-01T00:00:00.000Z", startSkewMs: 0, scheduled: 20, accounted: 20, completed: 20, failed: 0, harnessPassed: true, successfulServiceLatencyMs: { p95: 1, p99: 2, max: 3 } }));
      }
    },
  };
  const measured = structuredClone(input); measured.execution = { mode: "async", capturePreloadMetrics: true, preloadRate: 400, preloadMaxInflight: 128 };
  const runs = new CloudAcceptanceRuns({ outputRoot: root, adapter }); const started = runs.start(measured); let current = started;
  for (let attempt = 0; attempt < 100 && !["complete", "failed"].includes(current.status); attempt += 1) { await new Promise(resolve => setTimeout(resolve, 10)); current = runs.get(started.id); }
  assert.equal(current.status, "complete");
  const preload = staged.find(item => item.action === "preload");
  assert.match(preload.startAt, /^\d{4}-\d{2}-\d{2}T/); assert.equal(preload.rate, 400); assert.equal(preload.maxInflight, 128);
  assert.equal(current.preloadSummaries.aws.successfulOperationsPerSecond, 399.5);
  assert.match(fs.readFileSync(path.join(root, started.id, "index.html"), "utf8"), /Canonical preload performance/);
});

test("dashboard attaches read-only to an externally controlled active run and refreshes its state", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-cloud-attach-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "cloud-external-active", output = path.join(root, id);
  const state = { id, output, outputRelative: `.kvs/cloud-runs/${id}`, spec: { mode: "live", matrix: [] }, status: "running", createdAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:01.000Z", stages: [{ name: "workload", status: "running" }], targetStatus: { aws: "running" }, targetMetrics: { aws: { completed: 10, scheduled: 100, failed: 0 } }, sessionResults: [], logs: [] };
  writeStateAtomic(output, state);
  const observer = new CloudAcceptanceRuns({ outputRoot: root, adapter: {} });
  assert.equal(observer.active().status, "running");
  assert.equal(observer.active().targetMetrics.aws.completed, 10);
  writeStateAtomic(output, { ...state, targetMetrics: { aws: { completed: 25, scheduled: 100, failed: 0 } } });
  assert.equal(observer.get(id).targetMetrics.aws.completed, 25);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, ".dashboard-state.json"), "utf8")).status, "running");
});
