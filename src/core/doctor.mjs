import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { createCapacityProvider } from "../capacity/providers.mjs";

function endpointHost(target, endpoint) {
  if (target === "adb") return endpoint ? new URL(endpoint).hostname : null;
  if (target === "aws") return `dynamodb.${process.env.AWS_REGION || "us-east-1"}.amazonaws.com`;
  if (target === "ndcs") return `nosql.${process.env.OCI_REGION || "us-ashburn-1"}.oci.oraclecloud.com`;
  return null;
}

async function tcpCheck(host, timeoutMs = 3000) {
  const addresses = await dns.lookup(host, { all: true });
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: 443 });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("TCP timeout")); }, timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(); });
    socket.once("error", error => { clearTimeout(timer); reject(error); });
  });
  return addresses.map(value => value.address);
}

function expectedCapacity(config, target) {
  if (target === "aws") return { read: config.capacity?.awsDynamodb?.readCapacityUnits, write: config.capacity?.awsDynamodb?.writeCapacityUnits };
  if (target === "adb") return { read: config.capacity?.adbDynamodbApi?.readCapacityUnits, write: config.capacity?.adbDynamodbApi?.writeCapacityUnits };
  if (target === "ndcs") return { read: config.capacity?.ociNosql?.readUnits, write: config.capacity?.ociNosql?.writeUnits, storageGB: config.capacity?.ociNosql?.storageGb };
  return null;
}

function schemaMatches(target, observed) {
  if (["aws", "adb"].includes(target)) {
    const keys = Object.fromEntries((observed.keySchema || []).map(value => [value.AttributeName, value.KeyType]));
    const types = Object.fromEntries((observed.attributeDefinitions || []).map(value => [value.AttributeName, value.AttributeType]));
    return keys.pk === "HASH" && keys.sk === "RANGE" && types.pk === "S" && types.sk === "S";
  }
  const schema = observed.schema || {}; const primary = schema["primary-key"] || schema.primaryKey || [];
  const shard = schema["shard-key"] || schema.shardKey || [];
  const columns = Object.fromEntries((schema.columns || schema.fields || []).map(value => [value.name, String(value.type).toUpperCase()]));
  return primary.join(",") === "pk,sk" && shard.join(",") === "pk" && columns.pk === "STRING" && columns.sk === "STRING" && columns.version === "LONG" && columns.payload === "STRING";
}

function clockEvidence(file) {
  if (!file) return { passed: false, detail: "--clock-evidence is required for cloud targets" };
  try {
    const raw = fs.readFileSync(file, "utf8");
    const leap = raw.match(/Leap status\s*:\s*([^\r\n]+)/i)?.[1]?.trim();
    const system = raw.match(/System time\s*:\s*([0-9.eE+-]+)\s+seconds\s+(fast|slow)/i);
    const offsetSeconds = system ? Number(system[1]) * (system[2].toLowerCase() === "slow" ? -1 : 1) : null;
    return { passed: leap === "Normal" && Number.isFinite(offsetSeconds) && Math.abs(offsetSeconds) <= 0.05, detail: { leapStatus: leap || null, offsetSeconds } };
  } catch (error) { return { passed: false, detail: error.message }; }
}

export async function doctor({ config, target, table, endpoint, skipNetwork = false, hostEvidence, capacityProvider }) {
  const checks = [];
  const check = (name, passed, detail, required = true) => checks.push({ name, passed: Boolean(passed), required, detail });
  const major = Number(process.versions.node.split(".")[0]);
  check("node-version", major >= 22, process.version);
  check("cpu-headroom", os.cpus().length >= 4, `${os.cpus().length} logical CPUs`, false);
  check("memory-headroom", os.totalmem() >= 12 * 1024 ** 3, `${(os.totalmem() / 1024 ** 3).toFixed(2)} GiB visible`, false);
  check("configuration", Boolean(config?.name), config?.name || null);
  check("target", ["mock", "aws", "adb", "ndcs"].includes(target), target);
  if (target === "aws") check("aws-region", Boolean(process.env.AWS_REGION), process.env.AWS_REGION || "AWS_REGION missing");
  if (target === "adb") {
    check("adb-endpoint", Boolean(endpoint || process.env.DDB_ENDPOINT), endpoint || process.env.DDB_ENDPOINT || "DDB_ENDPOINT missing");
    check("adb-access-key", Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY), "short-lived key required; values not displayed");
  }
  if (target === "ndcs") {
    check("oci-region", Boolean(process.env.OCI_REGION), process.env.OCI_REGION || "OCI_REGION missing");
    check("oci-compartment", Boolean(process.env.OCI_COMPARTMENT_ID), process.env.OCI_COMPARTMENT_ID ? "configured" : "OCI_COMPARTMENT_ID missing");
    const auth = process.env.OCI_USE_INSTANCE_PRINCIPAL === "true" || Boolean(process.env.OCI_CONFIG_FILE);
    check("oci-auth", auth, process.env.OCI_USE_INSTANCE_PRINCIPAL === "true" ? "instance principal" : process.env.OCI_CONFIG_FILE ? "mounted OCI config" : "auth configuration missing");
  }
  if (target !== "mock") {
    check("table-name", Boolean(table), table || "--table missing");
    const time = clockEvidence(hostEvidence); check("host-clock", time.passed, time.detail);
    if (table) {
      let provider = capacityProvider;
      try {
        provider ||= createCapacityProvider({ target, table, endpoint });
        const observed = await provider.inspect(); const expected = expectedCapacity(config, target);
        check("table-state", observed.state === "ACTIVE", observed.state);
        check("capacity-mode", observed.capacityMode === "PROVISIONED", observed.capacityMode);
        check("table-schema", schemaMatches(target, observed), { expected: "pk HASH/SHARD + sk RANGE, canonical attributes", observed: target === "ndcs" ? observed.schema : observed.keySchema });
        const fields = target === "ndcs" ? ["read", "write", "storageGB"] : ["read", "write"];
        const declared = fields.filter(field => expected?.[field] != null), observedCapacity = Object.fromEntries(fields.map(field => [field, observed[field]]));
        if (declared.length) check("provisioned-capacity", declared.every(field => Number(observed[field]) === Number(expected[field])), { expected, observed: observedCapacity });
        else check("provisioned-capacity", true, { expected: "not asserted by workload configuration", observed: observedCapacity }, false);
      } catch (error) { check("table-inspection", false, { name: error.name, message: error.message }); }
      finally { if (!capacityProvider && provider) await provider.close(); }
    }
  }
  try {
    const host = endpointHost(target, endpoint || process.env.DDB_ENDPOINT);
    if (host && !skipNetwork) {
      try { check("endpoint-443", true, { host, addresses: await tcpCheck(host) }); }
      catch (error) { check("endpoint-443", false, { host, error: error.message }); }
    } else check("endpoint-443", true, skipNetwork ? "skipped by request" : "not applicable", false);
  } catch (error) {
    check("endpoint-443", false, { error: `invalid endpoint: ${error.message}` });
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    image: { version: process.env.KVS_IMAGE_VERSION || "local", revision: process.env.KVS_IMAGE_REVISION || "local" },
    target,
    configName: config.name,
    checks,
    limitations: ["Does not create or modify infrastructure", "Does not prove capacity-update permission because a no-op UpdateTable is still mutating", "Provider monitoring is collected separately"],
  };
  report.ready = checks.filter(value => value.required).every(value => value.passed);
  return report;
}
