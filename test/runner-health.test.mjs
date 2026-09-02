import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunnerHealthSampler } from "../src/core/runner-health.mjs";

test("runner health samples CPU, memory, load, and non-loopback network rates", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvs-runner-health-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.mkdirSync(path.join(root, "net"));
  const write = ({ cpu, received, transmitted }) => {
    fs.writeFileSync(path.join(root, "stat"), `cpu  ${cpu.user} 0 ${cpu.system} ${cpu.idle} 0 0 0 0\ncpu0 1 0 1 1 0 0 0 0\ncpu1 1 0 1 1 0 0 0 0\n`);
    fs.writeFileSync(path.join(root, "meminfo"), "MemTotal:       1000000 kB\nMemAvailable:    750000 kB\n");
    fs.writeFileSync(path.join(root, "loadavg"), "0.42 0.21 0.10 1/100 123\n");
    fs.writeFileSync(path.join(root, "net", "dev"), `Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n    lo: 100 0 0 0 0 0 0 0 100 0 0 0 0 0 0 0\n  eth0: ${received} 0 0 0 0 0 0 0 ${transmitted} 0 0 0 0 0 0 0\n`);
  };
  let now = 1000; write({ cpu: { user: 100, system: 50, idle: 850 }, received: 1000, transmitted: 2000 }); const sampler = new RunnerHealthSampler({ procRoot: root, now: () => now }); const first = sampler.sample();
  assert.equal(first.available, true); assert.equal(first.cpuUtilizationPercent, null); assert.equal(first.memoryUtilizationPercent, 25); assert.equal(first.loadAverage1m, 0.42); assert.equal(first.logicalCpuCount, 2);
  now = 2000; write({ cpu: { user: 180, system: 70, idle: 950 }, received: 3000, transmitted: 6000 }); const second = sampler.sample();
  assert.equal(second.cpuUtilizationPercent, 50); assert.equal(second.networkReceiveBytesPerSecond, 2000); assert.equal(second.networkTransmitBytesPerSecond, 4000);
});
