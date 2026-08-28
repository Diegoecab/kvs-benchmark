import test from "node:test";
import assert from "node:assert/strict";
import nosqldb from "oracle-nosqldb";
import { noSqlRetryConfig } from "../src/providers/oci-nosql.mjs";

test("OCI NoSQL disables SDK retries for one-attempt benchmark profiles", async () => {
  assert.deepEqual(noSqlRetryConfig(1), { handler: null });
  assert.deepEqual(noSqlRetryConfig(3), { maxRetries: 2 });
  const client = new nosqldb.NoSQLClient({
    region: "us-ashburn-1",
    compartment: "test-compartment",
    retry: noSqlRetryConfig(1),
    auth: { provider: async () => "test-authorization" },
  });
  assert.ok(client);
  await client.close();
});
