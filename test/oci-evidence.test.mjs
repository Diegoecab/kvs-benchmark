import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncEvidence } from "../src/cloud/oci-evidence.mjs";

test("OCI evidence sync uploads progress and the complete evidence tree", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-oci-evidence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "progress.json"), "{}\n");
  fs.mkdirSync(path.join(root, "nested"));
  fs.writeFileSync(path.join(root, "nested", "summary.json"), "{}\n");
  fs.writeFileSync(path.join(root, ".benchmark-complete"), "\n");
  const uploads = []; let clients = 0;
  const createClient = async () => { clients += 1; return { namespace: "namespace", client: { putObject: async request => { uploads.push(request.objectName); for await (const chunk of request.putObjectBody) void chunk; }, close() {} } }; };
  await syncEvidence({ directory: root, bucket: "evidence", prefix: "results/run/adb", marker: path.join(root, ".benchmark-complete"), createClient });
  assert.deepEqual(uploads.sort(), ["results/run/adb/nested/summary.json", "results/run/adb/progress.json"]);
  assert.equal(clients, 2, "final evidence must use a fresh Object Storage client after live polling");
});
