import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readRecentEvidenceTables } from "../src/dashboard/recent-evidence.mjs";

test("recent evidence discovers and de-duplicates benchmark table candidates", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-recent-evidence-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [folder, observedAt] of [["older", "2026-08-27T00:00:00Z"], ["newer", "2026-08-28T00:00:00Z"]]) { const directory = path.join(root, folder); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "dataset-certificate.json"), JSON.stringify({ target: "adb", table: "benchmark_table", endedAt: observedAt })); }
  const result = readRecentEvidenceTables({ root });
  assert.deepEqual(result.adb, [{ table: "benchmark_table", observedAt: "2026-08-28T00:00:00Z" }]); assert.deepEqual(result.aws, []); assert.deepEqual(result.ndcs, []);
});
