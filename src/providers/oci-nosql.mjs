import nosqldb from "oracle-nosqldb";
const { NoSQLClient, Consistency } = nosqldb;

export const noSqlRetryConfig = maxAttempts => maxAttempts <= 1 ? { handler: null } : { maxRetries: maxAttempts - 1 };

export async function createOciNoSqlProvider({ config, table }) {
  if (!process.env.OCI_COMPARTMENT_ID) throw new Error("OCI_COMPARTMENT_ID is required");
  const payload = "x".repeat(config.dataset.payloadBytes);
  const iam = process.env.OCI_USE_INSTANCE_PRINCIPAL === "true" ? { useInstancePrincipal: true } : { configFile: process.env.OCI_CONFIG_FILE, profileName: process.env.OCI_PROFILE };
  const client = new NoSQLClient({ region: process.env.OCI_REGION || "us-ashburn-1", compartment: process.env.OCI_COMPARTMENT_ID, timeout: config.client.requestTimeoutMs, consistency: config.workload.consistency === "strong" ? Consistency.ABSOLUTE : Consistency.EVENTUAL, retry: noSqlRetryConfig(config.client.maxAttempts), auth: { iam } });
  return {
    async read(key) {
      const result = await client.get(table, key, { consistency: config.workload.consistency === "strong" ? Consistency.ABSOLUTE : Consistency.EVENTUAL });
      const attributes = result.row ? Object.keys(result.row).sort() : [];
      const version = Number(result.row?.version);
      if (!result.row || JSON.stringify(attributes) !== JSON.stringify(["payload", "pk", "sk", "version"]) || result.row.pk !== key.pk || result.row.sk !== key.sk || result.row.payload !== payload || !Number.isFinite(version)) throw Object.assign(new Error("Canonical item mismatch"), { name: "CorrectnessMismatch" });
      return { key, version, payload: result.row.payload, attempts: 1, readUnits: result.consumedCapacity?.readUnits || 0, rateLimitDelayMs: result.consumedCapacity?.readRateLimitDelay || 0 };
    },
    async write(key, version) {
      const result = await client.put(table, { ...key, version, payload });
      return { key, version, payload, attempts: 1, writeUnits: result.consumedCapacity?.writeUnits || 0, rateLimitDelayMs: result.consumedCapacity?.writeRateLimitDelay || 0 };
    },
    async close() { await client.close(); }
  };
}
