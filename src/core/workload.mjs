export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildOperationStream(config) {
  const random = mulberry32(config.dataset.seed);
  const operations = [];
  let sequence = 0;
  let offsetMs = 0;
  for (const [stepIndex, step] of config.load.schedule.entries()) {
    const count = Math.floor(step.seconds * step.operationsPerSecond);
    for (let index = 0; index < count; index += 1) {
      const choice = random() * 100;
      operations.push({
        sequence: sequence++,
        step: stepIndex + 1,
        offeredRate: step.operationsPerSecond,
        offsetMs: offsetMs + index * 1000 / step.operationsPerSecond,
        operation: choice < config.workload.readPercent ? "read" : "write",
        keyIndex: Math.floor(random() * config.dataset.keyCount),
      });
    }
    offsetMs += step.seconds * 1000;
  }
  return operations;
}

export function canonicalKey(index, buckets) {
  return { pk: `shard-${index % buckets}`, sk: `item-${index}` };
}

