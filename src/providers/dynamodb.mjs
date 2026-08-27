import https from "node:https";
import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { NodeHttpHandler } from "@smithy/node-http-handler";

export async function createDynamoProvider({ config, table, endpoint }) {
  const payload = "x".repeat(config.dataset.payloadBytes);
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION || (endpoint ? "us-ashburn-1" : "us-east-1"),
    endpoint: endpoint || undefined,
    maxAttempts: config.client.maxAttempts,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: config.client.connectionTimeoutMs,
      requestTimeout: config.client.requestTimeoutMs,
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: config.client.maxConnections })
    })
  });
  return {
    async read(key) {
      const result = await client.send(new GetItemCommand({ TableName: table, Key: { pk: { S: key.pk }, sk: { S: key.sk } }, ConsistentRead: config.workload.consistency === "strong", ReturnConsumedCapacity: "TOTAL" }));
      const version = Number(result.Item?.version?.N);
      const attributes = result.Item ? Object.keys(result.Item).sort() : [];
      if (!result.Item || JSON.stringify(attributes) !== JSON.stringify(["payload", "pk", "sk", "version"]) || result.Item.pk?.S !== key.pk || result.Item.sk?.S !== key.sk || result.Item.payload?.S !== payload || !Number.isFinite(version)) throw Object.assign(new Error("Canonical item mismatch"), { name: "CorrectnessMismatch" });
      return { key, version, payload: result.Item.payload.S, attempts: result.$metadata?.attempts || 1, readUnits: result.ConsumedCapacity?.CapacityUnits || 0 };
    },
    async write(key, version) {
      const result = await client.send(new PutItemCommand({ TableName: table, Item: { pk: { S: key.pk }, sk: { S: key.sk }, version: { N: String(version) }, payload: { S: payload } }, ReturnConsumedCapacity: "TOTAL" }));
      return { key, version, payload, attempts: result.$metadata?.attempts || 1, writeUnits: result.ConsumedCapacity?.CapacityUnits || 0 };
    },
    async close() { client.destroy(); }
  };
}
