import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeOciRunCommand } from "../src/dashboard/oci-run-command.mjs";

test("OCI Run Command uses typed JSON files and returns text output", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-run-command-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const executeCommand = async (file, args) => {
    calls.push([file, args]);
    if (args.includes("create")) return "ocid1.instanceagentcommand.test\n";
    return JSON.stringify({ data: { "lifecycle-state": "SUCCEEDED", content: { text: "ready", "exit-code": 0 } } });
  };
  const result = await executeOciRunCommand({ executeCommand, profile: "TEST", region: "us-ashburn-1", compartmentId: "ocid1.compartment.test", instanceId: "ocid1.instance.test", script: "date -u\n", displayName: "test", controlDirectory: root, pollIntervalMs: 1 });
  assert.equal(result.stdout, "ready"); assert.equal(calls.length, 2);
  const content = JSON.parse(fs.readFileSync(fs.readdirSync(root).map(name => path.join(root, name)).find(file => file.endsWith("content.json")), "utf8"));
  assert.equal(content.source.sourceType, "TEXT"); assert.equal(content.output.outputType, "TEXT"); assert.equal(content.source.textSha256.length, 64);
});
