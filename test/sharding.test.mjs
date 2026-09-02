import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { normalizeShardOptions } from "../src/core/sharding.mjs";

test("shard option normalization accepts zero-based indexes within a positive count", () => {
  assert.deepEqual(normalizeShardOptions(), { count: 1, index: 0 });
  assert.deepEqual(normalizeShardOptions({ shardCount: "3", shardIndex: "2" }), { count: 3, index: 2 });
  assert.throws(() => normalizeShardOptions({ shardCount: 0, shardIndex: 0 }), /positive integer/);
  assert.throws(() => normalizeShardOptions({ shardCount: 2, shardIndex: 2 }), /less than shardCount/);
  assert.throws(() => normalizeShardOptions({ shardCount: 2, shardIndex: -1 }), /non-negative integer/);
});

test("CLI requires shard count and index together", () => {
  const result = spawnSync(process.execPath, ["src/cli.mjs", "run", "--shard-count=2"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--shard-count and --shard-index must be provided together/);
});
