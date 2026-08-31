import assert from "node:assert/strict";
import test from "node:test";
import { discoverDestinations } from "../src/dashboard/destination-discovery.mjs";

test("destination lookup returns full compartment paths and provider table inventories", async () => {
  const tenancy = "ocid1.tenancy.test", parent = "ocid1.compartment.parent", child = "ocid1.compartment.child";
  const executeCommand = async (file, args) => {
    if (file === "aws") return JSON.stringify({ TableNames: ["z-table", "a-table"] });
    if (file === "oci" && args[0] === "iam") return JSON.stringify({ data: [{ id: parent, name: "team", "compartment-id": tenancy, "lifecycle-state": "ACTIVE" }, { id: child, name: "benchmark", "compartment-id": parent, "lifecycle-state": "ACTIVE" }] });
    if (file === "oci" && args[0] === "db") return JSON.stringify({ data: [{ id: "ocid1.autonomousdatabase.test", "display-name": "adb", "db-name": "ADB", "lifecycle-state": "AVAILABLE", "compute-count": 2 }] });
    if (file === "oci" && args[0] === "nosql") return JSON.stringify({ data: { items: [{ id: "ocid1.nosqltable.test", name: "kv", "lifecycle-state": "ACTIVE", "table-limits": { "max-read-units": 40, "max-write-units": 30, "max-storage-in-g-bs": 1 } }] } });
    throw new Error(`Unexpected ${file} ${args.join(" ")}`);
  };
  const result = await discoverDestinations({ awsProfile: "aws", ociProfile: "oci", adbCompartmentId: child, ndcsCompartmentId: child, adbRunnerHost: "203.0.113.1", keyFile: "ignored", executeCommand, profileReader: async () => ({ tenancy }), adbTableReader: async () => ({ tableNames: ["ddb_api"], databaseId: "ocid1.autonomousdatabase.test" }) });
  assert.deepEqual(result.awsTables, ["a-table", "z-table"]); assert.equal(result.compartments.find(item => item.id === child).path, "tenancy root / team / benchmark");
  assert.equal(result.autonomousDatabases[0].name, "adb"); assert.deepEqual(result.adbTables, ["ddb_api"]); assert.equal(result.adbRuntimeDatabaseId, "ocid1.autonomousdatabase.test");
  assert.deepEqual(result.nosqlTables[0], { id: "ocid1.nosqltable.test", name: "kv", state: "ACTIVE", readUnits: 40, writeUnits: 30, storageGB: 1 });
});

test("AWS-only lookup does not require or contact OCI", async () => {
  const calls = [];
  const result = await discoverDestinations({ awsProfile: "aws", awsRegion: "us-east-1", targets: { aws: true, adb: false, ndcs: false }, executeCommand: async (file, args) => { calls.push([file, ...args]); assert.equal(file, "aws"); return JSON.stringify({ TableNames: ["only-aws"] }); }, profileReader: async () => { throw new Error("OCI must not be read"); } });
  assert.deepEqual(result.awsTables, ["only-aws"]); assert.deepEqual(result.compartments, []); assert.equal(calls.length, 1);
});
