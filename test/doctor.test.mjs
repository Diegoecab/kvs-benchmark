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

test("doctor records observed provisioned capacity without failing when a smoke profile does not assert sizing", async () => {
  const { config } = readConfig(new URL("../configs/smoke.json", import.meta.url));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-doctor-smoke-")), clock = path.join(directory, "clock.txt");
  fs.writeFileSync(clock, "System time     : 0.000001 seconds fast of NTP time\nLeap status     : Normal\n");
  const previousRegion = process.env.AWS_REGION; process.env.AWS_REGION = "us-east-1";
  try {
    const report = await doctor({ config, target: "aws", table: "fixture", skipNetwork: true, hostEvidence: clock, capacityProvider: { inspect: async () => ({ state: "ACTIVE", capacityMode: "PROVISIONED", read: 20, write: 20, keySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }], attributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }] }) } });
    const capacity = report.checks.find(value => value.name === "provisioned-capacity"); assert.equal(report.ready, true); assert.equal(capacity.required, false); assert.deepEqual(capacity.detail.observed, { read: 20, write: 20 });
  } finally { if (previousRegion === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = previousRegion; }
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

test("cloud doctor accepts the OCI SDK v2 schema representation", async () => {
  const { config } = readConfig(new URL("../configs/x1-read-open-loop.json", import.meta.url));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-doctor-ndcs-"));
  const clock = path.join(folder, "chronyc.txt");
  fs.writeFileSync(clock, "System time     : 0.000001 seconds fast of NTP time\nLeap status     : Normal\n");
  const previous = { region: process.env.OCI_REGION, compartment: process.env.OCI_COMPARTMENT_ID, principal: process.env.OCI_USE_INSTANCE_PRINCIPAL };
  Object.assign(process.env, { OCI_REGION: "us-ashburn-1", OCI_COMPARTMENT_ID: "test", OCI_USE_INSTANCE_PRINCIPAL: "true" });
  try {
    const capacityProvider = { inspect: async () => ({ state: "ACTIVE", capacityMode: "PROVISIONED", read: 200, write: 200, storageGB: 10, schema: { fields: [{ name: "pk", type: "STRING" }, { name: "sk", type: "STRING" }, { name: "version", type: "LONG" }, { name: "payload", type: "STRING" }], primaryKey: ["pk", "sk"], shardKey: ["pk"] } }), close: async () => {} };
    const report = await doctor({ config, target: "ndcs", table: "table", hostEvidence: clock, capacityProvider, skipNetwork: true });
    assert.equal(report.ready, true);
  } finally {
    for (const [key, value] of Object.entries({ OCI_REGION: previous.region, OCI_COMPARTMENT_ID: previous.compartment, OCI_USE_INSTANCE_PRINCIPAL: previous.principal })) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});
