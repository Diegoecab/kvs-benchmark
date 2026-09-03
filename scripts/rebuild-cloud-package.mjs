#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageRun } from "../src/dashboard/cloud-acceptance.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = process.argv[2];
if (!/^cloud-[A-Za-z0-9TZ-]+$/.test(runId || "")) throw new Error("Usage: node scripts/rebuild-cloud-package.mjs <cloud-run-id>");

const output = path.join(repositoryRoot, ".kvs", "cloud-runs", runId);
const stateFile = path.join(output, ".dashboard-state.json");
if (!fs.existsSync(stateFile)) throw new Error(`Run state not found: ${stateFile}`);

const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
if (state.sessionResults?.length !== state.spec?.matrix?.length) throw new Error(`Run ${runId} has ${state.sessionResults?.length || 0}/${state.spec?.matrix?.length || 0} finalized sessions`);
const acceptance = state.stages?.find(item => item.name === "acceptance-validation");
if (acceptance?.status !== "complete") throw new Error(`Run ${runId} has not passed acceptance validation`);
const packageStage = state.stages?.find(item => item.name === "package-generation");
if (!packageStage) throw new Error(`Run ${runId} does not have a package-generation stage`);

state.output = output;
state.outputRelative = path.relative(repositoryRoot, output).replaceAll("\\", "/");
state.archiveFile = path.join(output, `${runId}-benchmark-output.zip`);
const completedAt = new Date().toISOString();
if (packageStage.status !== "pending") {
  packageStage.attempts ||= [];
  packageStage.attempts.push({ status: packageStage.status, startedAt: packageStage.startedAt || null, completedAt: packageStage.completedAt || null, detail: packageStage.detail || null });
}
packageStage.status = "complete";
packageStage.startedAt = completedAt;
packageStage.completedAt = completedAt;
packageStage.detail = "Benchmark package rebuilt from accepted checkpoint";
state.status = "complete";
state.error = null;
state.completedAt = completedAt;
state.targetStatus = Object.fromEntries(Object.keys(state.targetStatus || {}).map(target => [target, "completed"]));
state.logs ||= [];
state.logs.push({ at: completedAt, level: "success", stage: "package-generation", message: packageStage.detail });
state.logs.push({ at: completedAt, level: "success", message: "Benchmark pipeline completed from accepted package checkpoint" });
await packageRun(state);

state.heartbeatAt = new Date().toISOString();
const temporaryState = `${stateFile}.tmp-${process.pid}`;
fs.writeFileSync(temporaryState, `${JSON.stringify(state, null, 2)}\n`);
fs.renameSync(temporaryState, stateFile);

const result = { runId, report: path.join(output, "index.html"), archive: state.archiveFile, bytes: fs.statSync(state.archiveFile).size };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
