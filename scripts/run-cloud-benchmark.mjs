import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { CloudAcceptanceRuns } from "../src/dashboard/cloud-acceptance.mjs";

const specFile = process.argv.find(value => value.startsWith("--spec="))?.slice("--spec=".length);
if (!specFile) throw new Error("Usage: node scripts/run-cloud-benchmark.mjs --spec=<json-file>");
const input = JSON.parse(fs.readFileSync(specFile, "utf8"));
const runs = new CloudAcceptanceRuns();
const started = runs.start(input);
console.log(`RUN_STARTED id=${started.id} sessions=${started.matrix.length}`);

let previous = "";
while (true) {
  const current = runs.get(started.id);
  const activeStage = current.stages.find(stage => stage.status === "running")?.name || current.stages.find(stage => stage.status === "failed")?.name || "idle";
  const session = current.currentSession ? `${current.currentSession.index}/${current.currentSession.total}:${current.currentSession.id}` : "none";
  const marker = `${current.status}|${activeStage}|${session}|${current.sessionResults.length}`;
  if (marker !== previous) {
    console.log(`RUN_STATUS status=${current.status} stage=${activeStage} session=${session} completedSessions=${current.sessionResults.length}`);
    previous = marker;
  }
  if (["complete", "failed"].includes(current.status)) {
    if (current.error) console.error(`RUN_ERROR ${current.error}`);
    else console.log(`RUN_COMPLETE id=${current.id} output=${current.output} download=${current.downloadUrl}`);
    process.exit(current.status === "complete" ? 0 : 1);
  }
  await sleep(5000);
}
