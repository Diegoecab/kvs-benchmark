export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(p / 100 * sorted.length) - 1)].toFixed(3));
}

export function distribution(values) {
  return { samples: values.length, p50: percentile(values, 50), p95: percentile(values, 95), p99: percentile(values, 99), p999: percentile(values, 99.9), max: values.length ? Number(Math.max(...values).toFixed(3)) : null };
}

