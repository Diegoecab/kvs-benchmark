import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { coordinate } from "../src/core/coordinator.mjs";

const plan = () => ({ schemaVersion: 1, name: "fixture-triplet", leadTimeSeconds: 1, runners: ["aws", "adb", "ndcs"].map(target => ({ target, command: process.execPath, args: ["-e", "console.log(process.argv[1])", "{{START_AT}}"] })) });

test("coordinator supplies one UTC timestamp and records three successful commands", async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-coordinate-")); const base = Date.parse("2026-01-01T00:00:00Z");
  const report = await coordinate({ plan: plan(), output, startAt: new Date(base + 1000).toISOString(), now: () => base });
  assert.equal(report.passed, true); assert.equal(new Set(report.runners.map(value => value.commandSha256)).size, 1);
  for (const target of ["aws", "adb", "ndcs"]) assert.match(fs.readFileSync(path.join(output, `${target}.stdout.log`), "utf8"), /2026-01-01T00:00:01.000Z/);
});

test("coordinator dry-run never launches commands", async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-coordinate-dry-")); const base = Date.parse("2026-01-01T00:00:00Z");
  const report = await coordinate({ plan: plan(), output, startAt: new Date(base + 1000).toISOString(), dryRun: true, now: () => base });
  assert.equal(report.dryRun, true); assert.equal(fs.existsSync(path.join(output, "aws.stdout.log")), false);
});
