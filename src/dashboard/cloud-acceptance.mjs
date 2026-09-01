import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createZip } from "./artifact.mjs";
import { previewMatrix } from "./preview.mjs";
import { executeOciRunCommand } from "./oci-run-command.mjs";
import { readRunStates, stateFileName, writeStateAtomic } from "./file-state.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const configDirectory = path.join(repositoryRoot, "configs");
const defaultOutput = path.join(repositoryRoot, ".kvs", "cloud-runs");
const defaultImage = "ghcr.io/diegoecab/kvs-benchmark-runner@sha256:55ce8eeccce8e8e698ec7b672e491d0e99c28813a2d8ad93ef44ae85330131e0";
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

function validate(input) {
  if (!input?.writeAuthorization) throw new Error("Dataset preload authorization is required");
  if (input.infrastructure?.mode !== "existing") throw new Error("Infrastructure deployment adapter is not enabled; select Use existing infrastructure");
  const target = input.targets || {};
  const enabled = ["aws", "adb", "ndcs"].filter(name => target[name]?.enabled);
  if (!enabled.length) throw new Error("Cloud acceptance requires at least one enabled target");
  const result = {
    enabled,
    mode: ["async", "live"].includes(input.execution?.mode) ? input.execution.mode : "async",
    image: safe(input.imageDigest || defaultImage, /^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/i, "Runner image digest"),
  };
  const requestedLead = input.execution?.t0LeadSeconds;
  if (requestedLead != null && (!Number.isInteger(Number(requestedLead)) || Number(requestedLead) < 30 || Number(requestedLead) > 3600)) throw new Error("T0 lead time must be an integer between 30 and 3600 seconds");
  result.t0LeadSeconds = requestedLead == null ? (enabled.some(name => name === "adb" || name === "ndcs") ? 480 : 120) : Number(requestedLead);
  if (enabled.includes("aws")) Object.assign(result, { awsProfile: safe(target.aws.profile, /^[A-Za-z0-9_.-]+$/, "AWS profile"), awsRegion: safe(target.aws.region, /^[a-z]{2}-[a-z]+-\d$/, "AWS region"), awsTable: safe(target.aws.resource, /^[A-Za-z0-9_.-]+$/, "AWS table"), awsRunner: safe(target.aws.runnerId, /^i-[a-f0-9]+$/, "AWS runner"), bucket: safe(input.artifactBucket, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "Artifact bucket") });
  if (enabled.includes("adb")) Object.assign(result, { adbOciProfile: safe(target.adb.profile, /^[A-Za-z0-9_.-]+$/, "ADB OCI profile"), adbOciRegion: safe(target.adb.region, /^[a-z]{2}-[a-z]+-\d$/, "ADB OCI region"), adbTable: safe(target.adb.resource, /^[A-Za-z0-9_.-]+$/, "ADB table"), adbRunner: safe(target.adb.runnerId, /^ocid1\.instance\./, "ADB runner"), adbRunnerCompartment: safe(target.adb.runnerCompartmentId, /^ocid1\.(compartment|tenancy)\./, "ADB runner compartment"), adbBucket: safe(target.adb.evidenceBucket, /^[A-Za-z0-9_.-]+$/, "ADB evidence bucket"), adbDatabaseId: target.adb.databaseId ? safe(target.adb.databaseId, /^ocid1\.autonomousdatabase\./, "Autonomous Database") : null });
  if (enabled.includes("ndcs")) {
    Object.assign(result, { ndcsOciProfile: safe(target.ndcs.profile, /^[A-Za-z0-9_.-]+$/, "OCI NoSQL profile"), ndcsOciRegion: safe(target.ndcs.region, /^[a-z]{2}-[a-z]+-\d$/, "OCI NoSQL region"), ndcsTable: safe(target.ndcs.resource, /^[A-Za-z0-9_.-]+$/, "OCI NoSQL table"), ndcsRunner: safe(target.ndcs.runnerId, /^ocid1\.instance\./, "OCI NoSQL runner"), ndcsRunnerCompartment: safe(target.ndcs.runnerCompartmentId, /^ocid1\.(compartment|tenancy)\./, "OCI NoSQL runner compartment"), ndcsBucket: safe(target.ndcs.evidenceBucket, /^[A-Za-z0-9_.-]+$/, "OCI NoSQL evidence bucket"), ndcsCompartment: safe(target.ndcs.compartmentId, /^ocid1\.compartment\./, "OCI NoSQL compartment") });
  }
  const preview = previewMatrix(input, { configDirectory });
  result.matrix = preview.rows;
  result.overrides = input.overrides || {};
  result.presetOverrides = input.presetOverrides || {};
  return result;
}

const stageView = name => ({ name, status: "pending", startedAt: null, completedAt: null, detail: null });
function appendLog(state, { level = "info", stage = "pipeline", target = "control", message }) {
  state.logs ||= [];
  state.logs.push({ at: new Date().toISOString(), level, stage, target, message: String(message) });
  if (state.logs.length > 1000) state.logs.splice(0, state.logs.length - 1000);
}
function visible(state) {
  return { schemaVersion: 1, id: state.id, kind: "cloud-benchmark", mode: state.spec.mode, status: state.status, createdAt: state.createdAt, startedAt: state.startedAt || null, completedAt: state.completedAt || null, stages: state.stages, targetStatus: state.targetStatus, sharedStartAt: state.sharedStartAt || null, currentSession: state.currentSession || null, matrix: state.spec.matrix, certificates: state.certificates || null, summaries: state.summaries || null, sessionResults: state.sessionResults || [], targetMetrics: state.targetMetrics || {}, logs: state.logs || [], error: state.error || null, output: state.outputRelative, downloadUrl: state.archiveFile ? `/api/runs/${encodeURIComponent(state.id)}/download` : null };
}

function runtimeArguments(spec, session) {
  const ignored = new Set(session?.ignoredOverrides || []), values = session?.effectiveOverrides || spec.overrides || {};
  const names = { durationSeconds: "duration-seconds", fixedConcurrency: "fixed-concurrency", readPercent: "read-percent", writePercent: "write-percent", writeMode: "write-mode", rateMultiplier: "rate-multiplier", executionMode: "execution-mode", consistency: "consistency" };
  return Object.entries(names).filter(([name]) => values[name] != null && !ignored.has(name)).map(([name, option]) => `--${option}=${shellQuote(values[name])}`).join(" ");
}

function liveMonitor(root, scheduled, upload = "") {
  return `started=$(date +%s)\nwrite_progress(){\n  operations="$root/operations.ndjson"\n  telemetry="$root/telemetry.ndjson"\n  completed=0; failed=0; latest=null; inflight=0; p95=null\n  if [ -s "$operations" ]; then\n    completed=$(grep -c '\"error\":null' "$operations" || true)\n    total=$(wc -l < "$operations")\n    failed=$((total-completed))\n    latest=$(tail -n 1 "$operations" | jq -r '.serviceLatencyMs // 0')\n    p95=$(tail -n 1000 "$operations" | jq -s '[.[]|select(.error==null)|.serviceLatencyMs]|sort|if length==0 then null else .[((length-1)*0.95|floor)] end')\n  fi\n  if [ -s "$telemetry" ]; then inflight=$(tail -n 1 "$telemetry" | jq -r '.inFlight // 0'); fi\n  now=$(date +%s); elapsed=$((now-started)); if [ "$elapsed" -lt 1 ]; then elapsed=1; fi\n  jq -n --arg at "$(date -u +%FT%TZ)" --argjson scheduled ${Number(scheduled || 0)} --argjson completed "$completed" --argjson failed "$failed" --argjson inflight "$inflight" --argjson latest "$latest" --argjson p95 "$p95" --argjson elapsed "$elapsed" '{at:$at,scheduled:$scheduled,completed:$completed,failed:$failed,inFlight:$inflight,latestLatencyMs:$latest,rollingP95Ms:$p95,achievedOperationsPerSecond:(($completed+$failed)/$elapsed)}' > "$root/progress.json.tmp"\n  mv "$root/progress.json.tmp" "$root/progress.json"\n  ${upload}\n}\n`;
}

function remoteScript(spec, target, action, output, startAt, session = spec.matrix[0]) {
  const table = target === "adb" ? spec.adbTable : spec.ndcsTable;
  const bucket = target === "adb" ? spec.adbBucket : spec.ndcsBucket;
  const region = target === "adb" ? spec.adbOciRegion : spec.ndcsOciRegion;
  const env = target === "adb"
    ? `runtime=/opt/meli-kvs-benchmark/run-20260826-02/adb-api.runtime.json\nexport AWS_ACCESS_KEY_ID="$(sudo jq -r .accessKeyId \"$runtime\")"\nexport AWS_SECRET_ACCESS_KEY="$(sudo jq -r .secretAccessKey \"$runtime\")"\nexport DDB_ENDPOINT="$(sudo jq -r .endpoint \"$runtime\")"\nenvargs=(-e AWS_REGION=us-ashburn-1 -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e DDB_ENDPOINT)`
    : `envargs=(-e OCI_USE_INSTANCE_PRINCIPAL=true -e OCI_REGION=${spec.ndcsOciRegion} -e OCI_COMPARTMENT_ID=${spec.ndcsCompartment})`;
  if (action === "preflight") return `#!/usr/bin/env bash\nset -euo pipefail\ndate -u\nif ! sudo -n podman --version >/dev/null 2>&1; then echo "Runner prerequisite failed: the ocarun user requires passwordless access to Podman for the benchmark commands. Apply the documented sudoers policy or replace this runner." >&2; exit 20; fi\nsudo -n podman image exists ${shellQuote(spec.image)}\n`;
  const isRun = action.startsWith("run/"), command = isRun ? `run --start-at=${startAt}` : action === "doctor" ? "doctor --clock-evidence=results/clock.txt" : `${action} --rate=20 --max-inflight=16`;
  const outputArgument = action === "doctor" ? "results/doctor.json" : "results";
  const invocation = `sudo podman run --rm --network host "${'${envargs[@]}'}" -v "$root:/app/results:Z" "$image" ${command} --config=configs/${session.configFile} ${runtimeArguments(spec, session)} --target=${target} --table=${shellQuote(table)} --output=${outputArgument}`;
  const liveInvocation = `${liveMonitor("$root", session.scheduledOperationsPerTarget)}${invocation} &\nbenchmark_pid=$!\nwhile kill -0 "$benchmark_pid" 2>/dev/null; do write_progress; sleep 1; done\nset +e\nwait "$benchmark_pid"\ncode=$?\nset -e\nwrite_progress\nexit "$code"`;
  const guardedInvocation = action === "doctor" ? `set +e\n${invocation}\ncode=$?\nset -e\nif [ "$code" -ne 0 ] && [ "$code" -ne 2 ]; then exit "$code"; fi` : isRun ? liveInvocation : invocation;
  const prefix = `results/${spec.runId}/${action}/${target}`;
  const sync = `sudo podman run --rm --network host -e OCI_REGION=${shellQuote(region)} -v "$root:/app/results:Z" --entrypoint node "$image" src/cloud/oci-evidence.mjs --directory=/app/results --bucket=${shellQuote(bucket)} --prefix=${shellQuote(prefix)}`;
  if (isRun) return `#!/usr/bin/env bash\nset -euo pipefail\n${env}\nroot=${shellQuote(output)}\nimage=${shellQuote(spec.image)}\nsudo mkdir -p "$root" && sudo chmod 0777 "$root"\nsudo podman image exists "$image"\nsudo chronyc tracking > "$root/clock.txt"\n${sync} --marker=/app/results/.benchmark-complete --interval-ms=2000 &\nuploader_pid=$!\nset +e\n${guardedInvocation}\ncode=$?\nset -e\ntouch "$root/.benchmark-complete"\nwait "$uploader_pid"\nexit "$code"\n`;
  return `#!/usr/bin/env bash\nset -euo pipefail\n${env}\nroot=${shellQuote(output)}\nimage=${shellQuote(spec.image)}\nsudo mkdir -p "$root" && sudo chmod 0777 "$root"\nsudo podman image exists "$image"\nsudo chronyc tracking > "$root/clock.txt"\n${guardedInvocation}\n${sync}\n`;
}

function awsCommands(spec, action, output, startAt, session = spec.matrix[0]) {
  const isRun = action.startsWith("run/"), command = isRun ? `run --start-at=${startAt}` : `${action} --rate=20 --max-inflight=16`;
  const prefix = `results/${spec.runId}/${action}/aws`;
  const invocation = `podman run --rm --network host -e AWS_REGION=${spec.awsRegion} -v $root:/app/results:Z $image ${command} --config=configs/${session.configFile} ${runtimeArguments(spec, session)} --target=aws --table=${spec.awsTable} --output=results`;
  const runCommand = isRun ? `${liveMonitor("$root", session.scheduledOperationsPerTarget, `/usr/local/bin/aws s3 cp "$root/progress.json" s3://${spec.bucket}/${prefix}/progress.json --only-show-errors || true`)}${invocation} & benchmark_pid=$!; while kill -0 "$benchmark_pid" 2>/dev/null; do write_progress; sleep 1; done; set +e; wait "$benchmark_pid"; code=$?; set -e; write_progress; if [ "$code" -ne 0 ]; then exit "$code"; fi` : invocation;
  return ["set -eu", `root=${output}`, `image=${spec.image}`, "mkdir -p $root && chmod 0777 $root", "podman image exists $image", "chronyc tracking > $root/clock.txt", runCommand, `/usr/local/bin/aws s3 cp $root s3://${spec.bucket}/${prefix} --recursive --only-show-errors`];
}

export class CliCloudAdapter {
  constructor({ execute = run } = {}) { this.execute = execute; }
  async aws(spec, action, output, startAt, session) {
    const control = path.join(spec.localOutput, "control"); fs.mkdirSync(control, { recursive: true });
    const file = path.join(control, `aws-${action.replaceAll("/", "-")}.json`); fs.writeFileSync(file, `${JSON.stringify({ commands: awsCommands(spec, action, output, startAt, session) })}\n`);
    const commandId = (await this.execute("aws", ["ssm", "send-command", "--profile", spec.awsProfile, "--region", spec.awsRegion, "--instance-ids", spec.awsRunner, "--document-name", "AWS-RunShellScript", "--comment", `${spec.runId}-${action}`, "--parameters", `file://${file.replaceAll("\\", "/")}`, "--query", "Command.CommandId", "--output", "text"])).trim();
    for (let attempt = 0; attempt < 450; attempt += 1) {
      const raw = await this.execute("aws", ["ssm", "get-command-invocation", "--profile", spec.awsProfile, "--region", spec.awsRegion, "--command-id", commandId, "--instance-id", spec.awsRunner, "--output", "json"]);
      const result = JSON.parse(raw); if (["Success", "Failed", "Cancelled", "TimedOut"].includes(result.Status)) { if (result.Status !== "Success") throw new Error(`AWS ${action}: ${result.StandardErrorContent || result.Status}`); return { commandId, stdout: result.StandardOutputContent }; }
      await sleep(2000);
    }
    throw new Error(`AWS ${action} timed out`);
  }
  async oci(spec, target, action, output, startAt, session) {
    const control = path.join(spec.localOutput, "control"); fs.mkdirSync(control, { recursive: true });
    const safeAction = action.replaceAll("/", "-"), script = remoteScript(spec, target, action, output, startAt, session);
    const instanceId = target === "adb" ? spec.adbRunner : spec.ndcsRunner, compartmentId = target === "adb" ? spec.adbRunnerCompartment : spec.ndcsRunnerCompartment, profile = target === "adb" ? spec.adbOciProfile : spec.ndcsOciProfile, region = target === "adb" ? spec.adbOciRegion : spec.ndcsOciRegion;
    return executeOciRunCommand({ executeCommand: this.execute, profile, region, compartmentId, instanceId, script, displayName: `${spec.runId}-${target}-${safeAction}`, controlDirectory: control, timeoutSeconds: action === "preflight" ? 60 : 3600, deliveryTimeoutSeconds: 360 });
  }
  async preflight(spec) {
    const tasks = {};
    if (spec.enabled.includes("aws")) tasks.aws = this.execute("aws", ["ssm", "describe-instance-information", "--profile", spec.awsProfile, "--region", spec.awsRegion, "--filters", `Key=InstanceIds,Values=${spec.awsRunner}`, "--output", "json"]).then(raw => JSON.parse(raw).InstanceInformationList?.[0]?.PingStatus);
    for (const target of ["adb", "ndcs"].filter(name => spec.enabled.includes(name))) tasks[target] = this.oci(spec, target, "preflight", `/opt/kvs-dashboard/${spec.runId}/preflight/${target}`, null).then(value => value.stdout.trim());
    const entries = await Promise.all(Object.entries(tasks).map(async ([key, task]) => [key, await task])); return Object.fromEntries(entries);
  }
  async validateResources(spec) {
    const result = {};
    if (spec.enabled.includes("aws")) result.aws = JSON.parse(await this.execute("aws", ["dynamodb", "describe-table", "--profile", spec.awsProfile, "--region", spec.awsRegion, "--table-name", spec.awsTable, "--output", "json"])).Table;
    if (spec.enabled.includes("ndcs")) result.ndcs = JSON.parse(await this.execute("oci", ["nosql", "table", "get", "--profile", spec.ndcsOciProfile, "--region", spec.ndcsOciRegion, "--table-name-or-id", spec.ndcsTable, "--compartment-id", spec.ndcsCompartment, "--output", "json"])).data;
    if (spec.enabled.includes("adb")) { await this.oci(spec, "adb", "doctor", `/opt/kvs-dashboard/${spec.runId}/doctor/adb`, null); await this.collectTarget(spec, "doctor", "adb"); const adbDoctor = readJson(path.join(spec.localOutput, "evidence", "doctor", "adb", "doctor.json")); const blocking = adbDoctor.checks.filter(check => check.required && !check.passed && !(check.name === "provisioned-capacity" && check.detail?.expected && Object.keys(check.detail.expected).length === 0)); if (blocking.length) throw new Error(`ADB doctor did not pass: ${blocking.map(check => check.name).join(", ")}`); const endpoint = adbDoctor.checks.find(check => check.name === "adb-endpoint")?.detail; if (spec.adbDatabaseId && !String(endpoint).includes(spec.adbDatabaseId)) throw new Error("Selected Autonomous Database does not match the ADB runner endpoint"); result.adb = adbDoctor.table; }
    return result;
  }
  async stage(spec, action, startAt = null, session = spec.matrix[0]) {
    const base = `/opt/kvs-dashboard/${spec.runId}/${action}`;
    return Promise.all(spec.enabled.map(target => target === "aws" ? this.aws(spec, action, `${base}/aws`, startAt, session) : this.oci(spec, target, action, `${base}/${target}`, startAt, session)));
  }
  async collect(spec, action) {
    const local = path.join(spec.localOutput, "evidence", action); fs.mkdirSync(local, { recursive: true });
    await Promise.all(spec.enabled.map(target => this.collectTarget(spec, action, target)));
    return local;
  }
  async collectTarget(spec, action, target) {
    const destination = path.join(spec.localOutput, "evidence", action, target); fs.mkdirSync(destination, { recursive: true });
    if (target === "aws") return this.execute("aws", ["s3", "cp", `s3://${spec.bucket}/results/${spec.runId}/${action}/aws`, destination, "--recursive", "--only-show-errors", "--profile", spec.awsProfile, "--region", spec.awsRegion]);
    const bucket = target === "adb" ? spec.adbBucket : spec.ndcsBucket, profile = target === "adb" ? spec.adbOciProfile : spec.ndcsOciProfile, region = target === "adb" ? spec.adbOciRegion : spec.ndcsOciRegion;
    const prefix = `results/${spec.runId}/${action}/${target}/`;
    const listed = JSON.parse(await this.execute("oci", ["os", "object", "list", "--profile", profile, "--region", region, "--bucket-name", bucket, "--prefix", prefix, "--all", "--output", "json"]));
    const objects = (listed.data || []).map(item => item.name).filter(name => name.startsWith(prefix));
    if (!objects.length) throw new Error(`No OCI evidence objects found for ${target} ${action}`);
    await Promise.all(objects.map(async name => {
      const relative = name.slice(prefix.length); if (!relative || relative.includes("..")) return;
      const file = path.join(destination, ...relative.split("/")); fs.mkdirSync(path.dirname(file), { recursive: true });
      await this.execute("oci", ["os", "object", "get", "--profile", profile, "--region", region, "--bucket-name", bucket, "--name", name, "--file", file]);
    }));
    return objects;
  }
  async progress(spec, target, action) {
    try {
      if (target === "aws") {
        const raw = await this.execute("aws", ["s3", "cp", `s3://${spec.bucket}/results/${spec.runId}/${action}/aws/progress.json`, "-", "--only-show-errors", "--profile", spec.awsProfile, "--region", spec.awsRegion], { timeout: 15_000 });
        return JSON.parse(raw);
      }
      const bucket = target === "adb" ? spec.adbBucket : spec.ndcsBucket, profile = target === "adb" ? spec.adbOciProfile : spec.ndcsOciProfile, region = target === "adb" ? spec.adbOciRegion : spec.ndcsOciRegion;
      const raw = await this.execute("oci", ["os", "object", "get", "--profile", profile, "--region", region, "--bucket-name", bucket, "--name", `results/${spec.runId}/${action}/${target}/progress.json`, "--file", "-"] , { timeout: 15_000 });
      return JSON.parse(raw);
    } catch { return null; }
  }
  async progressAll(spec, action) {
    const entries = await Promise.all(spec.enabled.map(async target => [target, await this.progress(spec, target, action)]));
    return Object.fromEntries(entries.filter(([, value]) => value));
  }
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function allFiles(directory) { return fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter(item => item.isFile()).map(item => path.join(item.parentPath || item.path, item.name)); }
function packageRun(state) {
  const rows = state.sessionResults.flatMap(session => Object.entries(session.summaries).map(([target, value]) => `<tr><td>${session.id}</td><td>${target.toUpperCase()}</td><td>${value.actualStartAt}</td><td>${value.startSkewMs}</td><td>${value.completed}/${value.scheduled}</td><td>${value.successfulServiceLatencyMs?.p95 ?? "-"}</td><td>${value.successfulServiceLatencyMs?.p99 ?? "-"}</td><td>${value.successfulServiceLatencyMs?.max ?? "-"}</td></tr>`)).join("");
  const certificate = Object.values(state.certificates)[0];
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>KVS cloud benchmark</title><style>body{max-width:1100px;margin:40px auto;font:15px system-ui;color:#172033}table{width:100%;border-collapse:collapse}th,td{padding:9px;border-bottom:1px solid #ddd;text-align:left}.ok{color:#087a55}</style><h1>KVS cloud benchmark</h1><p class="ok"><b>COMPLETE</b> — ${state.sessionResults.length} synchronized matrix session(s) across ${state.spec.enabled.map(value => value.toUpperCase()).join(", ")}.</p><p>Dataset SHA-256: <code>${certificate.observedSha256}</code>.</p><table><thead><tr><th>Session</th><th>Target</th><th>Actual start UTC</th><th>Start skew ms</th><th>Completed</th><th>P95 ms</th><th>P99 ms</th><th>Max ms</th></tr></thead><tbody>${rows}</tbody></table><h2>Evidence</h2><p>The ZIP contains preload records, strong-read dataset certificates, operation-level NDJSON, telemetry, summaries, clock evidence, stage events, and SHA-256 manifest.</p></html>`;
  fs.writeFileSync(path.join(state.output, "index.html"), html);
  fs.writeFileSync(path.join(state.output, "run-state.json"), `${JSON.stringify(visible(state), null, 2)}\n`);
  fs.writeFileSync(path.join(state.output, "pipeline-log.ndjson"), `${(state.logs || []).map(item => JSON.stringify(item)).join("\n")}\n`);
  const files = allFiles(state.output).filter(file => !file.endsWith(".zip") && !file.endsWith("manifest-sha256.json") && path.basename(file) !== stateFileName);
  const entries = files.map(file => ({ path: path.relative(state.output, file).replaceAll("\\", "/"), data: fs.readFileSync(file) }));
  const manifest = { schemaVersion: 1, runId: state.id, generatedAt: new Date().toISOString(), entries: entries.map(item => ({ path: item.path, bytes: item.data.length, sha256: crypto.createHash("sha256").update(item.data).digest("hex") })) };
  const manifestData = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`); fs.writeFileSync(path.join(state.output, "manifest-sha256.json"), manifestData);
  state.archiveFile = path.join(state.output, `${state.id}-benchmark-output.zip`); fs.writeFileSync(state.archiveFile, createZip([...entries.map(item => ({ name: item.path, data: item.data })), { name: "manifest-sha256.json", data: manifestData }]));
}

export class CloudAcceptanceRuns {
  constructor({ outputRoot = defaultOutput, adapter = new CliCloudAdapter() } = {}) {
    this.outputRoot = outputRoot; this.adapter = adapter; this.runs = new Map();
    for (const state of readRunStates(outputRoot)) {
      if (["queued", "running"].includes(state.status)) { state.status = "failed"; state.completedAt = new Date().toISOString(); state.error = "Dashboard restarted while this run was active. Remote commands may require provider-side inspection before retrying."; appendLog(state, { level: "error", message: state.error }); }
      if (state.archiveFile && !fs.existsSync(state.archiveFile)) state.archiveFile = null;
      this.runs.set(state.id, state); this.persist(state);
    }
  }
  persist(state) { writeStateAtomic(state.output, state); }
  start(input) {
    if ([...this.runs.values()].some(run => ["queued", "running"].includes(run.status))) throw new Error("A cloud acceptance run is already active");
    const spec = validate(input), id = `cloud-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`, output = path.join(this.outputRoot, id);
    Object.assign(spec, { runId: id, localOutput: output });
    const state = { id, spec, status: "queued", createdAt: new Date().toISOString(), output, outputRelative: path.relative(repositoryRoot, output).replaceAll("\\", "/"), stages: stages.map(stageView), targetStatus: Object.fromEntries(spec.enabled.map(name => [name, "pending"])), targetMetrics: {}, sessionResults: [], logs: [] };
    appendLog(state, { message: `Run queued for ${spec.enabled.map(name => name.toUpperCase()).join(", ")}; ${spec.matrix.length} synchronized session(s)` });
    this.runs.set(id, state); this.persist(state); void this.execute(state); return visible(state);
  }
  get(id) { const state = this.runs.get(id); if (!state) throw new Error("Cloud run not found"); return visible(state); }
  active() {
    const state = [...this.runs.values()].find(run => ["queued", "running"].includes(run.status));
    return state ? visible(state) : null;
  }
  latest() {
    const state = [...this.runs.values()].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
    return state ? visible(state) : null;
  }
  download(id) { const state = this.runs.get(id); if (!state?.archiveFile) throw new Error("Cloud benchmark output is not ready"); return state.archiveFile; }
  async step(state, name, task) {
    const stage = state.stages.find(item => item.name === name); stage.status = "running"; stage.startedAt = new Date().toISOString();
    appendLog(state, { stage: name, message: "Stage started" }); this.persist(state);
    try { const result = await task(); stage.status = "complete"; stage.completedAt = new Date().toISOString(); stage.detail = typeof result === "string" ? result : result ? JSON.stringify(result).slice(0, 600) : "Passed"; appendLog(state, { level: "success", stage: name, message: stage.detail }); this.persist(state); return result; }
    catch (error) { stage.status = "failed"; stage.completedAt = new Date().toISOString(); stage.detail = error.message; appendLog(state, { level: "error", stage: name, message: error.message }); this.persist(state); throw error; }
  }
  async execute(state) {
    const spec = state.spec; fs.mkdirSync(state.output, { recursive: true }); state.status = "running"; state.startedAt = new Date().toISOString(); appendLog(state, { message: `Pipeline started; evidence path ${state.outputRelative}` }); this.persist(state);
    try {
      await this.step(state, "runner-readiness", () => this.adapter.preflight(spec));
      await this.step(state, "resource-validation", () => this.adapter.validateResources(spec));
      await this.step(state, "dataset-preload", async () => { state.targetStatus = Object.fromEntries(spec.enabled.map(name => [name, "preloading"])); const value = await this.adapter.stage(spec, "preload"); state.targetStatus = Object.fromEntries(spec.enabled.map(name => [name, "preloaded"])); return value.map(item => item.stdout?.slice(-120)); });
      await this.step(state, "dataset-certification", async () => { state.targetStatus = Object.fromEntries(spec.enabled.map(name => [name, "certifying"])); await this.adapter.stage(spec, "certify"); await this.adapter.collect(spec, "certify"); state.certificates = Object.fromEntries(spec.enabled.map(target => [target, readJson(path.join(state.output, "evidence", "certify", target, "dataset-certificate.json"))])); state.targetStatus = Object.fromEntries(spec.enabled.map(name => [name, "certified"])); return Object.fromEntries(Object.entries(state.certificates).map(([key, value]) => [key, value.observedSha256])); });
      await this.step(state, "dataset-hash-match", () => { const hashes = Object.values(state.certificates).map(value => value.observedSha256); if (new Set(hashes).size !== 1 || Object.values(state.certificates).some(value => !value.passed)) throw new Error("Dataset certificates do not match"); return hashes[0]; });
      await this.step(state, "t0-scheduled", () => `${spec.matrix.length} synchronized session T0 value(s) will use a ${spec.t0LeadSeconds}s delivery window`);
      await this.step(state, "workload", async () => {
        for (const session of spec.matrix) {
          state.currentSession = { id: session.id, configFile: session.configFile, repetition: session.repetition, index: state.sessionResults.length + 1, total: spec.matrix.length, offeredOperationsPerSecond: session.averageScheduledOperationsPerSecond, durationSeconds: session.durationSeconds };
          state.sharedStartAt = new Date(Math.ceil((Date.now() + spec.t0LeadSeconds * 1000) / 10_000) * 10_000).toISOString();
          appendLog(state, { stage: "workload", message: `Session ${state.currentSession.index}/${state.currentSession.total} ${session.id}; T0 ${state.sharedStartAt}; ${session.durationSeconds}s; ${session.averageScheduledOperationsPerSecond} offered ops/s` });
          state.targetStatus = Object.fromEntries(spec.enabled.map(name => [name, "running"]));
          for (const target of spec.enabled) appendLog(state, { stage: "workload", target, message: "Remote workload submitted" });
          const action = `run/${session.id}`; let finished = false, stageError = null, lastProgressLogAt = 0;
          const running = this.adapter.stage(spec, action, state.sharedStartAt, session).catch(error => { stageError = error; }).finally(() => { finished = true; });
          while (!finished) {
            await sleep(1000);
            if (typeof this.adapter.progressAll === "function") {
              const progress = await this.adapter.progressAll(spec, action);
              if (Object.keys(progress).length) {
                state.targetMetrics = Object.fromEntries(Object.entries(progress).map(([target, value]) => [target, { completed: value.completed, failed: value.failed, scheduled: value.scheduled, operationsPerSecond: value.achievedOperationsPerSecond, inFlight: value.inFlight, latestLatencyMs: value.latestLatencyMs, rollingP95Ms: value.rollingP95Ms, at: value.at, provisional: true }]));
                if (Date.now() - lastProgressLogAt >= 5000) { for (const [target, value] of Object.entries(progress)) appendLog(state, { stage: "workload", target, message: `${value.completed || 0}/${value.scheduled || session.scheduledOperationsPerTarget} completed; ${Number(value.achievedOperationsPerSecond || 0).toFixed(1)} ops/s; p95 ${value.rollingP95Ms == null ? "-" : Number(value.rollingP95Ms).toFixed(2)} ms; ${value.failed || 0} failed` }); lastProgressLogAt = Date.now(); }
                this.persist(state);
              }
            }
          }
          await running;
          if (stageError) throw stageError;
          state.targetStatus = Object.fromEntries(spec.enabled.map(name => [name, "collecting"]));
          await this.adapter.collect(spec, `run/${session.id}`);
          const summaries = Object.fromEntries(spec.enabled.map(target => [target, readJson(path.join(state.output, "evidence", "run", session.id, target, "summary.json"))]));
          state.summaries = summaries;
          state.targetMetrics = Object.fromEntries(Object.entries(summaries).map(([target, value]) => [target, { completed: value.completed, failed: value.failed, operationsPerSecond: value.achievedOperationsPerSecond, inFlight: 0, observedMaxInFlight: value.concurrency?.observedAtOperationStart?.max ?? null, latestLatencyMs: value.successfulServiceLatencyMs?.max ?? null, p95: value.successfulServiceLatencyMs?.p95 ?? null, p99: value.successfulServiceLatencyMs?.p99 ?? null, max: value.successfulServiceLatencyMs?.max ?? null, provisional: false }]));
          state.sessionResults.push({ id: session.id, configFile: session.configFile, repetition: session.repetition, sharedStartAt: state.sharedStartAt, summaries });
          state.targetStatus = Object.fromEntries(spec.enabled.map(name => [name, "completed"]));
          for (const [target, summary] of Object.entries(summaries)) appendLog(state, { level: summary.failed ? "error" : "success", stage: "workload", target, message: `Session complete; ${summary.completed}/${summary.scheduled} operations; p95 ${summary.successfulServiceLatencyMs?.p95 ?? "-"} ms; p99 ${summary.successfulServiceLatencyMs?.p99 ?? "-"} ms` });
        }
        state.currentSession = null;
        return `${state.sessionResults.length} matrix session(s) completed`;
      });
      await this.step(state, "evidence-collection", () => path.join(state.output, "evidence", "run"));
      await this.step(state, "acceptance-validation", () => { let maximumStartSkewMs = 0; for (const session of state.sessionResults) { const values = Object.values(session.summaries); if (values.some(value => !value.harnessPassed || value.accounted !== value.scheduled || value.failed !== 0)) throw new Error(`${session.id} failed accounting or service acceptance`); if (new Set(values.map(value => value.configSha256)).size !== 1 || new Set(values.map(value => value.scheduledStartAt)).size !== 1) throw new Error(`${session.id} configuration hash or T0 differs across targets`); maximumStartSkewMs = Math.max(maximumStartSkewMs, ...values.map(value => Math.abs(value.startSkewMs))); } return { sessions: state.sessionResults.length, maximumStartSkewMs }; });
      await this.step(state, "package-generation", () => packageRun(state));
      state.status = "complete"; state.completedAt = new Date().toISOString(); appendLog(state, { level: "success", message: "Benchmark pipeline completed" }); packageRun(state); this.persist(state);
    } catch (error) { state.status = "failed"; state.error = error.message; state.completedAt = new Date().toISOString(); appendLog(state, { level: "error", message: `Pipeline stopped: ${error.message}` }); this.persist(state); }
  }
}

export { defaultImage, remoteScript };
