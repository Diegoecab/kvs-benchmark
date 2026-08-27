import dns from "node:dns/promises";
import net from "node:net";
import os from "node:os";

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

export async function doctor({ config, target, endpoint, skipNetwork = false }) {
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
  try {
    const host = endpointHost(target, endpoint || process.env.DDB_ENDPOINT);
    if (host && !skipNetwork) {
      try { check("endpoint-443", true, { host, addresses: await tcpCheck(host) }); }
      catch (error) { check("endpoint-443", false, { host, error: error.message }); }
    } else check("endpoint-443", true, skipNetwork ? "skipped by request" : "not applicable", false);
  } catch (error) {
    check("endpoint-443", false, { error: `invalid endpoint: ${error.message}` });
  }
  check("ntp", false, "must be verified on the host and included in run evidence", false);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    image: { version: process.env.KVS_IMAGE_VERSION || "local", revision: process.env.KVS_IMAGE_REVISION || "local" },
    target,
    configName: config.name,
    checks,
    limitations: ["Does not create or modify infrastructure", "Does not inspect table schema or capacity yet", "NTP must be verified on the host"],
  };
  report.ready = checks.filter(value => value.required).every(value => value.passed);
  return report;
}
