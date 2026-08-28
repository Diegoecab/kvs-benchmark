export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(p / 100 * sorted.length) - 1)].toFixed(3));
}

export function distribution(values) {
  let max = null;
  for (const value of values) {
    if (max === null || value > max) max = value;
  }
  return { samples: values.length, p50: percentile(values, 50), p95: percentile(values, 95), p99: percentile(values, 99), p999: percentile(values, 99.9), max: max === null ? null : Number(max.toFixed(3)) };
}
