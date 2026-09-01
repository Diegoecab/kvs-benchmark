import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readRunStates, stateFileName, writeStateAtomic } from "../src/dashboard/file-state.mjs";

test("dashboard run snapshots are atomically replaced and restored", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-file-state-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "run-1"), initial = { id: "run-1", output, status: "running", logs: [] };
  writeStateAtomic(output, initial); writeStateAtomic(output, { ...initial, status: "complete" });
  assert.equal(readRunStates(root)[0].status, "complete");
  assert.equal(fs.readdirSync(output).filter(name => name.endsWith(".tmp")).length, 0);
  assert.equal(fs.statSync(path.join(output, stateFileName)).isFile(), true);
});
