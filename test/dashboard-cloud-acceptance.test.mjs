import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CloudAcceptanceRuns } from "../src/dashboard/cloud-acceptance.mjs";

const hash = "a".repeat(64);
const input = {
  writeAuthorization: true, artifactBucket: "benchmark-artifacts-123", imageDigest: `ghcr.io/example/runner@sha256:${"b".repeat(64)}`, execution: { mode: "async" },
  targets: {
    aws: { enabled: true, profile: "aws-test", region: "us-east-1", resource: "aws-table", runnerId: "i-012345" },
    adb: { enabled: true, profile: "OCI_TEST", region: "us-ashburn-1", resource: "adb_table", runnerId: "ocid1.instance.test.adb", runnerHost: "10.0.0.2" },
    ndcs: { enabled: true, profile: "OCI_TEST", region: "us-ashburn-1", resource: "ndcs_table", runnerId: "ocid1.instance.test.ndcs", runnerHost: "10.0.0.3", compartmentId: "ocid1.compartment.test" },
  },
};

test("cloud acceptance exposes every preflight, dataset, synchronization, evidence, and packaging stage", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-cloud-test-")), key = path.join(root, "key"); fs.writeFileSync(key, "test"); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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
  const runs = new CloudAcceptanceRuns({ outputRoot: root, keyFile: key, adapter }); const started = runs.start(input);
  assert.equal(started.stages.length, 10); let current = started;
  for (let attempt = 0; attempt < 100 && !["complete", "failed"].includes(current.status); attempt += 1) { await new Promise(resolve => setTimeout(resolve, 10)); current = runs.get(started.id); }
  assert.equal(current.status, "complete"); assert.ok(current.stages.every(stage => stage.status === "complete")); assert.equal(current.certificates.aws.observedSha256, hash); assert.ok(fs.existsSync(runs.download(started.id)));
});

test("cloud adapter source remains platform-neutral", () => {
  const source = fs.readFileSync(new URL("../src/dashboard/cloud-acceptance.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.cmd\b|powershell|[A-Z]:\\\\/i);
  for (const executable of ["aws", "oci", "ssh", "scp"]) assert.match(source, new RegExp(`"${executable}"`));
});
