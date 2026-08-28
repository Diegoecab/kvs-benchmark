import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readConfig } from "../src/core/config.mjs";
import { doctor } from "../src/core/doctor.mjs";

test("mock doctor is non-mutating and ready offline", async () => {
  const { config } = readConfig(new URL("../configs/smoke.json", import.meta.url));
  const report = await doctor({ config, target: "mock", skipNetwork: true });
  assert.equal(report.ready, true);
  assert.equal(report.limitations.includes("Does not create or modify infrastructure"), true);
});

test("doctor reports a malformed ADB endpoint without crashing", async () => {
  const { config } = readConfig(new URL("../configs/smoke.json", import.meta.url));
  const report = await doctor({ config, target: "adb", endpoint: "not a URL" });
  assert.equal(report.ready, false);
  assert.match(report.checks.find(value => value.name === "endpoint-443").detail.error, /^invalid endpoint:/);
});

test("cloud doctor validates clock, canonical schema, and provisioned capacity without mutation", async () => {
  const { config } = readConfig(new URL("../configs/x1-read-open-loop.json", import.meta.url));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-doctor-")); const clock = path.join(directory, "chrony.txt");
  fs.writeFileSync(clock, "System time     : 0.000012 seconds fast of NTP time\nLeap status     : Normal\n");
  const previousRegion = process.env.AWS_REGION; process.env.AWS_REGION = "us-east-1";
  try {
    const report = await doctor({ config, target: "aws", table: "fixture", skipNetwork: true, hostEvidence: clock, capacityProvider: { async inspect() { return { state: "ACTIVE", capacityMode: "PROVISIONED", read: 100, write: 100, keySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }], attributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }] }; } } });
    assert.equal(report.ready, true); assert.equal(report.checks.find(value => value.name === "host-clock").passed, true); assert.equal(report.checks.find(value => value.name === "provisioned-capacity").passed, true);
  } finally { if (previousRegion === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = previousRegion; }
});
