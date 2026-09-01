import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readOciProfileValues } from "./profiles.mjs";
import { defaultImage } from "./cloud-acceptance.mjs";
import { executeOciRunCommand } from "./oci-run-command.mjs";
import { readRecentEvidenceTables } from "./recent-evidence.mjs";

function execute(file, args, { timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) return reject(new Error(error.killed ? `${file} timed out after ${Math.round(timeout / 1000)} seconds` : `${file} failed: ${(stderr || stdout || error.message).trim()}`)); resolve(stdout);
  }));
}
const parse = value => JSON.parse(value || "{}");
const validProfile = value => /^[A-Za-z0-9_.-]+$/.test(value || "");
const validRegion = value => /^[a-z]{2}-[a-z]+-\d$/.test(value || "");
function conciseError(error) {
  const message = error?.message || String(error);
  if (/sudo: (?:a terminal is required|a password is required)|usual lecture/i.test(message)) return "Runner incompatible: the ocarun identity lacks passwordless sudo for Podman and protected runtime access. Replace or repair this runner before ADB table discovery.";
  return message.length > 600 ? `${message.slice(0, 597)}...` : message;
}
async function capture(errors, key, operation, fallback) { try { return await operation; } catch (error) { errors[key] = conciseError(error); return fallback; } }
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function awsTableRow(table, scalableTargets = []) {
  const name = table.TableName;
  const billingMode = table.BillingModeSummary?.BillingMode || "PROVISIONED";
  const targets = scalableTargets.filter(item => item.ResourceId === `table/${name}`);
  const autoscaling = Object.fromEntries(targets.map(item => [item.ScalableDimension?.endsWith("ReadCapacityUnits") ? "read" : "write", { min: item.MinCapacity, max: item.MaxCapacity }]));
  return { name, status: table.TableStatus, billingMode, readCapacityUnits: billingMode === "PROVISIONED" ? table.ProvisionedThroughput?.ReadCapacityUnits : null, writeCapacityUnits: billingMode === "PROVISIONED" ? table.ProvisionedThroughput?.WriteCapacityUnits : null, autoscaling, itemCount: table.ItemCount, tableSizeBytes: table.TableSizeBytes };
}

function compartmentRows(items, tenancy) {
  const active = items.filter(item => item["lifecycle-state"] === "ACTIVE"), byId = new Map(active.map(item => [item.id, item]));
  const fullPath = item => { const names = [item.name]; let parent = item["compartment-id"], guard = 0; while (byId.has(parent) && guard++ < 50) { const value = byId.get(parent); names.unshift(value.name); parent = value["compartment-id"]; } return `tenancy root / ${names.join(" / ")}`; };
  return [{ id: tenancy, name: "tenancy root", path: "tenancy root" }, ...active.map(item => ({ id: item.id, name: item.name, path: fullPath(item) }))].sort((a, b) => a.path.localeCompare(b.path));
}

export async function listAdbApiTables({ runnerId, runnerCompartmentId, profile, region, image = defaultImage, runtimeFile = process.env.KVS_ADB_RUNTIME_FILE || "/opt/kvs-dashboard/adb-api.runtime.json", executeCommand = execute }) {
  if (!/^ocid1\.instance\./.test(runnerId || "")) throw new Error("A valid ADB runner is required");
  if (!/^ocid1\.(compartment|tenancy)\./.test(runnerCompartmentId || "")) throw new Error("A valid ADB runner compartment is required");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-destination-"));
  const javascript = `import {DynamoDBClient,ListTablesCommand,DescribeTableCommand} from "@aws-sdk/client-dynamodb";const endpoint=process.env.DDB_ENDPOINT;const client=new DynamoDBClient({region:process.env.AWS_REGION,endpoint,maxAttempts:1});const listed=await client.send(new ListTablesCommand({}));const tables=await Promise.all((listed.TableNames||[]).map(async name=>{const result=await client.send(new DescribeTableCommand({TableName:name}));const table=result.Table||{};const billingMode=table.BillingModeSummary?.BillingMode||"PROVISIONED";return{name,status:table.TableStatus,billingMode,readCapacityUnits:billingMode==="PROVISIONED"?table.ProvisionedThroughput?.ReadCapacityUnits:null,writeCapacityUnits:billingMode==="PROVISIONED"?table.ProvisionedThroughput?.WriteCapacityUnits:null,autoscaling:{mode:"SERVICE_MANAGED"},itemCount:table.ItemCount,tableSizeBytes:table.TableSizeBytes}}));console.log(JSON.stringify({tables,databaseId:new URL(endpoint).pathname.split("/").filter(Boolean).at(-1)}));client.destroy();`;
  if (!validRegion(region)) throw new Error("A valid ADB OCI region is required");
  const script = `#!/usr/bin/env bash\nset -euo pipefail\nruntime='${runtimeFile.replaceAll("'", "")}'\nif ! sudo -n podman --version >/dev/null 2>&1 || ! sudo -n jq --version >/dev/null 2>&1; then echo "Runner incompatible: the ocarun identity lacks passwordless sudo for Podman and protected runtime access. Replace or repair this runner before ADB table discovery." >&2; exit 20; fi\nexport AWS_ACCESS_KEY_ID="$(sudo -n jq -r .accessKeyId "$runtime")"\nexport AWS_SECRET_ACCESS_KEY="$(sudo -n jq -r .secretAccessKey "$runtime")"\nexport DDB_ENDPOINT="$(sudo -n jq -r .endpoint "$runtime")"\nsudo -n podman run --rm --network host --entrypoint node -e AWS_REGION=${region} -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e DDB_ENDPOINT '${image}' --input-type=module --eval '${javascript}'\n`;
  try {
    const result = await executeOciRunCommand({ executeCommand, profile, region, compartmentId: runnerCompartmentId, instanceId: runnerId, script, displayName: `kvs-list-adb-${crypto.randomBytes(4).toString("hex")}`, controlDirectory: folder, timeoutSeconds: 30, deliveryTimeoutSeconds: 300, cliTimeoutMs: 60_000 });
    const jsonLine = result.stdout.split(/\r?\n/).reverse().find(line => line.trim().startsWith("{"));
    if (!jsonLine) throw new Error("ADB table lookup returned no JSON output");
    return parse(jsonLine);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
}

export async function discoverDestinations({ awsProfile, awsRegion = "us-east-1", ociProfile, ociRegion = "us-ashburn-1", adbOciProfile, adbOciRegion, ndcsOciProfile, ndcsOciRegion, adbCompartmentId, ndcsCompartmentId, adbRunnerId, adbRunnerCompartmentId, probeAdbTables = false, targets, executeCommand = execute, profileReader = readOciProfileValues, adbTableReader = listAdbApiTables, evidenceReader = () => readRecentEvidenceTables({ root: workspaceRoot }) }) {
  const enabled = targets || { aws: true, adb: true, ndcs: true }, needsAws = enabled.aws !== false, needsAdb = enabled.adb !== false, needsNdcs = enabled.ndcs !== false;
  const adbProfile = adbOciProfile || ociProfile, adbRegion = adbOciRegion || ociRegion, ndcsProfile = ndcsOciProfile || ociProfile, ndcsRegion = ndcsOciRegion || ociRegion;
  if (needsAws && (!validProfile(awsProfile) || !validRegion(awsRegion))) throw new Error("A valid AWS profile and region are required");
  if (needsAdb && (!validProfile(adbProfile) || !validRegion(adbRegion))) throw new Error("A valid ADB OCI profile and region are required");
  if (needsNdcs && (!validProfile(ndcsProfile) || !validRegion(ndcsRegion))) throw new Error("A valid OCI NoSQL profile and region are required");
  const discoveryErrors = {};
  const [adbIdentity, ndcsIdentity] = await Promise.all([needsAdb ? profileReader(adbProfile) : null, needsNdcs ? profileReader(ndcsProfile) : null]);
  const adbTenancy = adbIdentity?.tenancy, ndcsTenancy = ndcsIdentity?.tenancy;
  const [awsRaw, adbCompartmentsRaw, ndcsCompartmentsRaw, adbRuntime] = await Promise.all([
    needsAws ? capture(discoveryErrors, "awsTables", executeCommand("aws", ["dynamodb", "list-tables", "--profile", awsProfile, "--region", awsRegion, "--output", "json"]), '{"TableNames":[]}' ) : Promise.resolve('{"TableNames":[]}'),
    needsAdb ? capture(discoveryErrors, "adbCompartments", executeCommand("oci", ["iam", "compartment", "list", "--profile", adbProfile, "--compartment-id", adbTenancy, "--compartment-id-in-subtree", "true", "--access-level", "ACCESSIBLE", "--lifecycle-state", "ACTIVE", "--all", "--output", "json"]), '{"data":[]}' ) : Promise.resolve('{"data":[]}'),
    needsNdcs ? capture(discoveryErrors, "ndcsCompartments", executeCommand("oci", ["iam", "compartment", "list", "--profile", ndcsProfile, "--compartment-id", ndcsTenancy, "--compartment-id-in-subtree", "true", "--access-level", "ACCESSIBLE", "--lifecycle-state", "ACTIVE", "--all", "--output", "json"]), '{"data":[]}' ) : Promise.resolve('{"data":[]}'),
    needsAdb && probeAdbTables && adbRunnerId ? capture(discoveryErrors, "adbTables", adbTableReader({ runnerId: adbRunnerId, runnerCompartmentId: adbRunnerCompartmentId, profile: adbProfile, region: adbRegion, executeCommand }), { tables: [], databaseId: null }) : Promise.resolve({ tables: [], databaseId: null }),
  ]);
  const adbCompartments = needsAdb ? compartmentRows(parse(adbCompartmentsRaw).data || [], adbTenancy) : [], ndcsCompartments = needsNdcs ? compartmentRows(parse(ndcsCompartmentsRaw).data || [], ndcsTenancy) : [];
  if (needsAdb && adbCompartmentId && !discoveryErrors.adbCompartments && !new Set(adbCompartments.map(item => item.id)).has(adbCompartmentId)) throw new Error("Selected ADB compartment is not accessible through the selected ADB profile");
  if (needsNdcs && ndcsCompartmentId && !discoveryErrors.ndcsCompartments && !new Set(ndcsCompartments.map(item => item.id)).has(ndcsCompartmentId)) throw new Error("Selected OCI NoSQL compartment is not accessible through the selected OCI NoSQL profile");
  const awsNames = parse(awsRaw).TableNames || [];
  const [awsDescriptions, awsAutoscalingRaw, adbRaw, ndcsRaw, adbBucketsRaw, ndcsBucketsRaw] = await Promise.all([
    needsAws ? Promise.all(awsNames.map(name => capture(discoveryErrors, `awsTable:${name}`, executeCommand("aws", ["dynamodb", "describe-table", "--table-name", name, "--profile", awsProfile, "--region", awsRegion, "--output", "json"]), JSON.stringify({ Table: { TableName: name } })))) : Promise.resolve([]),
    needsAws ? capture(discoveryErrors, "awsAutoscaling", executeCommand("aws", ["application-autoscaling", "describe-scalable-targets", "--service-namespace", "dynamodb", "--profile", awsProfile, "--region", awsRegion, "--output", "json"]), '{"ScalableTargets":[]}' ) : Promise.resolve('{"ScalableTargets":[]}'),
    needsAdb && adbCompartmentId ? capture(discoveryErrors, "autonomousDatabases", executeCommand("oci", ["db", "autonomous-database", "list", "--profile", adbProfile, "--region", adbRegion, "--compartment-id", adbCompartmentId, "--all", "--output", "json"]), '{"data":[]}' ) : Promise.resolve('{"data":[]}'),
    needsNdcs && ndcsCompartmentId ? capture(discoveryErrors, "nosqlTables", executeCommand("oci", ["nosql", "table", "list", "--profile", ndcsProfile, "--region", ndcsRegion, "--compartment-id", ndcsCompartmentId, "--all", "--output", "json"]), '{"data":{"items":[]}}' ) : Promise.resolve('{"data":{"items":[]}}'),
    needsAdb && adbCompartmentId ? capture(discoveryErrors, "adbEvidenceBuckets", executeCommand("oci", ["os", "bucket", "list", "--profile", adbProfile, "--region", adbRegion, "--compartment-id", adbCompartmentId, "--all", "--output", "json"]), '{"data":[]}' ) : Promise.resolve('{"data":[]}'),
    needsNdcs && ndcsCompartmentId ? capture(discoveryErrors, "ndcsEvidenceBuckets", executeCommand("oci", ["os", "bucket", "list", "--profile", ndcsProfile, "--region", ndcsRegion, "--compartment-id", ndcsCompartmentId, "--all", "--output", "json"]), '{"data":[]}' ) : Promise.resolve('{"data":[]}'),
  ]);
  const adbData = parse(adbRaw).data || [], ndcsData = parse(ndcsRaw).data; const ndcsItems = Array.isArray(ndcsData) ? ndcsData : ndcsData?.items || [];
  const scalableTargets = parse(awsAutoscalingRaw).ScalableTargets || [];
  const adbTables = Array.isArray(adbRuntime.tables) ? adbRuntime.tables : (adbRuntime.tableNames || []).map(name => ({ name }));
  const recentEvidenceTables = await capture(discoveryErrors, "recentEvidence", Promise.resolve().then(evidenceReader), { aws: [], adb: [], ndcs: [] });
  return {
    schemaVersion: 1, discoveredAt: new Date().toISOString(), discoveryErrors, recentEvidenceTables,
    awsTables: awsDescriptions.map(raw => awsTableRow(parse(raw).Table || {}, scalableTargets)).sort((a, b) => a.name.localeCompare(b.name)), compartments: adbCompartments, adbCompartments, ndcsCompartments,
    autonomousDatabases: adbData.map(item => ({ id: item.id, name: item["display-name"], dbName: item["db-name"], state: item["lifecycle-state"], cpuCoreCount: item["cpu-core-count"], computeCount: item["compute-count"] })).sort((a, b) => a.name.localeCompare(b.name)),
    adbTables: [...new Map(adbTables.map(item => [item.name, item])).values()].sort((a, b) => a.name.localeCompare(b.name)), adbRuntimeDatabaseId: adbRuntime.databaseId || null,
    adbEvidenceBuckets: (parse(adbBucketsRaw).data || []).map(item => item.name).sort(),
    ndcsEvidenceBuckets: (parse(ndcsBucketsRaw).data || []).map(item => item.name).sort(),
    nosqlTables: ndcsItems.map(item => ({ id: item.id, name: item.name, state: item["lifecycle-state"], capacityMode: item["table-limits"]?.["capacity-mode"] || "PROVISIONED", readUnits: item["table-limits"]?.["max-read-units"], writeUnits: item["table-limits"]?.["max-write-units"], storageGB: item["table-limits"]?.["max-storage-in-g-bs"], autoscaling: { mode: "NOT_DETECTED" }, tableSizeBytes: null, itemCount: null })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
