export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return percentileFromSorted(sorted, p);
}

function percentileFromSorted(sorted, p) {
  return Number(sorted[Math.max(0, Math.ceil(p / 100 * sorted.length) - 1)].toFixed(3));
}

export function distribution(values) {
  if (!values.length) return { samples: 0, p50: null, p95: null, p99: null, p999: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.length, p50: percentileFromSorted(sorted, 50), p95: percentileFromSorted(sorted, 95), p99: percentileFromSorted(sorted, 99), p999: percentileFromSorted(sorted, 99.9), max: Number(sorted.at(-1).toFixed(3)) };
}
