import { DynamoDBClient, DescribeTableCommand, UpdateTableCommand } from "@aws-sdk/client-dynamodb";
import nosqldb from "oracle-nosqldb";

const { NoSQLClient } = nosqldb;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function dynamoClient(target, endpoint) {
  return new DynamoDBClient({
    region: process.env.AWS_REGION || (target === "aws" ? "us-east-1" : "us-ashburn-1"),
    endpoint: target === "adb" ? endpoint || process.env.DDB_ENDPOINT : undefined,
    maxAttempts: 1,
  });
}

export function createCapacityProvider({ target, table, endpoint, timeoutMs = 600_000 }) {
  if (["aws", "adb"].includes(target)) {
    if (target === "adb" && !(endpoint || process.env.DDB_ENDPOINT)) throw new Error("DDB_ENDPOINT is required for ADB");
    const client = dynamoClient(target, endpoint);
    const inspect = async () => {
      const result = await client.send(new DescribeTableCommand({ TableName: table }));
      return {
        state: result.Table?.TableStatus,
        read: result.Table?.ProvisionedThroughput?.ReadCapacityUnits,
        write: result.Table?.ProvisionedThroughput?.WriteCapacityUnits,
      };
    };
    return {
      inspect,
      async apply(capacity) {
        await client.send(new UpdateTableCommand({ TableName: table, ProvisionedThroughput: { ReadCapacityUnits: capacity.read, WriteCapacityUnits: capacity.write } }));
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const observed = await inspect();
          if (observed.state === "ACTIVE" && observed.read === capacity.read && observed.write === capacity.write) return observed;
          await sleep(1000);
        }
        throw new Error(`Capacity ${capacity.read}/${capacity.write} was not active before timeout`);
      },
      close() { client.destroy(); },
    };
  }
  if (target === "ndcs") {
    if (!process.env.OCI_COMPARTMENT_ID) throw new Error("OCI_COMPARTMENT_ID is required");
    const client = new NoSQLClient({
      region: process.env.OCI_REGION || "us-ashburn-1",
      compartment: process.env.OCI_COMPARTMENT_ID,
      timeout: 15_000,
      retry: { maxRetries: 0 },
      auth: { iam: process.env.OCI_USE_INSTANCE_PRINCIPAL === "true" ? { useInstancePrincipal: true } : { configFile: process.env.OCI_CONFIG_FILE, profileName: process.env.OCI_PROFILE } },
    });
    const inspect = async () => {
      const result = await client.getTable(table);
      return { state: result.tableState, read: result.tableLimits?.readUnits, write: result.tableLimits?.writeUnits, storageGB: result.tableLimits?.storageGB };
    };
    return {
      inspect,
      async apply(capacity) {
        await client.setTableLimits(table, { readUnits: capacity.read, writeUnits: capacity.write, storageGB: capacity.storageGB }, { complete: true, delay: 1000 });
        return inspect();
      },
      async close() { await client.close(); },
    };
  }
  throw new Error(`Unsupported capacity target: ${target}`);
}
