import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createZip } from "./artifact.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultOutput = path.join(repositoryRoot, ".kvs", "cloud-runs");
const defaultImage = "ghcr.io/diegoecab/kvs-benchmark-runner@sha256:90975b64725902487fbaea43da5c772534d1f28f9bbcf087d693c2d6707a8afc";
const stages = ["runner-readiness", "resource-validation", "dataset-preload", "dataset-certification", "dataset-hash-match", "t0-scheduled", "workload", "evidence-collection", "acceptance-validation", "package-generation"];
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const safe = (value, pattern, label) => { if (!pattern.test(value || "")) throw new Error(`${label} is invalid`); return value; };
const shellQuote = value => `'${String(value).replaceAll("'", `'"'"'`)}'`;

function run(file, args, { timeout = 15 * 60_000, cwd = repositoryRoot } = {}) {
  return new Promise((resolve, reject) => execFile(file, args, { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) return reject(new Error(`${file} ${args[0] || ""} failed: ${(stderr || stdout || error.message).trim()}`));
    resolve(stdout);
  }));
}

function validate(input, keyFile) {
  if (!input?.writeAuthorization) throw new Error("Dataset preload authorization is required");
  const target = input.targets || {};
  const enabled = ["aws", "adb", "ndcs"].filter(name => target[name]?.enabled);
  if (!enabled.length) throw new Error("Cloud acceptance requires at least one enabled target");
  const result = {
    enabled,
    mode: ["async", "live"].includes(input.execution?.mode) ? input.execution.mode : "async",
    image: safe(input.imageDigest || defaultImage, /^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/i, "Runner image digest"),
    keyFile,
  };
  if (enabled.includes("aws")) Object.assign(result, { awsProfile: safe(target.aws.profile, /^[A-Za-z0-9_.-]+$/, "AWS profile"), awsRegion: safe(target.aws.region, /^[a-z]{2}-[a-z]+-\d$/, "AWS region"), awsTable: safe(target.aws.resource, /^[A-Za-z0-9_.-]+$/, "AWS table"), awsRunner: safe(target.aws.runnerId, /^i-[a-f0-9]+$/, "AWS runner"), bucket: safe(input.artifactBucket, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "Artifact bucket") });
  if (enabled.includes("adb")) Object.assign(result, { adbOciProfile: safe(target.adb.profile, /^[A-Za-z0-9_.-]+$/, "ADB OCI profile"), adbOciRegion: safe(target.adb.region, /^[a-z]{2}-[a-z]+-\d$/, "ADB OCI region"), adbTable: safe(target.adb.resource, /^[A-Za-z0-9_.-]+$/, "ADB table"), adbRunner: safe(target.adb.runnerId, /^ocid1\.instance\./, "ADB runner"), adbHost: safe(target.adb.runnerHost, /^[A-Za-z0-9.-]+$/, "ADB runner host"), adbDatabaseId: target.adb.databaseId ? safe(target.adb.databaseId, /^ocid1\.autonomousdatabase\./, "Autonomous Database") : null });
  if (enabled.includes("ndcs")) {
    Object.assign(result, { ndcsOciProfile: safe(target.ndcs.profile, /^[A-Za-z0-9_.-]+$/, "OCI NoSQL profile"), ndcsOciRegion: safe(target.ndcs.region, /^[a-z]{2}-[a-z]+-\d$/, "OCI NoSQL region"), ndcsTable: safe(target.ndcs.resource, /^[A-Za-z0-9_.-]+$/, "OCI NoSQL table"), ndcsRunner: safe(target.ndcs.runnerId, /^ocid1\.instance\./, "OCI NoSQL runner"), ndcsHost: safe(target.ndcs.runnerHost, /^[A-Za-z0-9.-]+$/, "OCI NoSQL runner host"), ndcsCompartment: safe(target.ndcs.compartmentId, /^ocid1\.compartment\./, "OCI NoSQL compartment") });
  }
  if (enabled.some(name => name !== "aws") && (!keyFile || !fs.existsSync(keyFile))) throw new Error("KVS_OCI_SSH_KEY is not configured or does not exist");
  return result;
}

const stageView = name => ({ name, status: "pending", startedAt: null, completedAt: null, detail: null });
function visible(state) {
  return { schemaVersion: 1, id: state.id, kind: "cloud-acceptance", mode: state.spec.mode, status: state.status, createdAt: state.createdAt, startedAt: state.startedAt || null, completedAt: state.completedAt || null, stages: state.stages, targetStatus: state.targetStatus, sharedStartAt: state.sharedStartAt || null, certificates: state.certificates || null, summaries: state.summaries || null, error: state.error || null, output: state.outputRelative, downloadUrl: state.archiveFile ? `/api/runs/${encodeURIComponent(state.id)}/download` : null };
}

function remoteScript(spec, target, action, output, startAt) {
  const table = target === "adb" ? spec.adbTable : spec.ndcsTable;
  const env = target === "adb"
    ? `runtime=/opt/meli-kvs-benchmark/run-20260826-02/adb-api.runtime.json\nexport AWS_ACCESS_KEY_ID="$(jq -r .accessKeyId \"$runtime\")"\nexport AWS_SECRET_ACCESS_KEY="$(jq -r .secretAccessKey \"$runtime\")"\nexport DDB_ENDPOINT="$(jq -r .endpoint \"$runtime\")"\nenvargs=(-e AWS_REGION=us-ashburn-1 -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e DDB_ENDPOINT)`
    : `envargs=(-e OCI_USE_INSTANCE_PRINCIPAL=true -e OCI_REGION=${spec.ndcsOciRegion} -e OCI_COMPARTMENT_ID=${spec.ndcsCompartment})`;
  const command = action === "run" ? `run --start-at=${startAt}` : action === "doctor" ? "doctor --clock-evidence=results/clock.txt" : `${action} --rate=20 --max-inflight=16`;
  const outputArgument = action === "doctor" ? "results/doctor.json" : "results";
  const invocation = `podman run --rm --network host "${'${envargs[@]}'}" -v "$root:/app/results:Z" "$image" ${command} --config=configs/smoke.json --target=${target} --table=${shellQuote(table)} --output=${outputArgument}`;
  const guardedInvocation = action === "doctor" ? `set +e\n${invocation}\ncode=$?\nset -e\nif [ "$code" -ne 0 ] && [ "$code" -ne 2 ]; then exit "$code"; fi` : invocation;
  return `#!/usr/bin/env bash\nset -euo pipefail\n${env}\nroot=${shellQuote(output)}\nimage=${shellQuote(spec.image)}\nmkdir -p "$root" && chmod 0777 "$root"\npodman image exists "$image"\nchronyc tracking > "$root/clock.txt"\n${guardedInvocation}\n`;
}

function awsCommands(spec, action, output, startAt) {
  const command = action === "run" ? `run --start-at=${startAt}` : `${action} --rate=20 --max-inflight=16`;
  const prefix = `results/${spec.runId}/${action}/aws`;
  return ["set -eu", `root=${output}`, `image=${spec.image}`, "mkdir -p $root && chmod 0777 $root", "podman image exists $image", "chronyc tracking > $root/clock.txt", `podman run --rm --network host -e AWS_REGION=${spec.awsRegion} -v $root:/app/results:Z $image ${command} --config=configs/smoke.json --target=aws --table=${spec.awsTable} --output=results`, `/usr/local/bin/aws s3 cp $root s3://${spec.bucket}/${prefix} --recursive --only-show-errors`];
}

export class CliCloudAdapter {
  constructor({ execute = run } = {}) { this.execute = execute; }
  async aws(spec, action, output, startAt) {
    const control = path.join(spec.localOutput, "control"); fs.mkdirSync(control, { recursive: true });
    const file = path.join(control, `aws-${action}.json`); fs.writeFileSync(file, `${JSON.stringify({ commands: awsCommands(spec, action, output, startAt) })}\n`);
    const commandId = (await this.execute("aws", ["ssm", "send-command", "--profile", spec.awsProfile, "--region", spec.awsRegion, "--instance-ids", spec.awsRunner, "--document-name", "AWS-RunShellScript", "--comment", `${spec.runId}-${action}`, "--parameters", `file://${file.replaceAll("\\", "/")}`, "--query", "Command.CommandId", "--output", "text"])).trim();
    for (let attempt = 0; attempt < 450; attempt += 1) {
      const raw = await this.execute("aws", ["ssm", "get-command-invocation", "--profile", spec.awsProfile, "--region", spec.awsRegion, "--command-id", commandId, "--instance-id", spec.awsRunner, "--output", "json"]);
      const result = JSON.parse(raw); if (["Success", "Failed", "Cancelled", "TimedOut"].includes(result.Status)) { if (result.Status !== "Success") throw new Error(`AWS ${action}: ${result.StandardErrorContent || result.Status}`); return { commandId, stdout: result.StandardOutputContent }; }
      await sleep(2000);
    }
    throw new Error(`AWS ${action} timed out`);
  }
  async oci(spec, target, action, output, startAt) {
    const control = path.join(spec.localOutput, "control"); fs.mkdirSync(control, { recursive: true });
    const file = path.join(control, `${target}-${action}.sh`), remote = `/tmp/${spec.runId}-${target}-${action}.sh`, host = target === "adb" ? spec.adbHost : spec.ndcsHost;
    fs.writeFileSync(file, remoteScript(spec, target, action, output, startAt));
    const common = ["-i", spec.keyFile, "-o", "StrictHostKeyChecking=no"];
    await this.execute("scp", [...common, file, `opc@${host}:${remote}`]);
    const stdout = await this.execute("ssh", [...common, `opc@${host}`, `sudo bash ${remote}`]);
    return { stdout };
  }
  async preflight(spec) {
    const tasks = {};
    if (spec.enabled.includes("aws")) tasks.aws = this.execute("aws", ["ssm", "describe-instance-information", "--profile", spec.awsProfile, "--region", spec.awsRegion, "--filters", `Key=InstanceIds,Values=${spec.awsRunner}`, "--output", "json"]).then(raw => JSON.parse(raw).InstanceInformationList?.[0]?.PingStatus);
    for (const target of ["adb", "ndcs"].filter(name => spec.enabled.includes(name))) { const host = target === "adb" ? spec.adbHost : spec.ndcsHost; tasks[target] = this.execute("ssh", ["-i", spec.keyFile, "-o", "StrictHostKeyChecking=no", `opc@${host}`, `date -u; sudo podman image exists ${shellQuote(spec.image)}`]).then(raw => raw.trim()); }
    const entries = await Promise.all(Object.entries(tasks).map(async ([key, task]) => [key, await task])); return Object.fromEntries(entries);
  }
  async validateResources(spec) {
    const result = {};
    if (spec.enabled.includes("aws")) result.aws = JSON.parse(await this.execute("aws", ["dynamodb", "describe-table", "--profile", spec.awsProfile, "--region", spec.awsRegion, "--table-name", spec.awsTable, "--output", "json"])).Table;
    if (spec.enabled.includes("ndcs")) result.ndcs = JSON.parse(await this.execute("oci", ["nosql", "table", "get", "--profile", spec.ndcsOciProfile, "--region", spec.ndcsOciRegion, "--table-name-or-id", spec.ndcsTable, "--compartment-id", spec.ndcsCompartment, "--output", "json"])).data;
    if (spec.enabled.includes("adb")) { const adbDoctor = JSON.parse((await this.oci(spec, "adb", "doctor", `/opt/kvs-dashboard/${spec.runId}/validation/adb`, null)).stdout); const blocking = adbDoctor.checks.filter(check => check.required && !check.passed && !(check.name === "provisioned-capacity" && check.detail?.expected && Object.keys(check.detail.expected).length === 0)); if (blocking.length) throw new Error(`ADB doctor did not pass: ${blocking.map(check => check.name).join(", ")}`); const endpoint = adbDoctor.checks.find(check => check.name === "adb-endpoint")?.detail; if (spec.adbDatabaseId && !String(endpoint).includes(spec.adbDatabaseId)) throw new Error("Selected Autonomous Database does not match the ADB runner endpoint"); result.adb = adbDoctor.table; }
    return result;
  }
  async stage(spec, action, startAt = null) {
    const base = `/opt/kvs-dashboard/${spec.runId}/${action}`;
    return Promise.all(spec.enabled.map(target => target === "aws" ? this.aws(spec, action, `${base}/aws`, startAt) : this.oci(spec, target, action, `${base}/${target}`, startAt)));
  }
  async collect(spec, action) {
    const local = path.join(spec.localOutput, "evidence", action); fs.mkdirSync(local, { recursive: true });
    if (spec.enabled.includes("aws")) await this.execute("aws", ["s3", "cp", `s3://${spec.bucket}/results/${spec.runId}/${action}/aws`, path.join(local, "aws"), "--recursive", "--only-show-errors", "--profile", spec.awsProfile, "--region", spec.awsRegion]);
    await Promise.all([["adb", spec.adbHost], ["ndcs", spec.ndcsHost]].filter(([target]) => spec.enabled.includes(target)).map(async ([target, host]) => {
      const destination = path.join(local, target); fs.mkdirSync(destination, { recursive: true });
      await this.execute("scp", ["-r", "-i", spec.keyFile, "-o", "StrictHostKeyChecking=no", `opc@${host}:/opt/kvs-dashboard/${spec.runId}/${action}/${target}/.`, `${destination}/`]);
    }));
    return local;
  }
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function allFiles(directory) { return fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter(item => item.isFile()).map(item => path.join(item.parentPath || item.path, item.name)); }
function packageRun(state) {
  const summaries = state.summaries; const rows = Object.entries(summaries).map(([target, value]) => `<tr><td>${target.toUpperCase()}</td><td>${value.actualStartAt}</td><td>${value.startSkewMs}</td><td>${value.completed}/${value.scheduled}</td><td>${value.successfulServiceLatencyMs?.p95 ?? "-"}</td><td>${value.successfulServiceLatencyMs?.p99 ?? "-"}</td><td>${value.successfulServiceLatencyMs?.max ?? "-"}</td></tr>`).join("");
  const certificate = Object.values(state.certificates)[0];
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>KVS cloud acceptance</title><style>body{max-width:1100px;margin:40px auto;font:15px system-ui;color:#172033}table{width:100%;border-collapse:collapse}th,td{padding:9px;border-bottom:1px solid #ddd;text-align:left}.ok{color:#087a55}</style><h1>KVS cloud acceptance</h1><p class="ok"><b>COMPLETE</b> — synchronized client-side smoke test from ${state.spec.enabled.map(value => value.toUpperCase()).join(", ")}.</p><p>Dataset SHA-256: <code>${certificate.observedSha256}</code>. Shared T0: <code>${state.sharedStartAt}</code>.</p><table><thead><tr><th>Target</th><th>Actual start UTC</th><th>Start skew ms</th><th>Completed</th><th>P95 ms</th><th>P99 ms</th><th>Max ms</th></tr></thead><tbody>${rows}</tbody></table><h2>Evidence</h2><p>The ZIP contains preload records, strong-read dataset certificates, operation-level NDJSON, telemetry, summaries, clock evidence, stage events, and SHA-256 manifest.</p></html>`;
  fs.writeFileSync(path.join(state.output, "index.html"), html);
  fs.writeFileSync(path.join(state.output, "run-state.json"), `${JSON.stringify(visible(state), null, 2)}\n`);
  const files = allFiles(state.output).filter(file => !file.endsWith(".zip") && !file.endsWith("manifest-sha256.json"));
  const entries = files.map(file => ({ path: path.relative(state.output, file).replaceAll("\\", "/"), data: fs.readFileSync(file) }));
  const manifest = { schemaVersion: 1, runId: state.id, generatedAt: new Date().toISOString(), entries: entries.map(item => ({ path: item.path, bytes: item.data.length, sha256: crypto.createHash("sha256").update(item.data).digest("hex") })) };
  const manifestData = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`); fs.writeFileSync(path.join(state.output, "manifest-sha256.json"), manifestData);
  state.archiveFile = path.join(state.output, `${state.id}-benchmark-output.zip`); fs.writeFileSync(state.archiveFile, createZip([...entries.map(item => ({ name: item.path, data: item.data })), { name: "manifest-sha256.json", data: manifestData }]));
}

export class CloudAcceptanceRuns {
  constructor({ outputRoot = defaultOutput, adapter = new CliCloudAdapter(), keyFile = process.env.KVS_OCI_SSH_KEY } = {}) { this.outputRoot = outputRoot; this.adapter = adapter; this.keyFile = keyFile; this.runs = new Map(); }
  start(input) {
    if ([...this.runs.values()].some(run => ["queued", "running"].includes(run.status))) throw new Error("A cloud acceptance run is already active");
    const spec = validate(input, this.keyFile), id = `cloud-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`, output = path.join(this.outputRoot, id);
    Object.assign(spec, { runId: id, localOutput: output });
    const state = { id, spec, status: "queued", createdAt: new Date().toISOString(), output, outputRelative: path.relative(repositoryRoot, output).replaceAll("\\", "/"), stages: stages.map(stageView), targetStatus: Object.fromEntries(spec.enabled.map(name => [name, "pending"])) };
    this.runs.set(id, state); void this.execute(state); return visible(state);
  }
  get(id) { const state = this.runs.get(id); if (!state) throw new Error("Cloud run not found"); return visible(state); }
  download(id) { const state = this.runs.get(id); if (!state?.archiveFile) throw new Error("Cloud benchmark output is not ready"); return state.archiveFile; }
  async step(state, name, task) {
    const stage = state.stages.find(item => item.name === name); stage.status = "running"; stage.startedAt = new Date().toISOString();
    try { const result = await task(); stage.status = "complete"; stage.completedAt = new Date().toISOString(); stage.detail = typeof result === "string" ? result : result ? JSON.stringify(result).slice(0, 600) : "Passed"; return result; }
    catch (error) { stage.status = "failed"; stage.completedAt = new Date().toISOString(); stage.detail = error.message; throw error; }
  }
  async execute(state) {
    const spec = state.spec; fs.mkdirSync(state.output, { recursive: true }); state.status = "running"; state.startedAt = new Date().toISOString();
    try {
      await this.step(state, "runner-readiness", () => this.adapter.preflight(spec));
      await this.step(state, "resource-validation", () => this.adapter.validateResources(spec));
      await this.step(state, "dataset-preload", async () => { state.targetStatus = Object.fromEntries(spec.enabled.map(name => [name, "preloading"])); const value = await this.adapter.stage(spec, "preload"); state.targetStatus = Object.fromEntries(spec.enabled.map(name => [name, "preloaded"])); return value.map(item => item.stdout?.slice(-120)); });
      await this.step(state, "dataset-certification", async () => { state.targetStatus = Object.fromEntries(spec.enabled.map(name => [name, "certifying"])); await this.adapter.stage(spec, "certify"); await this.adapter.collect(spec, "certify"); state.certificates = Object.fromEntries(spec.enabled.map(target => [target, readJson(path.join(state.output, "evidence", "certify", target, "dataset-certificate.json"))])); state.targetStatus = Object.fromEntries(spec.enabled.map(name => [name, "certified"])); return Object.fromEntries(Object.entries(state.certificates).map(([key, value]) => [key, value.observedSha256])); });
      await this.step(state, "dataset-hash-match", () => { const hashes = Object.values(state.certificates).map(value => value.observedSha256); if (new Set(hashes).size !== 1 || Object.values(state.certificates).some(value => !value.passed)) throw new Error("Dataset certificates do not match"); return hashes[0]; });
      await this.step(state, "t0-scheduled", () => { state.sharedStartAt = new Date(Math.ceil((Date.now() + 120_000) / 10_000) * 10_000).toISOString(); return state.sharedStartAt; });
      await this.step(state, "workload", async () => { state.targetStatus = Object.fromEntries(spec.enabled.map(name => [name, "running"])); await this.adapter.stage(spec, "run", state.sharedStartAt); state.targetStatus = Object.fromEntries(spec.enabled.map(name => [name, "completed"])); });
      await this.step(state, "evidence-collection", () => this.adapter.collect(spec, "run"));
      await this.step(state, "acceptance-validation", () => { state.summaries = Object.fromEntries(spec.enabled.map(target => [target, readJson(path.join(state.output, "evidence", "run", target, "summary.json"))])); const values = Object.values(state.summaries); if (values.some(value => !value.harnessPassed || value.accounted !== value.scheduled || value.failed !== 0)) throw new Error("One or more target summaries failed acceptance"); if (new Set(values.map(value => value.configSha256)).size !== 1 || new Set(values.map(value => value.scheduledStartAt)).size !== 1) throw new Error("Configuration hash or T0 differs across targets"); return { maximumStartSkewMs: Math.max(...values.map(value => Math.abs(value.startSkewMs))) }; });
      await this.step(state, "package-generation", () => packageRun(state));
      state.status = "complete"; state.completedAt = new Date().toISOString();
    } catch (error) { state.status = "failed"; state.error = error.message; state.completedAt = new Date().toISOString(); }
  }
}

export { defaultImage };
