import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/core/config.mjs";
import { buildOperationStream } from "../src/core/workload.mjs";

test("operation stream is deterministic", () => {
  const { config } = readConfig(new URL("../configs/smoke.json", import.meta.url));
  assert.deepEqual(buildOperationStream(config), buildOperationStream(config));
  assert.equal(buildOperationStream(config).length, 20);
});

