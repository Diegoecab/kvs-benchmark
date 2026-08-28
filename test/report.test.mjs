import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { generateReport } from "../src/report/html.mjs";
import { generatePackage } from "../src/report/package.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-report-")); const t0 = Date.parse("2026-01-01T00:00:00Z"); const targets = {};
  for (const [offset, target] of ["aws", "adb", "ndcs"].entries()) {
    const directory = path.join(root, "source", target, "workload"); fs.mkdirSync(directory, { recursive: true });
    const summary = { schemaVersion: 1, target, consistency: "strong", configSha256: "fixture-config", startAt: new Date(t0).toISOString(), scheduledStartAt: new Date(t0).toISOString(), scheduledEndAt: new Date(t0 + 3000).toISOString(), actualStartAt: new Date(t0).toISOString(), actualEndAt: new Date(t0 + 3005 + offset).toISOString(), actualDurationMs: 3005 + offset, startSkewMs: 0, durationSeconds: 3, scheduled: 3, completed: 2, achievedOperationsPerSecond: 1, schedulerDrops: 0, workload: { readPercent: 100, writePercent: 0, executionMode: "concurrent" }, concurrency: { executionMode: "concurrent", configuredMaxInflight: 8, observedAtOperationStart: { max: 2 } }, queueDelayMs: { p99: 0.1 }, client: { eventLoopDelayMs: { p99: 0.2 } } };
    fs.writeFileSync(path.join(directory, "summary.json"), JSON.stringify(summary));
    const records = [
      { sequence: 0, operation: "read", offeredRate: 1, scheduledEpochMs: t0, endedEpochMs: t0 + 2 + offset, serviceLatencyMs: 2 + offset, intendedLatencyMs: 2 + offset, error: null },
      { sequence: 1, operation: "read", offeredRate: 1, scheduledEpochMs: t0 + 1000, endedEpochMs: t0 + 1004 + offset, serviceLatencyMs: 4 + offset, intendedLatencyMs: 4 + offset, error: null },
      { sequence: 2, operation: "read", offeredRate: 1, scheduledEpochMs: t0 + 2000, endedEpochMs: t0 + 2001, serviceLatencyMs: 1, error: { name: "ThrottlingException", httpStatusCode: 429 } },
    ];
    fs.writeFileSync(path.join(directory, "operations.ndjson"), `${records.map(JSON.stringify).join("\n")}\n`);
    fs.writeFileSync(path.join(directory, "telemetry.ndjson"), `${JSON.stringify({ at: new Date(t0).toISOString(), inFlight: 1 })}\n`);
    fs.writeFileSync(path.join(directory, "run-config.json"), JSON.stringify({ config: { workload: summary.workload } }));
    const capacityFile = path.join(root, "source", target, "capacity-events.json");
    fs.writeFileSync(capacityFile, JSON.stringify({ passed: true, events: [
      { name: "scale-down", atSecond: 180, scheduledAt: new Date(t0 + 180000).toISOString(), requestSkewMs: 0, requestedCapacity: { read: 50, write: 50 }, appliedAt: new Date(t0 + 181000).toISOString(), applyDurationMs: 1000, status: "applied" },
      { name: "scale-up", atSecond: 480, scheduledAt: new Date(t0 + 480000).toISOString(), requestSkewMs: 0, requestedCapacity: { read: 100, write: 100 }, appliedAt: new Date(t0 + 481000).toISOString(), applyDurationMs: 1000, status: "applied" },
    ] }));
    targets[target] = { run: path.relative(root, directory), capacityEvents: path.relative(root, capacityFile) };
  }
  const datasetCertificates = ["aws", "adb", "ndcs"].map(target => { const file = path.join(root, `${target}-certificate.json`); fs.writeFileSync(file, JSON.stringify({ target, passed: true, expectedSha256: "fixture-dataset", observedSha256: "fixture-dataset" })); return path.basename(file); });
  const supporting = path.join(root, "supporting.json"); fs.writeFileSync(supporting, JSON.stringify({ retained: true }));
  const suite = { schemaVersion: 1, title: "Fixture benchmark", benchmarkId: "fixture", scope: { multiRegion: false }, executiveSummary: ["Fixture conclusion."], capacityComparison: { aws: { baseline: "100 RCU / 100 WCU", phase1Low: "50 RCU / 50 WCU" } }, pricing: { licenseModel: "BYOL" }, datasetCertificates, additionalEvidence: [{ label: "Supporting fixture", path: path.basename(supporting) }], sessions: [{ id: "p1-r1", phase: "phase1", consistency: "strong", repetition: "r1", targets }] };
  const suiteFile = path.join(root, "suite.json"); fs.writeFileSync(suiteFile, JSON.stringify(suite)); return { root, suiteFile };
}

test("HTML report is self-contained and exposes interactive provider labels", () => {
  const { root, suiteFile } = fixture(); const output = path.join(root, "report.html"); const data = generateReport({ suite: suiteFile, output }); const html = fs.readFileSync(output, "utf8");
  assert.equal(data.sessions[0].targets.aws.throttling.affectedSeconds, 1); assert.match(html, /Fixture conclusion/); assert.match(html, /Supporting fixture/); assert.match(html, /data-series="aws"/); assert.match(html, /Offered load/); assert.match(html, /href="#methodology"/); assert.match(html, /Benchmark methodology/); assert.match(html, /Controlled scale-down and scale-up/); assert.match(html, /Consistency:/); assert.match(html, /Provisioned KVS capacity/); assert.match(html, /100 RCU \/ 100 WCU/); assert.match(html, /Exact execution windows \(UTC\)/); assert.match(html, /Scheduled start/); assert.match(html, /capacity\?\.events/); assert.doesNotMatch(html, /\[180,480\]/); assert.match(html, /Evidence index and reproducibility/); assert.match(html, /operations NDJSON/);
  assert.doesNotThrow(() => new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]));
});

test("package copies evidence and generates a SHA-256 manifest", () => {
  const { root, suiteFile } = fixture(); const output = path.join(root, "deliverable"); const manifest = generatePackage({ suite: suiteFile, output });
  assert.ok(manifest.fileCount >= 10); assert.ok(fs.existsSync(path.join(output, "index.html"))); assert.ok(fs.existsSync(path.join(output, "manifest-sha256.json"))); assert.ok(manifest.entries.some(value => value.path.endsWith("operations.ndjson"))); assert.ok(manifest.entries.some(value => value.path.endsWith("supporting.json")));
});

test("report rejects a non-identical target operation schedule", () => {
  const { root, suiteFile } = fixture(); const file = path.join(root, "source", "adb", "workload", "operations.ndjson");
  const records = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).map(JSON.parse); records[0].keyIndex = 99; fs.writeFileSync(file, `${records.map(JSON.stringify).join("\n")}\n`);
  assert.throws(() => generateReport({ suite: suiteFile, output: path.join(root, "rejected.html") }), /operation schedules differ/);
});

test("report accepts identical logical schedules recorded in different completion order", () => {
  const { root, suiteFile } = fixture(); const file = path.join(root, "source", "adb", "workload", "operations.ndjson");
  const records = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).reverse(); fs.writeFileSync(file, `${records.join("\n")}\n`);
  assert.doesNotThrow(() => generateReport({ suite: suiteFile, output: path.join(root, "accepted.html") }));
});

test("report accepts different operation counts for equal fixed-concurrency closed-loop targets", () => {
  const { root, suiteFile } = fixture();
  for (const target of ["aws", "adb", "ndcs"]) {
    const summaryFile = path.join(root, "source", target, "workload", "summary.json"), summary = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
    summary.loadModel = "closed-loop"; summary.concurrency.targetConcurrency = 4; summary.workload.executionMode = "fixed-concurrency"; fs.writeFileSync(summaryFile, JSON.stringify(summary));
  }
  const awsOperations = path.join(root, "source", "aws", "workload", "operations.ndjson"), records = fs.readFileSync(awsOperations, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  records.push({ ...records[0], sequence: 3, scheduledEpochMs: records[0].scheduledEpochMs + 10, startedEpochMs: records[0].scheduledEpochMs + 10, endedEpochMs: records[0].endedEpochMs + 10 }); fs.writeFileSync(awsOperations, `${records.map(JSON.stringify).join("\n")}\n`);
  const awsSummaryFile = path.join(root, "source", "aws", "workload", "summary.json"), awsSummary = JSON.parse(fs.readFileSync(awsSummaryFile, "utf8")); awsSummary.scheduled = 4; awsSummary.completed = 3; fs.writeFileSync(awsSummaryFile, JSON.stringify(awsSummary));
  const data = generateReport({ suite: suiteFile, output: path.join(root, "closed-loop.html") });
  assert.equal(data.sessions[0].loadModel, "closed-loop"); assert.equal(data.sessions[0].targets.aws.recordCount, 4); assert.equal(data.sessions[0].targets.adb.recordCount, 3);
});
