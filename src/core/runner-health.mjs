import fs from "node:fs";
import path from "node:path";

const fixed = value => Number(value.toFixed(3));
const read = (root, name) => fs.readFileSync(path.join(root, name), "utf8");

function cpuSnapshot(root) {
  const fields = read(root, "stat").split(/\r?\n/, 1)[0].trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 5 || fields.some(value => !Number.isFinite(value))) throw new Error("invalid procfs CPU counters");
  return { total: fields.reduce((sum, value) => sum + value, 0), idle: fields[3] + fields[4], logicalCpuCount: read(root, "stat").split(/\r?\n/).filter(line => /^cpu\d+\s/.test(line)).length };
}

function memorySnapshot(root) {
  const values = Object.fromEntries(read(root, "meminfo").split(/\r?\n/).map(line => /^([^:]+):\s+(\d+)\s+kB$/.exec(line)).filter(Boolean).map(match => [match[1], Number(match[2]) * 1024]));
  if (!values.MemTotal || !Number.isFinite(values.MemAvailable)) throw new Error("invalid procfs memory counters");
  return { totalBytes: values.MemTotal, availableBytes: values.MemAvailable, utilizationPercent: fixed((values.MemTotal - values.MemAvailable) * 100 / values.MemTotal) };
}

function networkSnapshot(root) {
  let receivedBytes = 0, transmittedBytes = 0;
  for (const line of read(root, path.join("net", "dev")).split(/\r?\n/).slice(2)) {
    const match = /^\s*([^:]+):\s*(.+)$/.exec(line); if (!match || match[1].trim() === "lo") continue;
    const fields = match[2].trim().split(/\s+/).map(Number); if (fields.length < 9) continue;
    receivedBytes += fields[0]; transmittedBytes += fields[8];
  }
  return { receivedBytes, transmittedBytes };
}

export class RunnerHealthSampler {
  constructor({ procRoot = process.env.KVS_HOST_PROC || "/proc", now = () => Date.now() } = {}) { this.procRoot = procRoot; this.now = now; this.previous = null; }
  sample() {
    try {
      const at = this.now(), cpu = cpuSnapshot(this.procRoot), memory = memorySnapshot(this.procRoot), network = networkSnapshot(this.procRoot), loadAverage1m = Number(read(this.procRoot, "loadavg").trim().split(/\s+/, 1)[0]);
      const current = { at, cpu, network }, elapsedSeconds = this.previous ? (at - this.previous.at) / 1000 : 0;
      const cpuTotalDelta = this.previous ? cpu.total - this.previous.cpu.total : 0, cpuIdleDelta = this.previous ? cpu.idle - this.previous.cpu.idle : 0;
      const cpuUtilizationPercent = cpuTotalDelta > 0 ? fixed(Math.max(0, Math.min(100, (cpuTotalDelta - cpuIdleDelta) * 100 / cpuTotalDelta))) : null;
      const rate = (value, previous) => elapsedSeconds > 0 && value >= previous ? fixed((value - previous) / elapsedSeconds) : null;
      const result = { available: true, scope: "runner-vm", cpuUtilizationPercent, memoryUtilizationPercent: memory.utilizationPercent, memoryTotalBytes: memory.totalBytes, memoryAvailableBytes: memory.availableBytes, loadAverage1m: Number.isFinite(loadAverage1m) ? loadAverage1m : null, logicalCpuCount: cpu.logicalCpuCount || null, networkReceiveBytesPerSecond: this.previous ? rate(network.receivedBytes, this.previous.network.receivedBytes) : null, networkTransmitBytesPerSecond: this.previous ? rate(network.transmittedBytes, this.previous.network.transmittedBytes) : null };
      this.previous = current; return result;
    } catch { return { available: false, scope: "runner-vm" }; }
  }
}
