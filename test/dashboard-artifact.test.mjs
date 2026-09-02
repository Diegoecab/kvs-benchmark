import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createZip, createZipFile, inspectFile } from "../src/dashboard/artifact.mjs";

function storedZipEntries(archive) {
  let end = archive.length - 22;
  while (end >= 0 && archive.readUInt32LE(end) !== 0x06054b50) end -= 1;
  assert.ok(end >= 0, "end-of-central-directory record is present");
  const count = archive.readUInt16LE(end + 10), centralOffset = archive.readUInt32LE(end + 16), result = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    const size = archive.readUInt32LE(cursor + 24), nameLength = archive.readUInt16LE(cursor + 28), extraLength = archive.readUInt16LE(cursor + 30), commentLength = archive.readUInt16LE(cursor + 32), localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    assert.equal(archive.readUInt32LE(localOffset), 0x04034b50);
    const localNameLength = archive.readUInt16LE(localOffset + 26), localExtraLength = archive.readUInt16LE(localOffset + 28), dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    result.set(name, archive.subarray(dataOffset, dataOffset + size));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

test("streaming ZIP stores file entries without using readFileSync", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-streaming-zip-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "operations.ndjson"), output = path.join(root, "package.zip");
  const block = Buffer.from(`${JSON.stringify({ operation: "read", payload: "x".repeat(1000) })}\n`);
  const handle = fs.openSync(source, "w");
  try { for (let index = 0; index < 4096; index += 1) fs.writeSync(handle, block); } finally { fs.closeSync(handle); }
  const inspected = await inspectFile(source);
  assert.equal(inspected.bytes, block.length * 4096);
  assert.equal(inspected.sha256, crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex"));

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function guardedReadFileSync(file, ...args) {
    if (path.resolve(String(file)) === path.resolve(source)) throw new Error("large evidence was buffered");
    return originalReadFileSync.call(this, file, ...args);
  };
  try {
    await createZipFile(output, [
      { name: "evidence\\operations.ndjson", sourcePath: source, bytes: inspected.bytes, crc32: inspected.crc32 },
      { name: "manifest-sha256.json", data: "{}\n" },
      { name: "empty.txt", data: Buffer.alloc(0) },
    ]);
  } finally { fs.readFileSync = originalReadFileSync; }

  const entries = storedZipEntries(fs.readFileSync(output));
  assert.deepEqual([...entries.keys()], ["evidence/operations.ndjson", "manifest-sha256.json", "empty.txt"]);
  assert.equal(entries.get("evidence/operations.ndjson").length, inspected.bytes);
  assert.equal(entries.get("manifest-sha256.json").toString("utf8"), "{}\n");
  assert.equal(entries.get("empty.txt").length, 0);
  await createZipFile(output, [{ name: "replacement.txt", data: "replacement" }]);
  assert.equal(storedZipEntries(fs.readFileSync(output)).get("replacement.txt").toString("utf8"), "replacement");
});

test("existing in-memory createZip API remains available", () => {
  const entries = storedZipEntries(createZip([{ name: "summary.json", data: '{"ok":true}\n' }]));
  assert.equal(entries.get("summary.json").toString("utf8"), '{"ok":true}\n');
});
