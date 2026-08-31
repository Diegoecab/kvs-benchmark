import assert from "node:assert/strict";
import test from "node:test";
import { discoverDestinations } from "../src/dashboard/destination-discovery.mjs";

test("destination lookup returns full compartment paths and provider table inventories", async () => {
  const tenancy = "ocid1.tenancy.test", parent = "ocid1.compartment.parent", child = "ocid1.compartment.child";
  const executeCommand = async (file, args) => {
    if (file === "aws" && args[0] === "dynamodb" && args[1] === "list-tables") return JSON.stringify({ TableNames: ["z-table", "a-table"] });
    if (file === "aws" && args[0] === "dynamodb" && args[1] === "describe-table") { const name = args[args.indexOf("--table-name") + 1]; return JSON.stringify({ Table: { TableName: name, TableStatus: "ACTIVE", BillingModeSummary: { BillingMode: "PROVISIONED" }, ProvisionedThroughput: { ReadCapacityUnits: 20, WriteCapacityUnits: 10 }, ItemCount: 100, TableSizeBytes: 2048 } }); }
    if (file === "aws" && args[0] === "application-autoscaling") return JSON.stringify({ ScalableTargets: [{ ResourceId: "table/a-table", ScalableDimension: "dynamodb:table:ReadCapacityUnits", MinCapacity: 20, MaxCapacity: 100 }] });
    if (file === "oci" && args[0] === "iam") return JSON.stringify({ data: [{ id: parent, name: "team", "compartment-id": tenancy, "lifecycle-state": "ACTIVE" }, { id: child, name: "benchmark", "compartment-id": parent, "lifecycle-state": "ACTIVE" }] });
    if (file === "oci" && args[0] === "db") return JSON.stringify({ data: [{ id: "ocid1.autonomousdatabase.test", "display-name": "adb", "db-name": "ADB", "lifecycle-state": "AVAILABLE", "compute-count": 2 }] });
    if (file === "oci" && args[0] === "nosql") return JSON.stringify({ data: { items: [{ id: "ocid1.nosqltable.test", name: "kv", "lifecycle-state": "ACTIVE", "table-limits": { "max-read-units": 40, "max-write-units": 30, "max-storage-in-g-bs": 1 } }] } });
    if (file === "oci" && args[0] === "os") return JSON.stringify({ data: [{ name: "kvs-evidence" }] });
    throw new Error(`Unexpected ${file} ${args.join(" ")}`);
  };
  const result = await discoverDestinations({ awsProfile: "aws", ociProfile: "oci", adbCompartmentId: child, ndcsCompartmentId: child, adbRunnerId: "ocid1.instance.test", adbRunnerCompartmentId: child, probeAdbTables: true, executeCommand, profileReader: async () => ({ tenancy }), adbTableReader: async () => ({ tables: [{ name: "ddb_api", status: "ACTIVE", billingMode: "PROVISIONED", readCapacityUnits: 100, writeCapacityUnits: 100 }], databaseId: "ocid1.autonomousdatabase.test" }) });
  assert.deepEqual(result.awsTables.map(item => item.name), ["a-table", "z-table"]); assert.equal(result.awsTables[0].readCapacityUnits, 20); assert.deepEqual(result.awsTables[0].autoscaling.read, { min: 20, max: 100 }); assert.equal(result.compartments.find(item => item.id === child).path, "tenancy root / team / benchmark");
  assert.equal(result.adbCompartments.find(item => item.id === child).path, "tenancy root / team / benchmark"); assert.equal(result.ndcsCompartments.find(item => item.id === child).path, "tenancy root / team / benchmark");
  assert.equal(result.autonomousDatabases[0].name, "adb"); assert.equal(result.adbTables[0].name, "ddb_api"); assert.equal(result.adbTables[0].readCapacityUnits, 100); assert.equal(result.adbRuntimeDatabaseId, "ocid1.autonomousdatabase.test");
  assert.deepEqual(result.nosqlTables[0], { id: "ocid1.nosqltable.test", name: "kv", state: "ACTIVE", capacityMode: "PROVISIONED", readUnits: 40, writeUnits: 30, storageGB: 1, autoscaling: { mode: "NOT_DETECTED" }, tableSizeBytes: null, itemCount: null });
  assert.deepEqual(result.adbEvidenceBuckets, ["kvs-evidence"]); assert.deepEqual(result.ndcsEvidenceBuckets, ["kvs-evidence"]);
});

test("ADB and OCI NoSQL destination lookup use their independently selected profiles", async () => {
  const calls = [], adbTenancy = "ocid1.tenancy.adb", ndcsTenancy = "ocid1.tenancy.ndcs";
  const executeCommand = async (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === "iam") return JSON.stringify({ data: [] });
    if (args[0] === "db") return JSON.stringify({ data: [] });
    if (args[0] === "nosql") return JSON.stringify({ data: { items: [] } });
    if (args[0] === "os") return JSON.stringify({ data: [] });
    throw new Error(`Unexpected ${file} ${args.join(" ")}`);
  };
  const result = await discoverDestinations({
    targets: { aws: false, adb: true, ndcs: true },
    adbOciProfile: "ADB_PROFILE", adbOciRegion: "us-ashburn-1", adbCompartmentId: adbTenancy,
    ndcsOciProfile: "NOSQL_PROFILE", ndcsOciRegion: "us-ashburn-1", ndcsCompartmentId: ndcsTenancy,
    executeCommand,
    profileReader: async profile => ({ tenancy: profile === "ADB_PROFILE" ? adbTenancy : ndcsTenancy }),
  });
  assert.equal(result.adbCompartments[0].id, adbTenancy);
  assert.equal(result.ndcsCompartments[0].id, ndcsTenancy);
  assert.ok(calls.some(call => call[1] === "db" && call.includes("ADB_PROFILE") && call.includes(adbTenancy)));
  assert.ok(calls.some(call => call[1] === "nosql" && call.includes("NOSQL_PROFILE") && call.includes(ndcsTenancy)));
});

test("AWS-only lookup does not require or contact OCI", async () => {
  const calls = [];
  const result = await discoverDestinations({ awsProfile: "aws", awsRegion: "us-east-1", targets: { aws: true, adb: false, ndcs: false }, executeCommand: async (file, args) => { calls.push([file, ...args]); assert.equal(file, "aws"); if (args[1] === "list-tables") return JSON.stringify({ TableNames: ["only-aws"] }); if (args[1] === "describe-table") return JSON.stringify({ Table: { TableName: "only-aws", TableStatus: "ACTIVE", BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" } } }); return JSON.stringify({ ScalableTargets: [] }); }, profileReader: async () => { throw new Error("OCI must not be read"); } });
  assert.equal(result.awsTables[0].name, "only-aws"); assert.equal(result.awsTables[0].billingMode, "PAY_PER_REQUEST"); assert.deepEqual(result.compartments, []); assert.deepEqual(result.adbCompartments, []); assert.deepEqual(result.ndcsCompartments, []); assert.equal(calls.length, 3);
});

test("ADB table probing is opt-in even when a runner is selected", async () => {
  const tenancy = "ocid1.tenancy.test"; let probes = 0;
  const result = await discoverDestinations({ targets: { aws: false, adb: true, ndcs: false }, adbOciProfile: "OCI", adbOciRegion: "us-ashburn-1", adbRunnerId: "ocid1.instance.test", adbRunnerCompartmentId: "ocid1.compartment.test", executeCommand: async () => JSON.stringify({ data: [] }), profileReader: async () => ({ tenancy }), adbTableReader: async () => { probes += 1; return { tableNames: ["unexpected"] }; } });
  assert.equal(probes, 0); assert.deepEqual(result.adbTables, []);
});

test("destination lookup preserves healthy provider results when ADB table discovery fails", async () => {
  const tenancy = "ocid1.tenancy.test";
  const result = await discoverDestinations({
    awsProfile: "aws", awsRegion: "us-east-1", adbOciProfile: "oci", adbOciRegion: "us-ashburn-1", ndcsOciProfile: "oci", ndcsOciRegion: "us-ashburn-1",
    adbRunnerId: "ocid1.instance.test", adbRunnerCompartmentId: "ocid1.compartment.test", probeAdbTables: true,
    executeCommand: async (file, args) => file !== "aws" ? JSON.stringify({ data: [] }) : args[1] === "list-tables" ? JSON.stringify({ TableNames: ["healthy-aws"] }) : args[1] === "describe-table" ? JSON.stringify({ Table: { TableName: "healthy-aws", TableStatus: "ACTIVE" } }) : JSON.stringify({ ScalableTargets: [] }),
    profileReader: async () => ({ tenancy }), adbTableReader: async () => { throw new Error("Run Command policy missing"); },
  });
  assert.equal(result.awsTables[0].name, "healthy-aws"); assert.deepEqual(result.adbTables, []); assert.equal(result.discoveryErrors.adbTables, "Run Command policy missing");
});
