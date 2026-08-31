import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { readOciProfileValues } from "./profiles.mjs";
import { defaultImage } from "./cloud-acceptance.mjs";

function execute(file, args, { timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) return reject(new Error(`${file} failed: ${(stderr || stdout || error.message).trim()}`)); resolve(stdout);
  }));
}
const parse = value => JSON.parse(value || "{}");
const validProfile = value => /^[A-Za-z0-9_.-]+$/.test(value || "");
const validRegion = value => /^[a-z]{2}-[a-z]+-\d$/.test(value || "");

function compartmentRows(items, tenancy) {
  const active = items.filter(item => item["lifecycle-state"] === "ACTIVE"), byId = new Map(active.map(item => [item.id, item]));
  const fullPath = item => { const names = [item.name]; let parent = item["compartment-id"], guard = 0; while (byId.has(parent) && guard++ < 50) { const value = byId.get(parent); names.unshift(value.name); parent = value["compartment-id"]; } return `tenancy root / ${names.join(" / ")}`; };
  return [{ id: tenancy, name: "tenancy root", path: "tenancy root" }, ...active.map(item => ({ id: item.id, name: item.name, path: fullPath(item) }))].sort((a, b) => a.path.localeCompare(b.path));
}

export async function listAdbApiTables({ host, keyFile, image = defaultImage, runtimeFile = process.env.KVS_ADB_RUNTIME_FILE || "/opt/meli-kvs-benchmark/run-20260826-02/adb-api.runtime.json", executeCommand = execute }) {
  if (!/^[A-Za-z0-9.-]+$/.test(host || "")) throw new Error("A valid ADB runner host is required");
  if (!keyFile || !fs.existsSync(keyFile)) throw new Error("KVS_OCI_SSH_KEY is not configured");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-destination-")), local = path.join(folder, "list-adb-tables.sh"), remote = `/tmp/kvs-list-adb-${crypto.randomBytes(4).toString("hex")}.sh`;
  const javascript = `import {DynamoDBClient,ListTablesCommand} from "@aws-sdk/client-dynamodb";const endpoint=process.env.DDB_ENDPOINT;const client=new DynamoDBClient({region:process.env.AWS_REGION,endpoint,maxAttempts:1});const result=await client.send(new ListTablesCommand({}));console.log(JSON.stringify({tableNames:result.TableNames||[],databaseId:new URL(endpoint).pathname.split("/").filter(Boolean).at(-1)}));client.destroy();`;
  const script = `#!/usr/bin/env bash\nset -euo pipefail\nruntime='${runtimeFile.replaceAll("'", "")}'\nexport AWS_ACCESS_KEY_ID="$(jq -r .accessKeyId "$runtime")"\nexport AWS_SECRET_ACCESS_KEY="$(jq -r .secretAccessKey "$runtime")"\nexport DDB_ENDPOINT="$(jq -r .endpoint "$runtime")"\npodman run --rm --network host --entrypoint node -e AWS_REGION=us-ashburn-1 -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e DDB_ENDPOINT '${image}' --input-type=module --eval '${javascript}'\n`;
  try {
    fs.writeFileSync(local, script); const common = ["-i", keyFile, "-o", "StrictHostKeyChecking=no"];
    await executeCommand("scp", [...common, local, `opc@${host}:${remote}`]);
    return parse(await executeCommand("ssh", [...common, `opc@${host}`, `sudo bash ${remote}`]));
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
}

export async function discoverDestinations({ awsProfile, awsRegion = "us-east-1", ociProfile, ociRegion = "us-ashburn-1", adbCompartmentId, ndcsCompartmentId, adbRunnerHost, targets, keyFile, executeCommand = execute, profileReader = readOciProfileValues, adbTableReader = listAdbApiTables }) {
  const enabled = targets || { aws: true, adb: true, ndcs: true }, needsAws = enabled.aws !== false, needsOci = enabled.adb !== false || enabled.ndcs !== false;
  if (needsAws && (!validProfile(awsProfile) || !validRegion(awsRegion))) throw new Error("A valid AWS profile and region are required");
  if (needsOci && (!validProfile(ociProfile) || !validRegion(ociRegion))) throw new Error("A valid OCI profile and region are required");
  const profile = needsOci ? await profileReader(ociProfile) : null, tenancy = profile?.tenancy;
  const [awsRaw, compartmentsRaw, adbRuntime] = await Promise.all([
    needsAws ? executeCommand("aws", ["dynamodb", "list-tables", "--profile", awsProfile, "--region", awsRegion, "--output", "json"]) : Promise.resolve('{"TableNames":[]}'),
    needsOci ? executeCommand("oci", ["iam", "compartment", "list", "--profile", ociProfile, "--compartment-id", tenancy, "--compartment-id-in-subtree", "true", "--access-level", "ACCESSIBLE", "--lifecycle-state", "ACTIVE", "--all", "--output", "json"]) : Promise.resolve('{"data":[]}'),
    enabled.adb !== false && adbRunnerHost ? adbTableReader({ host: adbRunnerHost, keyFile, executeCommand }) : Promise.resolve({ tableNames: [], databaseId: null }),
  ]);
  const compartments = needsOci ? compartmentRows(parse(compartmentsRaw).data || [], tenancy) : [], allowed = new Set(compartments.map(item => item.id));
  if (enabled.adb !== false && adbCompartmentId && !allowed.has(adbCompartmentId)) throw new Error("Selected ADB compartment is not accessible");
  if (enabled.ndcs !== false && ndcsCompartmentId && !allowed.has(ndcsCompartmentId)) throw new Error("Selected OCI NoSQL compartment is not accessible");
  const [adbRaw, ndcsRaw] = await Promise.all([
    enabled.adb !== false && adbCompartmentId ? executeCommand("oci", ["db", "autonomous-database", "list", "--profile", ociProfile, "--region", ociRegion, "--compartment-id", adbCompartmentId, "--all", "--output", "json"]) : Promise.resolve('{"data":[]}'),
    enabled.ndcs !== false && ndcsCompartmentId ? executeCommand("oci", ["nosql", "table", "list", "--profile", ociProfile, "--region", ociRegion, "--compartment-id", ndcsCompartmentId, "--all", "--output", "json"]) : Promise.resolve('{"data":{"items":[]}}'),
  ]);
  const adbData = parse(adbRaw).data || [], ndcsData = parse(ndcsRaw).data; const ndcsItems = Array.isArray(ndcsData) ? ndcsData : ndcsData?.items || [];
  return {
    schemaVersion: 1, discoveredAt: new Date().toISOString(),
    awsTables: (parse(awsRaw).TableNames || []).sort(), compartments,
    autonomousDatabases: adbData.map(item => ({ id: item.id, name: item["display-name"], dbName: item["db-name"], state: item["lifecycle-state"], cpuCoreCount: item["cpu-core-count"], computeCount: item["compute-count"] })).sort((a, b) => a.name.localeCompare(b.name)),
    adbTables: [...new Set(adbRuntime.tableNames || [])].sort(), adbRuntimeDatabaseId: adbRuntime.databaseId || null,
    nosqlTables: ndcsItems.map(item => ({ id: item.id, name: item.name, state: item["lifecycle-state"], readUnits: item["table-limits"]?.["max-read-units"], writeUnits: item["table-limits"]?.["max-write-units"], storageGB: item["table-limits"]?.["max-storage-in-g-bs"] })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
