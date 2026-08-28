import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const TARGETS = ["aws", "adb", "ndcs"];

export function readCoordinationPlan(file) {
  const plan = JSON.parse(fs.readFileSync(file, "utf8"));
  if (plan.schemaVersion !== 1 || !plan.name || !Array.isArray(plan.runners)) throw new Error("coordination plan requires schemaVersion 1, name, and runners");
  if (plan.runners.length !== 3 || new Set(plan.runners.map(value => value.target)).size !== 3 || !TARGETS.every(target => plan.runners.some(value => value.target === target))) throw new Error("coordination plan requires exactly aws, adb, and ndcs runners");
  for (const runner of plan.runners) {
    if (!runner.command || !Array.isArray(runner.args) || !runner.args.some(value => value.includes("{{START_AT}}"))) throw new Error(`${runner.target} requires command args containing {{START_AT}}`);
    if (runner.collect && (!runner.collect.command || !Array.isArray(runner.collect.args))) throw new Error(`${runner.target} collect requires command and args`);
  }
  return plan;
}

const rendered = (values, startAt) => values.map(value => value.replaceAll("{{START_AT}}", startAt));
const fingerprint = (command, args) => crypto.createHash("sha256").update(JSON.stringify([command, ...args])).digest("hex");

function execute({ command, args, stdout, stderr }) {
  return new Promise(resolve => {
    const stdoutFinished = once(stdout, "finish"), stderrFinished = once(stderr, "finish");
    const child = spawn(command, args, { shell: false, windowsHide: true });
    child.stdout.pipe(stdout); child.stderr.pipe(stderr);
    child.once("error", async error => { stdout.end(); stderr.end(); await Promise.allSettled([stdoutFinished, stderrFinished]); resolve({ exitCode: null, error: { name: error.name, message: error.message } }); });
    child.once("close", async (exitCode, signal) => { await Promise.allSettled([stdoutFinished, stderrFinished]); resolve({ exitCode, signal: signal || null }); });
  });
}

export async function coordinate({ plan, output, startAt, dryRun = false, now = Date.now }) {
  const leadSeconds = Number(plan.leadTimeSeconds ?? 120); const startEpoch = startAt ? Date.parse(startAt) : now() + leadSeconds * 1000;
  if (!Number.isFinite(startEpoch) || startEpoch - now() < leadSeconds * 1000) throw new Error(`startAt must provide at least ${leadSeconds} seconds of lead time`);
  const sharedStartAt = new Date(startEpoch).toISOString(); fs.mkdirSync(output, { recursive: true });
  const report = { schemaVersion: 1, planName: plan.name, sharedStartAt, leadSeconds, dryRun, generatedAt: new Date(now()).toISOString(), runners: plan.runners.map(runner => { const args = rendered(runner.args, sharedStartAt); return { target: runner.target, command: runner.command, commandSha256: fingerprint(runner.command, args), hasCollector: Boolean(runner.collect) }; }) };
  const reportFile = path.join(output, "coordination.json"); const persist = () => fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`); persist();
  if (dryRun) return report;
  const executions = plan.runners.map(async runner => {
    const record = report.runners.find(value => value.target === runner.target); record.launchedAt = new Date(now()).toISOString(); persist();
    const stdout = fs.createWriteStream(path.join(output, `${runner.target}.stdout.log`)); const stderr = fs.createWriteStream(path.join(output, `${runner.target}.stderr.log`));
    const result = await execute({ command: runner.command, args: rendered(runner.args, sharedStartAt), stdout, stderr });
    Object.assign(record, result, { finishedAt: new Date(now()).toISOString() });
    if (result.exitCode === 0 && runner.collect) {
      const collectOut = fs.createWriteStream(path.join(output, `${runner.target}.collect.stdout.log`)); const collectErr = fs.createWriteStream(path.join(output, `${runner.target}.collect.stderr.log`));
      record.collection = await execute({ command: runner.collect.command, args: rendered(runner.collect.args, sharedStartAt), stdout: collectOut, stderr: collectErr });
    }
    persist(); return record;
  });
  await Promise.all(executions); report.passed = report.runners.every(value => value.exitCode === 0 && (!value.hasCollector || value.collection?.exitCode === 0)); report.generatedAt = new Date(now()).toISOString(); persist(); return report;
}
