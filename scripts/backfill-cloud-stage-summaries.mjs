import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeWorkloadStageSummary } from "../src/dashboard/workload-stages.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const values = Object.fromEntries(process.argv.slice(2).map(value => {
  const match = /^--([a-z-]+)=(.+)$/.exec(value); if (!match) throw new Error(`Invalid argument: ${value}`); return [match[1], match[2]];
}));
const runId = values["run-id"];
if (!/^cloud-[A-Za-z0-9-]+$/.test(runId || "")) throw new Error("--run-id=<cloud-run-id> is required");
const runDirectory = path.join(repositoryRoot, ".kvs", "cloud-runs", runId), stateFile = path.join(runDirectory, ".dashboard-state.json");
if (!fs.existsSync(stateFile)) throw new Error(`Run state not found: ${runId}`);
const state = JSON.parse(fs.readFileSync(stateFile, "utf8")), written = [];
for (const result of state.sessionResults || []) {
  const session = state.spec.matrix.find(item => item.id === result.id); if (!session) continue;
  for (const target of state.spec.enabled || []) {
    const directory = path.join(runDirectory, "evidence", "run", session.id, target), operations = path.join(directory, "operations.ndjson");
    if (!fs.existsSync(operations)) continue;
    const summary = await writeWorkloadStageSummary(directory, session.loadSchedule || []);
    written.push({ session: session.id, target, stages: summary.length, accounted: summary.reduce((sum, item) => sum + item.accounted, 0) });
  }
}
process.stdout.write(`${JSON.stringify({ runId, written }, null, 2)}\n`);
