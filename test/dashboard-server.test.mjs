import test from "node:test";
import assert from "node:assert/strict";
import { createDashboardServer } from "../src/dashboard/server.mjs";

test("dashboard serves bootstrap and protects preview with its launch token", async t => {
  const smoke = { id: "smoke-test", mode: "async", status: "complete", progress: { scheduled: 20, accounted: 20, completed: 20, failed: 0 }, summary: { harnessPassed: true } };
  const localSmokeRuns = { start: options => { assert.equal(options.mode, "async"); return smoke; }, get: id => { assert.equal(id, smoke.id); return smoke; } };
  const { server, token } = createDashboardServer({ profileDiscovery: async () => ({ aws: ["dynamodb_poc"], oci: ["PITWALL_API"], warnings: [], sources: {} }), localSmokeRuns });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await fetch(`${origin}/api/bootstrap`).then(response => response.json());
  assert.deepEqual(bootstrap.profiles.aws, ["dynamodb_poc"]);
  assert.equal(bootstrap.capabilities.localMockExecution, true);
  const denied = await fetch(`${origin}/api/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(denied.status, 403);
  const invalid = await fetch(`${origin}/api/preview`, { method: "POST", headers: { "content-type": "application/json", "x-kvs-csrf": token }, body: "{}" });
  assert.equal(invalid.status, 400);
  const deniedSmoke = await fetch(`${origin}/api/local-smoke`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(deniedSmoke.status, 403);
  const startedSmoke = await fetch(`${origin}/api/local-smoke`, { method: "POST", headers: { "content-type": "application/json", "x-kvs-csrf": token }, body: JSON.stringify({ mode: "async" }) });
  assert.equal(startedSmoke.status, 202);
  assert.equal((await startedSmoke.json()).id, smoke.id);
  const smokeStatus = await fetch(`${origin}/api/runs/${smoke.id}`).then(response => response.json());
  assert.equal(smokeStatus.summary.harnessPassed, true);
});
