import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/core/config.mjs";
import { doctor } from "../src/core/doctor.mjs";

test("mock doctor is non-mutating and ready offline", async () => {
  const { config } = readConfig(new URL("../configs/smoke.json", import.meta.url));
  const report = await doctor({ config, target: "mock", skipNetwork: true });
  assert.equal(report.ready, true);
  assert.equal(report.limitations.includes("Does not create or modify infrastructure"), true);
});

test("doctor reports a malformed ADB endpoint without crashing", async () => {
  const { config } = readConfig(new URL("../configs/smoke.json", import.meta.url));
  const report = await doctor({ config, target: "adb", endpoint: "not a URL" });
  assert.equal(report.ready, false);
  assert.match(report.checks.find(value => value.name === "endpoint-443").detail.error, /^invalid endpoint:/);
});
