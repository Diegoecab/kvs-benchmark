export function normalizeShardOptions({ shardCount = 1, shardIndex = 0 } = {}) {
  const count = Number(shardCount);
  const index = Number(shardIndex);
  if (!Number.isInteger(count) || count < 1) throw new Error("shardCount must be a positive integer");
  if (!Number.isInteger(index) || index < 0) throw new Error("shardIndex must be a non-negative integer");
  if (index >= count) throw new Error("shardIndex must be less than shardCount");
  return { count, index };
}
