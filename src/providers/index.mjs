import { createMockProvider } from "./mock.mjs";
import { createDynamoProvider } from "./dynamodb.mjs";
import { createOciNoSqlProvider } from "./oci-nosql.mjs";

export function createProvider(options) {
  if (options.target === "mock") return createMockProvider(options);
  if (options.target === "aws") return createDynamoProvider(options);
  if (options.target === "adb") return createDynamoProvider({ ...options, endpoint: options.endpoint || process.env.DDB_ENDPOINT });
  if (options.target === "ndcs") return createOciNoSqlProvider(options);
  throw new Error(`Unsupported target: ${options.target}`);
}

