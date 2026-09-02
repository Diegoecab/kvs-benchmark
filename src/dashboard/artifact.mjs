import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const escaped = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const fixed = value => value == null ? "-" : Number(value).toLocaleString("en-US", { maximumFractionDigits: 3 });

function reportHtml(state) {
  const summary = state.summary;
  const latency = summary.successfulServiceLatencyMs || {};
  const rows = [
    ["Run ID", state.id], ["Execution mode", state.mode], ["Status", state.status],
    ["Scheduled operations", summary.scheduled], ["Completed operations", summary.completed], ["Failed operations", summary.failed],
    ["Duration seconds", summary.durationSeconds], ["Achieved operations/s", summary.achievedOperationsPerSecond],
    ["P50 latency ms", latency.p50], ["P95 latency ms", latency.p95], ["P99 latency ms", latency.p99], ["Maximum latency ms", latency.max],
    ["Harness passed", summary.harnessPassed], ["Actual start UTC", summary.actualStartAt], ["Actual end UTC", summary.actualEndAt],
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KVS local smoke benchmark</title><style>body{max-width:960px;margin:40px auto;padding:0 20px;color:#14222b;font:15px/1.5 system-ui,sans-serif}h1{margin-bottom:4px}.ok{display:inline-block;background:#dff7eb;color:#125a3b;padding:6px 10px;border-radius:999px;font-weight:700}table{width:100%;border-collapse:collapse;margin:24px 0}th,td{text-align:left;border-bottom:1px solid #d7e0e4;padding:9px}th{width:45%;background:#f3f6f7}code{background:#eef2f3;padding:2px 5px;border-radius:4px}.note{border-left:4px solid #176987;background:#edf6f9;padding:12px 14px}</style></head><body><p>LOCAL BENCHMARK ARTIFACT</p><h1>KVS local smoke benchmark</h1><span class="ok">${escaped(state.status.toUpperCase())}</span><p class="note">Client-observed open-loop execution against the in-memory mock provider. No AWS or OCI service was contacted. Latency is measured around each provider call and excludes scheduler queue delay.</p><table><tbody>${rows.map(([label, value]) => `<tr><th>${escaped(label)}</th><td>${escaped(typeof value === "number" ? fixed(value) : value)}</td></tr>`).join("")}</tbody></table><h2>Evidence index</h2><ul><li><code>operations.ndjson</code> — one record per scheduled operation.</li><li><code>telemetry.ndjson</code> — client in-flight and memory samples.</li><li><code>summary.json</code> — final accounting and latency percentiles.</li><li><code>run-config.json</code> — effective versioned workload configuration.</li><li><code>manifest-sha256.json</code> — hashes for integrity verification.</li></ul></body></html>`;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function updateCrc32(value, buffer) {
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

function dosTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return { time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2), date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() };
}

export function createZip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll("\\", "/"), "utf8"), data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data), crc = crc32(data), stamp = dosTime();
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8); local.writeUInt16LE(stamp.time, 10); local.writeUInt16LE(stamp.date, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(stamp.time, 12); central.writeUInt16LE(stamp.date, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, name); offset += local.length + name.length + data.length;
  }
  const centralSize = centrals.reduce((sum, value) => sum + value.length, 0), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

async function writeAll(handle, buffer) {
  let written = 0;
  while (written < buffer.length) {
    const result = await handle.write(buffer, written, buffer.length - written, null);
    if (!result.bytesWritten) throw new Error("Unable to make progress while writing ZIP archive");
    written += result.bytesWritten;
  }
}

function normalizedEntryName(value) {
  const name = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!name || name.split("/").includes("..")) throw new Error(`Unsafe ZIP entry name: ${value}`);
  return name;
}

function entryBuffer(entry) {
  if (entry.data == null) return null;
  return Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
}

export async function inspectFile(file) {
  const sha256 = crypto.createHash("sha256");
  let bytes = 0, crc = 0xffffffff;
  for await (const chunk of fs.createReadStream(file)) {
    bytes += chunk.length;
    sha256.update(chunk);
    crc = updateCrc32(crc, chunk);
  }
  return { bytes, sha256: sha256.digest("hex"), crc32: (crc ^ 0xffffffff) >>> 0 };
}

async function inspectZipEntry(entry) {
  const data = entryBuffer(entry);
  if (data !== null) return { bytes: data.length, crc32: crc32(data), data };
  if (!entry.sourcePath) throw new Error(`ZIP entry ${entry.name} requires data or sourcePath`);
  if (entry.bytes != null && entry.crc32 != null) return { bytes: Number(entry.bytes), crc32: Number(entry.crc32) >>> 0, data: null };
  const inspected = await inspectFile(entry.sourcePath);
  return { bytes: inspected.bytes, crc32: inspected.crc32, data: null };
}

/**
 * Writes an uncompressed ZIP archive without buffering file contents in memory.
 * File entries use { name, sourcePath }; callers that already scanned a file may
 * also supply bytes and crc32 to avoid a second metadata pass.
 */
export async function createZipFile(outputFile, entries) {
  if (entries.length > 0xffff) throw new Error("ZIP32 supports at most 65535 entries");
  const prepared = [];
  for (const entry of entries) {
    const name = normalizedEntryName(entry.name), metadata = await inspectZipEntry(entry);
    if (!Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0 || metadata.bytes > 0xffffffff) throw new Error(`ZIP32 entry is too large: ${name}`);
    prepared.push({ ...entry, ...metadata, name, encodedName: Buffer.from(name, "utf8") });
  }

  const temporaryFile = `${outputFile}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const handle = await fs.promises.open(temporaryFile, "wx");
  const centrals = [];
  let offset = 0;
  try {
    for (const entry of prepared) {
      if (entry.encodedName.length > 0xffff) throw new Error(`ZIP entry name is too long: ${entry.name}`);
      if (offset > 0xffffffff) throw new Error("ZIP32 archive exceeds the 4 GiB offset limit");
      const stamp = dosTime(entry.mtime || new Date()), flags = 0x0800;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(0, 8); local.writeUInt16LE(stamp.time, 10); local.writeUInt16LE(stamp.date, 12); local.writeUInt32LE(entry.crc32, 14); local.writeUInt32LE(entry.bytes, 18); local.writeUInt32LE(entry.bytes, 22); local.writeUInt16LE(entry.encodedName.length, 26); local.writeUInt16LE(0, 28);
      await writeAll(handle, local); await writeAll(handle, entry.encodedName);
      if (entry.data !== null) await writeAll(handle, entry.data);
      else {
        let streamedBytes = 0, streamedCrc = 0xffffffff;
        for await (const chunk of fs.createReadStream(entry.sourcePath)) {
          streamedBytes += chunk.length; streamedCrc = updateCrc32(streamedCrc, chunk); await writeAll(handle, chunk);
        }
        streamedCrc = (streamedCrc ^ 0xffffffff) >>> 0;
        if (streamedBytes !== entry.bytes || streamedCrc !== entry.crc32) throw new Error(`ZIP source changed while it was being packaged: ${entry.name}`);
      }

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(stamp.time, 12); central.writeUInt16LE(stamp.date, 14); central.writeUInt32LE(entry.crc32, 16); central.writeUInt32LE(entry.bytes, 20); central.writeUInt32LE(entry.bytes, 24); central.writeUInt16LE(entry.encodedName.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
      centrals.push(central, entry.encodedName);
      offset += local.length + entry.encodedName.length + entry.bytes;
    }
    const centralOffset = offset;
    for (const value of centrals) { await writeAll(handle, value); offset += value.length; }
    const centralSize = offset - centralOffset;
    if (centralOffset > 0xffffffff || centralSize > 0xffffffff) throw new Error("ZIP32 archive exceeds the 4 GiB limit");
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(centralOffset, 16); end.writeUInt16LE(0, 20);
    await writeAll(handle, end); await handle.sync(); await handle.close();
    await fs.promises.rename(temporaryFile, outputFile);
    return outputFile;
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.promises.unlink(temporaryFile).catch(() => {});
    throw error;
  }
}

export function finalizeLocalArtifact(state) {
  const reportFile = path.join(state.output, "index.html");
  fs.writeFileSync(reportFile, reportHtml(state));
  const evidenceNames = ["index.html", "operations.ndjson", "telemetry.ndjson", "summary.json", "run-config.json"];
  const manifest = { schemaVersion: 1, generatedAt: new Date().toISOString(), runId: state.id, entries: evidenceNames.map(name => { const data = fs.readFileSync(path.join(state.output, name)); return { path: name, bytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") }; }) };
  fs.writeFileSync(path.join(state.output, "manifest-sha256.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const archiveNames = [...evidenceNames, "manifest-sha256.json"];
  const archive = createZip(archiveNames.map(name => ({ name, data: fs.readFileSync(path.join(state.output, name)) })));
  const archiveFile = path.join(state.output, `${state.id}-benchmark-output.zip`);
  fs.writeFileSync(archiveFile, archive);
  return { reportFile, archiveFile, manifest };
}
