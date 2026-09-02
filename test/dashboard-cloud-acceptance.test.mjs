import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { aggregateProgressSources, aggregateTargetEvidence, CliCloudAdapter, CloudAcceptanceRuns, remoteScript, validateCloudSpecification } from "../src/dashboard/cloud-acceptance.mjs";
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

test("one global load-generator count is enforced for every target", () => {
  const distributed = structuredClone(input);
  distributed.execution.loadGeneratorCount = 3;
  distributed.targets.aws.runners = ["i-111111", "i-222222", "i-333333"].map((id, index) => ({ id, privateIp: `10.0.0.${index + 1}` }));
  distributed.targets.adb.runners = [1, 2, 3].map(index => ({ id: `ocid1.instance.test.adb${index}`, compartmentId: "ocid1.compartment.test", privateIp: `10.0.1.${index}` }));
  distributed.targets.ndcs.runners = [1, 2, 3].map(index => ({ id: `ocid1.instance.test.ndcs${index}`, compartmentId: "ocid1.compartment.test", privateIp: `10.0.2.${index}` }));
  const spec = validateCloudSpecification(distributed);
  assert.equal(spec.loadGeneratorCount, 3); assert.equal(spec.awsRunners.length, 3); assert.equal(spec.adbRunners.length, 3); assert.equal(spec.ndcsRunners.length, 3);
  assert.deepEqual(spec.awsRunners[0], { id: "i-111111", displayName: null, privateIp: "10.0.0.1", publicIp: null, egressIp: null, egressIpVerified: false, availabilityDomain: null, shape: null, vcpus: null, memoryGB: null, networkMode: null });
  distributed.targets.ndcs.runners.pop();
  assert.throws(() => validateCloudSpecification(distributed), /OCI NoSQL requires exactly 3 distinct runner VM/);
});

test("workload stage fans out to every target runner and passes deterministic shard options", async () => {
  const calls = [], adapter = new CliCloudAdapter();
  adapter.aws = async (_spec, action, output, _startAt, _session, runner, index, count) => { calls.push({ target: "aws", action, output, runner: runner.id, index, count }); };
  adapter.oci = async (_spec, target, action, output, _startAt, _session, runner, index, count) => { calls.push({ target, action, output, runner: runner.id, index, count }); };
  const runners = prefix => [0, 1, 2].map(index => ({ id: prefix === "aws" ? `i-${index + 1}` : `ocid1.instance.${prefix}${index + 1}`, compartmentId: "ocid1.compartment.test" }));
  const spec = { runId: "distributed", enabled: ["aws", "adb", "ndcs"], awsRunners: runners("aws"), adbRunners: runners("adb"), ndcsRunners: runners("ndcs"), matrix: [{ id: "smoke-r1", scheduledOperationsPerTarget: 10 }] };
  await adapter.stage(spec, "run/smoke-r1", "2026-01-01T00:00:00.000Z", spec.matrix[0]);
  assert.equal(calls.length, 9); assert.deepEqual(new Set(calls.map(call => call.count)), new Set([3])); assert.deepEqual(new Set(calls.map(call => call.index)), new Set([0, 1, 2])); assert.ok(calls.every(call => /sources\/source-0[1-3]$/.test(call.output.replaceAll("\\", "/"))));
  const script = remoteScript({ ...spec, image: input.imageDigest, adbTable: "table", adbBucket: "bucket", adbOciRegion: "us-ashburn-1", overrides: {} }, "adb", "run/smoke-r1", "/tmp/run", "2026-01-01T00:00:00.000Z", spec.matrix[0], { index: 1, count: 3 });
  assert.match(script, /--shard-count=3 --shard-index=1/); assert.match(script, /sources\/source-02/);
});

test("per-runner evidence is preserved and aggregated into one target result", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-cloud-aggregate-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const action = "run/smoke-r1", target = "aws", runners = [0, 1].map(index => ({ id: `i-${index + 1}`, privateIp: `10.0.0.${index + 1}` }));
  const spec = { runId: "aggregate", localOutput: root, awsRunners: runners };
  for (let index = 0; index < runners.length; index += 1) {
    const directory = path.join(root, "evidence", action, target, "sources", `source-0${index + 1}`); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "operations.ndjson"), `${JSON.stringify({ sequence: index, serviceLatencyMs: index + 1, intendedLatencyMs: index + 1, queueDelayMs: 0, inFlightAtStart: 1, readUnits: 1, writeUnits: 0, error: null })}\n`);
    fs.writeFileSync(path.join(directory, "telemetry.ndjson"), `${JSON.stringify({ at: `2026-01-01T00:00:0${index}.000Z`, inFlight: 1 })}\n`);
    fs.writeFileSync(path.join(directory, "clock.txt"), `clock ${index}\n`);
    fs.writeFileSync(path.join(directory, "run-config.json"), JSON.stringify({ config: { name: "smoke" }, configSha256: hash, shard: { count: 2, index } }));
    fs.writeFileSync(path.join(directory, "summary.json"), JSON.stringify({ target, configSha256: hash, scheduledStartAt: "2026-01-01T00:00:00.000Z", actualStartAt: "2026-01-01T00:00:00.000Z", actualEndAt: "2026-01-01T00:00:01.000Z", actualDurationMs: 1000, startSkewMs: index, durationSeconds: 1, shard: { count: 2, index }, logicalScheduled: 2, scheduled: 1, attempted: 1, completed: 1, failed: 0, accounted: 1, errors: {}, schedulerDrops: 0, retries: 0, harnessPassed: true, workload: {}, concurrency: { configuredMaxInflight: 2, observedAtOperationStart: { max: 1 } }, client: {}, consumedCapacity: { readUnits: 1, writeUnits: 0 } }));
  }
  const summary = await aggregateTargetEvidence(spec, action, target);
  assert.equal(summary.loadGenerators.count, 2); assert.equal(summary.scheduled, 2); assert.equal(summary.completed, 2); assert.equal(summary.consumedCapacity.readUnits, 2); assert.equal(summary.harnessPassed, true);
  assert.equal(fs.readFileSync(path.join(root, "evidence", action, target, "operations.ndjson"), "utf8").trim().split("\n").length, 2);
  assert.ok(fs.existsSync(path.join(root, "evidence", action, target, "sources", "source-01", "summary.json")));
});

test("live progress aggregates counts and rate while retaining every source", () => {
  const progress = aggregateProgressSources([{ source: "source-01", value: { at: "2026-01-01T00:00:01Z", scheduled: 5, completed: 4, failed: 1, achievedOperationsPerSecond: 2, inFlight: 1, rollingP95Ms: 3, runner: { available: true, cpuUtilizationPercent: 10, networkReceiveBytesPerSecond: 2 } } }, { source: "source-02", value: { at: "2026-01-01T00:00:02Z", scheduled: 5, completed: 5, failed: 0, achievedOperationsPerSecond: 3, inFlight: 2, rollingP95Ms: 4, runner: { available: true, cpuUtilizationPercent: 20, networkReceiveBytesPerSecond: 3 } } }]);
  assert.equal(progress.scheduled, 10); assert.equal(progress.completed, 9); assert.equal(progress.failed, 1); assert.equal(progress.achievedOperationsPerSecond, 5); assert.equal(progress.rollingP95Ms, 4); assert.equal(progress.runner.cpuUtilizationPercent, 20); assert.equal(progress.runner.networkReceiveBytesPerSecond, 5); assert.equal(progress.sources.length, 2);
});

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
  assert.doesNotMatch(source, /podman pull/, "preflight must validate the pinned local image without registry access");
  assert.match(source, /\.adb-admin-password/);
  assert.match(source, /KVS_REQUIRED_SECONDS/);
  assert.match(source, /expiration_minutes:5256000/);
  assert.match(source, /Automatically renewed table-scoped benchmark credential/);
  assert.match(source, /awk '\/\^\\\\\{\.\*\\\\\}\$\//);
  assert.doesNotMatch(source, /completed=\$\(grep -c/);
  assert.match(source, /startDelayMs \+ workloadMs \+ 15 \* 60_000/);
  assert.doesNotMatch(source, /attempt < 450/);
  assert.match(source, /verify its instance-role and DynamoDB VPC endpoint policies include this table ARN/);
  assert.match(source, /cannot publish evidence under the permitted results\/ prefix/);
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

test("missing OCI final evidence is republished and recollected without failing the run", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-cloud-evidence-recovery-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = { runId: "cloud-evidence-recovery", localOutput: root, enabled: ["adb"], matrix: [{ id: "smoke-r1" }] };
  let republished = false, collections = 0;
  const adapter = new CliCloudAdapter({ collectionRetryMs: 0 });
  adapter.collectTarget = async (_spec, action, target) => {
    collections += 1;
    if (!republished) return;
    const destination = path.join(root, "evidence", action, target); fs.mkdirSync(destination, { recursive: true });
    for (const name of ["operations.ndjson", "telemetry.ndjson", "summary.json", "run-config.json", "clock.txt"]) fs.writeFileSync(path.join(destination, name), "evidence\n");
  };
  adapter.republishTargetEvidence = async (_spec, action, target) => { assert.equal(action, "run/smoke-r1"); assert.equal(target, "adb"); republished = true; };
  await adapter.collect(spec, "run/smoke-r1");
  assert.equal(republished, true); assert.equal(collections, 3);
  const journal = fs.readFileSync(path.join(root, "control", "command-journal.ndjson"), "utf8");
  assert.match(journal, /evidence-republish-started/); assert.match(journal, /evidence-republish-recovered/);
});

test("runner metrics normalize AWS and OCI infrastructure timelines", async () => {
  const execute = async (file, args) => {
    if (file === "aws") {
      const queries = JSON.parse(args[args.indexOf("--metric-data-queries") + 1]);
      return JSON.stringify({ MetricDataResults: queries.map(query => ({ Id: query.Id, Timestamps: ["2026-01-01T00:00:00.000Z"], Values: [query.Id.startsWith("network") ? 6000 : 12] })) });
    }
    const query = args[args.indexOf("--query-text") + 1], name = /^([^[]+)/.exec(query)[1], values = name.startsWith("Networks") ? [1000, 7000] : [10, 20];
    return JSON.stringify({ data: [{ "aggregated-datapoints": values.map((value, index) => ({ timestamp: `2026-01-01T00:0${index}:00.000Z`, value })) }] });
  };
  const adapter = new CliCloudAdapter({ execute }), startAt = "2026-01-01T00:00:00.000Z", endAt = "2026-01-01T00:02:00.000Z";
  const aws = await adapter.awsRunnerMetrics({ awsProfile: "test", awsRegion: "us-east-1", awsRunner: "i-test" }, startAt, endAt);
  assert.equal(aws.metrics.cpuUtilizationPercent[0].value, 12); assert.equal(aws.metrics.networkReceiveBytesPerSecond[0].value, 100); assert.deepEqual(aws.unavailable, ["memoryUtilizationPercent", "loadAverage1m"]);
  const oci = await adapter.ociRunnerMetrics({ adbOciProfile: "test", adbOciRegion: "us-ashburn-1", adbRunnerCompartment: "ocid1.compartment.test", adbRunner: "ocid1.instance.test" }, "adb", startAt, endAt);
  assert.equal(oci.metrics.cpuUtilizationPercent.length, 2); assert.equal(oci.metrics.networkReceiveBytesPerSecond[0].value, 100); assert.deepEqual(oci.unavailable, []);
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

test("a detached post-workload checkpoint can regenerate its package without rerunning cloud sessions", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-cloud-package-resume-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "cloud-detached-package", output = path.join(root, id), sessionId = "session-r1";
  const names = ["runner-readiness", "resource-validation", "dataset-preload", "dataset-certification", "dataset-hash-match", "t0-scheduled", "workload", "evidence-collection", "acceptance-validation", "package-generation"];
  const summary = { target: "aws", configSha256: hash, scheduledStartAt: "2026-01-01T00:00:00.000Z", actualStartAt: "2026-01-01T00:00:00.000Z", startSkewMs: 0, scheduled: 20, accounted: 20, completed: 20, failed: 0, harnessPassed: true, successfulServiceLatencyMs: { p95: 1, p99: 2, max: 3 } };
  const state = { id, output, outputRelative: `.kvs/cloud-runs/${id}`, spec: { mode: "async", enabled: ["aws"], matrix: [{ id: sessionId, configFile: "fixture.json", repetition: 1 }], localOutput: output }, status: "running", controlOwnerPid: -1, createdAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:01.000Z", stages: names.map(name => ({ name, status: name === "package-generation" ? "running" : "complete", startedAt: "2026-01-01T00:00:01.000Z", completedAt: name === "package-generation" ? null : "2026-01-01T00:00:02.000Z", detail: null })), targetStatus: { aws: "completed" }, certificates: { aws: { observedSha256: hash, passed: true } }, sessionResults: [{ id: sessionId, configFile: "fixture.json", repetition: 1, sharedStartAt: summary.scheduledStartAt, summaries: { aws: summary } }], targetMetrics: {}, logs: [] };
  writeStateAtomic(output, state);
  const runs = new CloudAcceptanceRuns({ outputRoot: root, adapter: {} }); assert.equal(runs.get(id).canResume, true); runs.resume(id);
  let current = runs.get(id); for (let attempt = 0; attempt < 100 && current.status !== "complete"; attempt += 1) { await new Promise(resolve => setTimeout(resolve, 10)); current = runs.get(id); }
  assert.equal(current.status, "complete"); assert.equal(current.sessionResults.length, 1); assert.ok(fs.existsSync(runs.download(id)));
  assert.ok(current.stages.find(stage => stage.name === "workload").attempts.length >= 1);
});
