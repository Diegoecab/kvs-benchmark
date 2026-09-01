import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeOciRunCommand } from "../src/dashboard/oci-run-command.mjs";

test("OCI Run Command uses typed JSON files and returns text output", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-run-command-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const executeCommand = async (file, args, options) => {
    calls.push([file, args, options]);
    if (args.includes("create")) return "ocid1.instanceagentcommand.test\n";
    return JSON.stringify({ data: { "lifecycle-state": "SUCCEEDED", content: { text: "ready", "exit-code": 0 } } });
  };
  const result = await executeOciRunCommand({ executeCommand, profile: "TEST", region: "us-ashburn-1", compartmentId: "ocid1.compartment.test", instanceId: "ocid1.instance.test", script: "date -u\n", displayName: "test", controlDirectory: root, pollIntervalMs: 1 });
  assert.equal(result.stdout, "ready"); assert.equal(calls.length, 2);
  assert.equal(calls[0][2].timeout, 60_000); assert.equal(calls[1][2].timeout, 60_000);
  const content = JSON.parse(fs.readFileSync(fs.readdirSync(root).map(name => path.join(root, name)).find(file => file.endsWith("content.json")), "utf8"));
  assert.equal(content.source.sourceType, "TEXT"); assert.equal(content.output.outputType, "TEXT"); assert.equal(content.source.textSha256.length, 64);
});

test("OCI Run Command honors the wall-clock timeout without extra polling attempts", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-run-command-timeout-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executeCommand = async (_file, args) => args.includes("create") ? "ocid1.instanceagentcommand.test\n" : JSON.stringify({ data: { "lifecycle-state": "ACCEPTED" } });
  const started = Date.now();
  await assert.rejects(() => executeOciRunCommand({ executeCommand, profile: "TEST", region: "us-ashburn-1", compartmentId: "ocid1.compartment.test", instanceId: "ocid1.instance.test", script: "date -u\n", displayName: "test-timeout", controlDirectory: root, timeoutSeconds: 1, deliveryTimeoutSeconds: 0.02, pollIntervalMs: 2 }), /not delivered within 0.02s/);
  assert.ok(Date.now() - started < 250);
});

test("OCI Run Command recovers the command id after a create response timeout", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-run-command-recovery-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executeCommand = async (_file, args) => {
    if (args.includes("create")) throw new Error("create response timed out");
    if (args.includes("list")) return JSON.stringify({ data: [{ "display-name": "recover-me", "instance-agent-command-id": "ocid1.instanceagentcommand.test" }] });
    return JSON.stringify({ data: { "lifecycle-state": "SUCCEEDED", content: { text: "ready", "exit-code": 0 } } });
  };
  const result = await executeOciRunCommand({ executeCommand, profile: "TEST", region: "us-ashburn-1", compartmentId: "ocid1.compartment.test", instanceId: "ocid1.instance.test", script: "date -u\n", displayName: "recover-me", controlDirectory: root, timeoutSeconds: 1, pollIntervalMs: 1 });
  assert.equal(result.commandId, "ocid1.instanceagentcommand.test"); assert.equal(result.stdout, "ready");
});
