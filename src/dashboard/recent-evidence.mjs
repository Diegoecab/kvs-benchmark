import fs from "node:fs";
import path from "node:path";

const skippedDirectories = new Set([".git", "node_modules"]);

export function readRecentEvidenceTables({ root, maxDepth = 10, maxCertificates = 250 } = {}) {
  const rows = [], pending = root ? [{ directory: root, depth: 0 }] : [];
  while (pending.length && rows.length < maxCertificates) {
    const { directory, depth } = pending.pop();
    let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (rows.length >= maxCertificates) break;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (depth < maxDepth && !skippedDirectories.has(entry.name)) pending.push({ directory: file, depth: depth + 1 }); continue; }
      if (!entry.isFile() || !entry.name.endsWith("dataset-certificate.json")) continue;
      try {
        if (fs.statSync(file).size > 1024 * 1024) continue;
        const certificate = JSON.parse(fs.readFileSync(file, "utf8")), target = certificate.target, table = certificate.table;
        if (!["aws", "adb", "ndcs"].includes(target) || !/^[A-Za-z0-9_.-]+$/.test(table || "")) continue;
        rows.push({ target, table, observedAt: certificate.endedAt || certificate.generatedAt || null });
      } catch { /* Ignore incomplete or unrelated evidence. */ }
    }
  }
  const latest = new Map();
  for (const row of rows) { const key = `${row.target}:${row.table}`, current = latest.get(key); if (!current || String(row.observedAt || "") > String(current.observedAt || "")) latest.set(key, row); }
  const result = { aws: [], adb: [], ndcs: [] };
  for (const row of latest.values()) result[row.target].push({ table: row.table, observedAt: row.observedAt });
  for (const target of Object.keys(result)) result[target].sort((a, b) => String(b.observedAt || "").localeCompare(String(a.observedAt || "")) || a.table.localeCompare(b.table));
  return result;
}
