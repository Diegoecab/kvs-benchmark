import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { createZipFile, inspectFile } from "./artifact.mjs";
import { previewMatrix } from "./preview.mjs";
import { executeOciRunCommand } from "./oci-run-command.mjs";
import { readRunStates, stateFileName, writeStateAtomic } from "./file-state.mjs";
import { writeWorkloadStageSummary } from "./workload-stages.mjs";
import { distribution } from "../core/statistics.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const configDirectory = path.join(repositoryRoot, "configs");
const defaultOutput = path.join(repositoryRoot, ".kvs", "cloud-runs");
const defaultImage = "ghcr.io/diegoecab/kvs-benchmark-runner@sha256:7bf7c3d1d3d5ae1b650ca38f8434ec545572bec6a7c07bdd3829b0f29bb392c9";
const stages = ["runner-readiness", "resource-validation", "dataset-preload", "dataset-certification", "dataset-hash-match", "t0-scheduled", "workload", "evidence-collection", "acceptance-validation", "package-generation"];
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const terminalStatuses = new Set(["complete", "failed", "stopped"]);
const safe = (value, pattern, label) => { if (!pattern.test(value || "")) throw new Error(`${label} is invalid`); return value; };
const shellQuote = value => `'${String(value).replaceAll("'", `'"'"'`)}'`;
const finalWorkloadEvidence = ["operations.ndjson", "telemetry.ndjson", "summary.json", "run-config.json", "clock.txt"];
const finalPreloadEvidence = ["preload-operations.ndjson", "preload-summary.json", "clock.txt"];

function runnerMetadata(value = {}) {
  const text = (item, pattern) => item && pattern.test(String(item)) ? String(item) : null;
  const positive = item => Number.isFinite(Number(item)) && Number(item) > 0 ? Number(item) : null;
  return {
    displayName: text(value.displayName || value.name, /^[\w .:@/+-]{1,160}$/u),
    privateIp: text(value.privateIp, /^[0-9a-f:.]{2,64}$/i),
    publicIp: text(value.publicIp, /^[0-9a-f:.]{2,64}$/i),
    egressIp: text(value.egressIp, /^[0-9a-f:.]{2,64}$/i),
    egressIpVerified: value.egressIpVerified === true,
    availabilityDomain: text(value.availabilityDomain || value.availabilityZone, /^[\w .:@/+-]{1,160}$/u),
    shape: text(value.shape || value.instanceType, /^[A-Za-z0-9_.-]{1,80}$/),
    vcpus: positive(value.vcpus),
    memoryGB: positive(value.memoryGB),
    networkMode: text(value.networkMode, /^[A-Za-z0-9_. -]{1,120}$/),
  };
}

function normalizeTargetRunners(target, { count, idPattern, label, requireCompartment = false }) {
  const supplied = Array.isArray(target.runners) && target.runners.length
    ? target.runners
    : (Array.isArray(target.runnerIds) && target.runnerIds.length ? target.runnerIds.map((id, index) => ({ id, compartmentId: target.runnerCompartmentIds?.[index] })) : [{ id: target.runnerId, compartmentId: target.runnerCompartmentId }]);
  if (supplied.length !== count) throw new Error(`${label} requires exactly ${count} distinct runner VM(s)`);
  const runners = supplied.map((value, index) => {
    const item = typeof value === "string" ? { id: value } : value || {};
    const runner = { id: safe(item.id, idPattern, `${label} runner ${index + 1}`), ...runnerMetadata(item) };
    if (requireCompartment) runner.compartmentId = safe(item.compartmentId || target.runnerCompartmentIds?.[index] || target.runnerCompartmentId, /^ocid1\.(compartment|tenancy)\./, `${label} runner ${index + 1} compartment`);
    return runner;
  });
  if (new Set(runners.map(item => item.id)).size !== runners.length) throw new Error(`${label} runner VMs must be distinct`);
  const identities = runners.map(item => item.publicIp || item.privateIp).filter(Boolean);
  if (identities.length === runners.length && new Set(identities).size !== identities.length) throw new Error(`${label} runner network identities must be distinct`);
  return runners;
}

function targetRunners(spec, target) {
  const plural = spec[`${target}Runners`];
  if (Array.isArray(plural) && plural.length) return plural;
  const id = spec[`${target}Runner`];
  if (!id) return [];
  return [{ id, compartmentId: spec[`${target}RunnerCompartment`] || null }];
}

const sourceKey = index => `source-${String(index + 1).padStart(2, "0")}`;
const sourceRelative = (spec, target, index) => targetRunners(spec, target).length > 1 ? path.join("sources", sourceKey(index)) : "";
const sourceRemote = (spec, target, index) => targetRunners(spec, target).length > 1 ? `/sources/${sourceKey(index)}` : "";
function localShardScheduled(total, index, count) {
  const scheduled = Number(total);
  if (!Number.isInteger(scheduled) || scheduled < 0) return 0;
  return scheduled <= index ? 0 : Math.floor((scheduled - 1 - index) / count) + 1;
}

function evidenceSources(spec, action, target) {
  const runners = targetRunners(spec, target);
  if ((!action.startsWith("run/") && action !== "preload") || runners.length <= 1) return [{ index: 0, key: sourceKey(0), runner: runners[0], relative: "" }];
  return runners.map((runner, index) => ({ index, key: sourceKey(index), runner, relative: sourceRelative(spec, target, index) }));
}

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
  result.loadGeneratorCount = Number(input.execution?.loadGeneratorCount ?? input.loadGeneratorCount ?? 1);
  if (!Number.isInteger(result.loadGeneratorCount) || result.loadGeneratorCount < 1 || result.loadGeneratorCount > 32) throw new Error("Load generators per target must be an integer between 1 and 32");
  const requestedLead = input.execution?.t0LeadSeconds;
  if (requestedLead != null && (!Number.isInteger(Number(requestedLead)) || Number(requestedLead) < 30 || Number(requestedLead) > 3600)) throw new Error("T0 lead time must be an integer between 30 and 3600 seconds");
  result.t0LeadSeconds = requestedLead == null ? (enabled.some(name => name === "adb" || name === "ndcs") ? 900 : 120) : Number(requestedLead);
  result.capturePreloadMetrics = Boolean(input.execution?.capturePreloadMetrics);
  result.preloadRate = Number(input.execution?.preloadRate ?? (result.capturePreloadMetrics ? 400 : 20));
  result.preloadMaxInflight = Number(input.execution?.preloadMaxInflight ?? (result.capturePreloadMetrics ? 128 : 16));
  result.preloadMaxAttempts = Number(input.execution?.preloadMaxAttempts ?? 5);
  result.preloadRetryDelayMs = Number(input.execution?.preloadRetryDelayMs ?? 250);
  if (!Number.isInteger(result.preloadRate) || result.preloadRate < 1 || result.preloadRate > 10_000) throw new Error("Preload rate must be an integer between 1 and 10000 operations per second");
  if (!Number.isInteger(result.preloadMaxInflight) || result.preloadMaxInflight < 1 || result.preloadMaxInflight > 1024) throw new Error("Preload max in-flight must be an integer between 1 and 1024");
  if (!Number.isInteger(result.preloadMaxAttempts) || result.preloadMaxAttempts < 1 || result.preloadMaxAttempts > 20) throw new Error("Preload max attempts must be an integer between 1 and 20");
  if (!Number.isInteger(result.preloadRetryDelayMs) || result.preloadRetryDelayMs < 50 || result.preloadRetryDelayMs > 10_000) throw new Error("Preload retry delay must be an integer between 50 and 10000 milliseconds");
  if (enabled.includes("aws")) {
    const awsRunners = normalizeTargetRunners(target.aws, { count: result.loadGeneratorCount, idPattern: /^i-[a-f0-9]+$/, label: "AWS" });
    Object.assign(result, { awsProfile: safe(target.aws.profile, /^[A-Za-z0-9_.-]+$/, "AWS profile"), awsRegion: safe(target.aws.region, /^[a-z]{2}-[a-z]+-\d$/, "AWS region"), awsTable: safe(target.aws.resource, /^[A-Za-z0-9_.-]+$/, "AWS table"), awsRunners, awsRunner: awsRunners[0].id, bucket: safe(input.artifactBucket, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "Artifact bucket") });
  }
  if (enabled.includes("adb")) {
    const adbRunners = normalizeTargetRunners(target.adb, { count: result.loadGeneratorCount, idPattern: /^ocid1\.instance\./, label: "ADB", requireCompartment: true });
    Object.assign(result, { adbOciProfile: safe(target.adb.profile, /^[A-Za-z0-9_.-]+$/, "ADB OCI profile"), adbOciRegion: safe(target.adb.region, /^[a-z]{2}-[a-z]+-\d$/, "ADB OCI region"), adbTable: safe(target.adb.resource, /^[A-Za-z0-9_.-]+$/, "ADB table"), adbRunners, adbRunner: adbRunners[0].id, adbRunnerCompartment: adbRunners[0].compartmentId, adbBucket: safe(target.adb.evidenceBucket, /^[A-Za-z0-9_.-]+$/, "ADB evidence bucket"), adbDatabaseId: target.adb.databaseId ? safe(target.adb.databaseId, /^ocid1\.autonomousdatabase\./, "Autonomous Database") : null, adbDatabaseVersion: target.adb.databaseVersion ? safe(target.adb.databaseVersion, /^(?:19c|26ai)$/, "Autonomous Database version") : null, adbComputeModel: target.adb.computeModel ? safe(target.adb.computeModel, /^(?:ECPU|OCPU)$/, "Autonomous Database compute model") : null, adbComputeCount: Number.isFinite(Number(target.adb.computeCount)) ? Number(target.adb.computeCount) : null, adbLicenseModel: target.adb.licenseModel ? safe(target.adb.licenseModel, /^(?:BRING_YOUR_OWN_LICENSE|LICENSE_INCLUDED)$/, "Autonomous Database license model") : null, adbWorkload: target.adb.workload ? safe(target.adb.workload, /^(?:OLTP|DW|AJD|APEX|LH)$/, "Autonomous Database workload") : null });
  }
  if (enabled.includes("ndcs")) {
    const ndcsRunners = normalizeTargetRunners(target.ndcs, { count: result.loadGeneratorCount, idPattern: /^ocid1\.instance\./, label: "OCI NoSQL", requireCompartment: true });
    Object.assign(result, { ndcsOciProfile: safe(target.ndcs.profile, /^[A-Za-z0-9_.-]+$/, "OCI NoSQL profile"), ndcsOciRegion: safe(target.ndcs.region, /^[a-z]{2}-[a-z]+-\d$/, "OCI NoSQL region"), ndcsTable: safe(target.ndcs.resource, /^[A-Za-z0-9_.-]+$/, "OCI NoSQL table"), ndcsRunners, ndcsRunner: ndcsRunners[0].id, ndcsRunnerCompartment: ndcsRunners[0].compartmentId, ndcsBucket: safe(target.ndcs.evidenceBucket, /^[A-Za-z0-9_.-]+$/, "OCI NoSQL evidence bucket"), ndcsCompartment: safe(target.ndcs.compartmentId, /^ocid1\.compartment\./, "OCI NoSQL compartment") });
  }
  const preview = previewMatrix(input, { configDirectory });
  const incompatible = preview.rows.find(row => row.loadModel === "closed-loop" && Number(row.fixedConcurrency || 0) < result.loadGeneratorCount);
  if (incompatible) throw new Error(`${incompatible.id} has ${incompatible.fixedConcurrency} fixed-concurrency workers but ${result.loadGeneratorCount} load generators were selected`);
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
function resumable(state) {
  const prerequisiteStages = ["runner-readiness", "resource-validation", "dataset-preload", "dataset-certification", "dataset-hash-match", "t0-scheduled"];
  const certificates = Object.values(state.certificates || {});
  const prerequisitesPassed = prerequisiteStages.every(name => state.stages?.find(item => item.name === name)?.status === "complete");
  const workloadInterrupted = state.status === "failed" && state.stages?.find(item => item.name === "workload")?.status === "failed" && Number(state.sessionResults?.length || 0) < Number(state.spec?.matrix?.length || 0);
  const matrixFinalized = Number(state.sessionResults?.length || 0) === Number(state.spec?.matrix?.length || 0) && Number(state.spec?.matrix?.length || 0) > 0;
  const packagingInterrupted = matrixFinalized && ["failed", "running"].includes(state.status) && (state.status !== "running" || state.controlOwnerPid !== process.pid);
  return (workloadInterrupted || packagingInterrupted)
    && prerequisitesPassed
    && certificates.length === state.spec?.enabled?.length
    && certificates.every(item => item.passed === true)
    && new Set(certificates.map(item => item.observedSha256)).size === 1;
}
function hydratePersistedStageSummaries(state) {
  for (const result of state.sessionResults || []) {
    if (Object.keys(result.stageSummaries || {}).length) continue;
    const session = state.spec?.matrix?.find(item => item.id === result.id), summaries = {};
    if (!session) continue;
    for (const target of state.spec.enabled || []) {
      const file = path.join(state.output, "evidence", "run", session.id, target, "stage-summary.json");
      if (fs.existsSync(file)) { try { summaries[target] = JSON.parse(fs.readFileSync(file, "utf8")); } catch {} }
    }
    if (Object.keys(summaries).length) result.stageSummaries = summaries;
  }
}
function visible(state) {
  hydratePersistedStageSummaries(state);
  return { schemaVersion: 1, id: state.id, kind: "cloud-benchmark", mode: state.spec.mode, status: state.status, canStop: ["queued", "running", "stopping"].includes(state.status) && state.controlOwnerPid === process.pid, canResume: resumable(state), createdAt: state.createdAt, startedAt: state.startedAt || null, completedAt: state.completedAt || null, stages: state.stages, targetStatus: state.targetStatus, sharedStartAt: state.sharedStartAt || null, preloadStartAt: state.preloadStartAt || null, preloadSummaries: state.preloadSummaries || null, currentSession: state.currentSession || null, matrix: state.spec.matrix, loadGeneratorCount: state.spec.loadGeneratorCount || 1, resourceInventory: state.resourceInventory || null, certificates: state.certificates || null, summaries: state.summaries || null, sessionResults: state.sessionResults || [], targetMetrics: state.targetMetrics || {}, runnerMetricSamples: state.runnerMetricSamples || [], logs: state.logs || [], error: state.error || null, output: state.outputRelative, downloadUrl: state.archiveFile ? `/api/runs/${encodeURIComponent(state.id)}/download` : null };
}

function historyVisible(state) {
  const run = visible(state);
  const workloadNames = [...new Set((run.matrix || []).map(item => item.name || item.configName).filter(Boolean))];
  return {
    id: run.id,
    kind: run.kind,
    mode: run.mode,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    targets: Object.keys(run.targetStatus || {}),
    sessionCount: run.matrix?.length || 0,
    completedSessions: run.sessionResults?.length || 0,
    workloadNames,
    currentSession: run.currentSession ? { id: run.currentSession.id, index: run.currentSession.index, total: run.currentSession.total } : null,
    error: run.error,
    downloadUrl: run.downloadUrl
  };
}

function resourceInventory(spec, observed = {}) {
  const inventory = {};
  const runners = target => targetRunners(spec, target).map((runner, index) => ({ source: sourceKey(index), ...runner }));
  if (spec.enabled.includes("aws")) inventory.aws = { region: spec.awsRegion, loadGeneratorCount: runners("aws").length, runnerInstances: runners("aws"), runnerInstanceId: spec.awsRunner, tableName: spec.awsTable, tableArn: observed.aws?.TableArn || null };
  if (spec.enabled.includes("adb")) inventory.adb = { region: spec.adbOciRegion, loadGeneratorCount: runners("adb").length, runnerInstances: runners("adb"), runnerInstanceOcid: spec.adbRunner, autonomousDatabaseOcid: spec.adbDatabaseId || null, databaseVersion: spec.adbDatabaseVersion || null, computeModel: spec.adbComputeModel || null, computeCount: spec.adbComputeCount || null, licenseModel: spec.adbLicenseModel || null, workload: spec.adbWorkload || null, tableName: spec.adbTable };
  if (spec.enabled.includes("ndcs")) inventory.ndcs = { region: spec.ndcsOciRegion, loadGeneratorCount: runners("ndcs").length, runnerInstances: runners("ndcs"), runnerInstanceOcid: spec.ndcsRunner, compartmentOcid: spec.ndcsCompartment, tableName: spec.ndcsTable, tableOcid: observed.ndcs?.id || observed.ndcs?.Id || null };
  return inventory;
}

function sortedMetricPoints(points = []) {
  return points.map(point => ({ timestamp: point.timestamp || point.Timestamp, value: Number(point.value ?? point.Value) })).filter(point => point.timestamp && Number.isFinite(point.value)).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}
function counterRates(points = []) {
  const sorted = sortedMetricPoints(points), rates = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const seconds = (Date.parse(sorted[index].timestamp) - Date.parse(sorted[index - 1].timestamp)) / 1000, delta = sorted[index].value - sorted[index - 1].value;
    if (seconds > 0 && delta >= 0) rates.push({ timestamp: sorted[index].timestamp, value: delta / seconds });
  }
  return rates;
}

function aggregateMetricPoints(reports, metric, reducer) {
  const byTimestamp = new Map();
  for (const report of reports) for (const point of report.metrics?.[metric] || []) {
    const timestamp = point.timestamp || point.Timestamp, value = Number(point.value ?? point.Value);
    if (!timestamp || !Number.isFinite(value)) continue;
    const values = byTimestamp.get(timestamp) || []; values.push(value); byTimestamp.set(timestamp, values);
  }
  return [...byTimestamp.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([timestamp, values]) => ({ timestamp, value: reducer(values) }));
}
function aggregateRunnerMetricReports(target, reports) {
  if (reports.length === 1) return { ...reports[0], loadGeneratorCount: 1, sources: reports };
  const maximum = values => Math.max(...values), sum = values => values.reduce((total, value) => total + value, 0);
  const metrics = {};
  for (const name of ["cpuUtilizationPercent", "cpuMaximumPercent", "memoryUtilizationPercent", "loadAverage1m"]) metrics[name] = aggregateMetricPoints(reports, name, maximum);
  for (const name of ["networkReceiveBytesPerSecond", "networkTransmitBytesPerSecond"]) metrics[name] = aggregateMetricPoints(reports, name, sum);
  metrics.statusCheckFailed = aggregateMetricPoints(reports, "statusCheckFailed", maximum);
  return { schemaVersion: 2, target, available: reports.some(report => report.available), source: `${reports[0]?.source || "provider metrics"} · ${reports.length} load generators`, resourceIds: reports.map(report => report.resourceId), region: reports[0]?.region, startAt: reports[0]?.startAt, endAt: reports[0]?.endAt, periodSeconds: 60, loadGeneratorCount: reports.length, aggregation: { cpuMemoryLoad: "maximum across load generators", network: "sum across load generators", statusCheck: "maximum across load generators" }, metrics, unavailable: Object.keys(metrics).filter(name => !metrics[name].length), sources: reports };
}
function aggregateLiveRunner(sources) {
  const available = sources.filter(source => source.value.runner?.available);
  if (!available.length) return { available: false, scope: "runner-vm-fleet", sources: [] };
  const maximum = key => { const values = available.map(source => Number(source.value.runner[key])).filter(Number.isFinite); return values.length ? Math.max(...values) : null; };
  const sum = key => available.reduce((total, source) => total + Number(source.value.runner[key] || 0), 0);
  return { available: true, scope: "runner-vm-fleet", loadGeneratorCount: sources.length, cpuUtilizationPercent: maximum("cpuUtilizationPercent"), memoryUtilizationPercent: maximum("memoryUtilizationPercent"), loadAverage1m: maximum("loadAverage1m"), networkReceiveBytesPerSecond: sum("networkReceiveBytesPerSecond"), networkTransmitBytesPerSecond: sum("networkTransmitBytesPerSecond"), aggregation: "max CPU/memory/load; summed network", sources: sources.map(source => ({ source: source.source, ...source.value.runner })) };
}
function aggregateProgressSources(sources) {
  const numberSum = key => sources.reduce((sum, source) => sum + Number(source.value[key] || 0), 0);
  const finiteMax = key => { const values = sources.map(source => Number(source.value[key])).filter(Number.isFinite); return values.length ? Math.max(...values) : null; };
  return { at: sources.map(source => source.value.at).filter(Boolean).sort().at(-1) || null, scheduled: numberSum("scheduled"), completed: numberSum("completed"), failed: numberSum("failed"), inFlight: numberSum("inFlight"), achievedOperationsPerSecond: numberSum("achievedOperationsPerSecond"), latestLatencyMs: finiteMax("latestLatencyMs"), rollingP95Ms: finiteMax("rollingP95Ms"), loadGeneratorCount: sources.length, progressAggregation: "sum counts/throughput; maximum source rolling latency", runner: aggregateLiveRunner(sources), sources: sources.map(source => ({ source: source.source, ...source.value, runner: undefined })) };
}

function runtimeArguments(spec, session, { workload = true } = {}) {
  const ignored = new Set(session?.ignoredOverrides || []), values = session?.effectiveOverrides || spec.overrides || {};
  const names = { durationSeconds: "duration-seconds", fixedConcurrency: "fixed-concurrency", readPercent: "read-percent", writePercent: "write-percent", writeMode: "write-mode", rateMultiplier: "rate-multiplier", executionMode: "execution-mode", consistency: "consistency" };
  const datasetOptions = new Set(["consistency"]);
  return Object.entries(names).filter(([name]) => values[name] != null && !ignored.has(name) && (workload || datasetOptions.has(name))).map(([name, option]) => `--${option}=${shellQuote(values[name])}`).join(" ");
}


function liveMonitor(root, scheduled, upload = "") {
  return `previous_total=0
previous_at=$(date +%s)
write_progress(){
  operations="$root/operations.ndjson"
  telemetry="$root/telemetry.ndjson"
  completed=0; total=0; failed=0; latest=null; inflight=0; p95=null
  if [ -s "$operations" ]; then
    set -- $(awk '/^\\{.*\\}$/ { total++; if ($0 ~ /\"error\":null/) completed++ } END { print completed+0, total+0 }' "$operations")
    completed=$1; total=$2; failed=$((total-completed))
    latest=$(tail -n 1 "$operations" | jq -r '.serviceLatencyMs // 0')
    p95=$(tail -n 1000 "$operations" | jq -s '[.[]|select(.error==null)|.serviceLatencyMs]|sort|if length==0 then null else .[((length-1)*0.95|floor)] end')
  fi
  runner=null
  if [ -s "$telemetry" ]; then inflight=$(tail -n 1 "$telemetry" | jq -r '.inFlight // 0'); runner=$(tail -n 1 "$telemetry" | jq -c '.runner // null'); fi
  now=$(date +%s); elapsed=$((now-previous_at)); if [ "$elapsed" -lt 1 ]; then elapsed=1; fi
  delta=$((total-previous_total)); if [ "$delta" -lt 0 ]; then delta=0; fi
  if [ "$total" -eq 0 ]; then rate=0; else rate=$(awk -v delta="$delta" -v elapsed="$elapsed" 'BEGIN { printf "%.6f", delta/elapsed }'); fi
  previous_total=$total; previous_at=$now
  jq -n --arg at "$(date -u +%FT%TZ)" --argjson scheduled ${Number(scheduled || 0)} --argjson completed "$completed" --argjson failed "$failed" --argjson inflight "$inflight" --argjson latest "$latest" --argjson p95 "$p95" --argjson rate "$rate" --argjson runner "$runner" '{at:$at,scheduled:$scheduled,completed:$completed,failed:$failed,inFlight:$inflight,latestLatencyMs:$latest,rollingP95Ms:$p95,achievedOperationsPerSecond:$rate,runner:$runner}' > "$root/progress.json.tmp"
  mv "$root/progress.json.tmp" "$root/progress.json"
  ${upload}
}
`;
}

function adbCredentialGuard(spec) {
  const workloadSeconds = spec.matrix.reduce((sum, session) => sum + Number(session.durationSeconds || 0) + Number(spec.t0LeadSeconds || 0), 0);
  const requiredSeconds = Math.max(86_400, workloadSeconds + 7_200);
  const secretEnvironmentName = "AWS_" + "SECRET_ACCESS_KEY";
  const javascript = `const f=await import("node:fs"),c=await import("node:crypto");const runtimeFile="/secure/adb-api.runtime.json",envFile="/secure/adb-api.runtime.env",adminFile="/secure/.adb-admin-password";const runtime=JSON.parse(f.readFileSync(runtimeFile,"utf8"));const expiration=Date.parse(runtime.expirationTime||"");const required=Number(process.env.KVS_REQUIRED_SECONDS)*1000;if(Number.isFinite(expiration)&&expiration-Date.now()>required){console.log(JSON.stringify({credential:"valid",expirationTime:runtime.expirationTime}));process.exit(0);}if(!f.existsSync(adminFile))throw new Error("ADB access key does not cover the planned run and the protected renewal credential is not installed on this runner");const password=f.readFileSync(adminFile,"utf8").trim(),auth="Basic "+Buffer.from("ADMIN:"+password).toString("base64"),authEndpoint="https://dataaccess.adb."+runtime.region+".oraclecloudapps.com/adb/auth/v1/databases/"+runtime.databaseId+"/accesskeys",table=(runtime.tableNames||[])[0]||process.env.KVS_TABLE,payload={name:"kvs-benchmark-runner",description:"Automatically renewed table-scoped benchmark credential",permissions:[{actions:["READ_WRITE"],resources:[table]}],expiration_minutes:5256000};let response;for(let attempt=0;attempt<12;attempt++){response=await fetch(authEndpoint,{method:"POST",headers:{authorization:auth,"content-type":"application/json",accept:"application/json","request-id":c.randomUUID()},body:JSON.stringify(payload)});if(response.ok)break;if(response.status!==503)break;await new Promise(resolve=>setTimeout(resolve,10000));}if(!response?.ok)throw new Error("ADB access key renewal failed HTTP "+response.status+" "+(await response.text()).slice(0,300));const key=await response.json(),next={...runtime,accessKeyId:key.access_key_id,secretAccessKey:key.secret_access_key,expirationTime:key.expiration_timestamp||key.expiration_time||"",tableNames:[table]},runtimeTemp=runtimeFile+".tmp",envTemp=envFile+".tmp";f.writeFileSync(runtimeTemp,JSON.stringify(next,null,2),{mode:0o600});f.writeFileSync(envTemp,"AWS_ACCESS_KEY_ID="+next.accessKeyId+"\\n${secretEnvironmentName}="+next.secretAccessKey+"\\nDDB_ENDPOINT="+next.endpoint+"\\n",{mode:0o600});f.renameSync(runtimeTemp,runtimeFile);f.renameSync(envTemp,envFile);f.chmodSync(runtimeFile,0o600);f.chmodSync(envFile,0o600);console.log(JSON.stringify({credential:"renewed",expirationTime:next.expirationTime,table}));`;
  return `sudo -n podman run --rm --user 0:0 -v /opt/kvs-dashboard:/secure:Z -e KVS_REQUIRED_SECONDS=${requiredSeconds} -e KVS_TABLE=${shellQuote(spec.adbTable)} --entrypoint node ${shellQuote(spec.image)} --input-type=module --eval '${javascript}'`;
}

function remoteScript(spec, target, action, output, startAt, session = spec.matrix[0], runnerContext = { index: 0, count: 1 }) {
  const table = target === "adb" ? spec.adbTable : spec.ndcsTable;
  const bucket = target === "adb" ? spec.adbBucket : spec.ndcsBucket;
  const region = target === "adb" ? spec.adbOciRegion : spec.ndcsOciRegion;
  const env = target === "adb"
    ? `envargs=(--env-file /opt/kvs-dashboard/adb-api.runtime.env -e AWS_REGION=${spec.adbOciRegion})`
    : `envargs=(-e OCI_USE_INSTANCE_PRINCIPAL=true -e OCI_REGION=${spec.ndcsOciRegion} -e OCI_COMPARTMENT_ID=${spec.ndcsCompartment})`;
  if (action === "preflight") return `#!/usr/bin/env bash\nset -euo pipefail\ndate -u\nif ! sudo -n podman --version >/dev/null 2>&1; then echo "Runner prerequisite failed: the ocarun user requires passwordless access to Podman for the benchmark commands. Apply the documented sudoers policy or replace this runner." >&2; exit 20; fi\ntest -d /opt/kvs-dashboard\nsudo -n podman image exists ${shellQuote(spec.image)}\n${target === "adb" ? adbCredentialGuard(spec) : ""}\n`;
  const isRun = action.startsWith("run/"), isPreload = action === "preload", distributed = isRun || isPreload;
  const preloadRate = spec.preloadRate / runnerContext.count, preloadMaxInflight = Math.max(1, Math.ceil(spec.preloadMaxInflight / runnerContext.count));
  const command = isRun ? `run --start-at=${startAt} --shard-count=${runnerContext.count} --shard-index=${runnerContext.index}` : action === "doctor" ? "doctor --clock-evidence=results/clock.txt" : isPreload ? `preload --rate=${preloadRate} --max-inflight=${preloadMaxInflight} --shard-count=${runnerContext.count} --shard-index=${runnerContext.index}${startAt ? ` --start-at=${startAt}` : ""} --max-write-attempts=${spec.preloadMaxAttempts ?? 5} --retry-delay-ms=${spec.preloadRetryDelayMs ?? 250}` : `${action} --rate=20 --max-inflight=16`;
  const outputArgument = action === "doctor" ? "results/doctor.json" : "results";
  const invocation = `sudo podman run --rm --network host "${'${envargs[@]}'}" -v "$root:/app/results:z" "$image" ${command} --config=configs/${session.configFile} ${runtimeArguments(spec, session, { workload: isRun })} --target=${target} --table=${shellQuote(table)} --output=${outputArgument}`;
  const liveInvocation = `${liveMonitor("$root", localShardScheduled(session.scheduledOperationsPerTarget, runnerContext.index, runnerContext.count))}${invocation} &\nbenchmark_pid=$!\nwhile kill -0 "$benchmark_pid" 2>/dev/null; do write_progress; sleep 1; done\nset +e\nwait "$benchmark_pid"\ncode=$?\nset -e\nwrite_progress\nexit "$code"`;
  const guardedInvocation = action === "doctor" ? `set +e\n${invocation}\ncode=$?\nset -e\nif [ "$code" -ne 0 ] && [ "$code" -ne 2 ]; then exit "$code"; fi` : isRun ? liveInvocation : isPreload ? `set +e\n${invocation}\ncode=$?\nset -e` : invocation;
  const prefix = `results/${spec.runId}/${action}/${target}${distributed ? sourceRemote(spec, target, runnerContext.index) : ""}`;
  const sync = `sudo podman run --rm --network host -e OCI_REGION=${shellQuote(region)} -v "$root:/app/results:z" --entrypoint node "$image" src/cloud/oci-evidence.mjs --directory=/app/results --bucket=${shellQuote(bucket)} --prefix=${shellQuote(prefix)}`;
  if (isRun) return `#!/usr/bin/env bash\nset -euo pipefail\n${env}\nroot=${shellQuote(output)}\nimage=${shellQuote(spec.image)}\nsudo mkdir -p "$root" && sudo chmod 0777 "$root"\nsudo podman image exists "$image"\nsudo chronyc tracking > "$root/clock.txt"\n${sync} --marker=/app/results/.benchmark-complete --interval-ms=2000 &\nuploader_pid=$!\nset +e\n(\n${guardedInvocation}\n)\ncode=$?\nset -e\ntouch "$root/.benchmark-complete"\nset +e\nwait "$uploader_pid"\nupload_code=$?\nset -e\nif [ "$upload_code" -ne 0 ]; then\n  for retry in 1 2 3; do\n    if ${sync}; then upload_code=0; break; fi\n    sleep $((retry * 5))\n  done\nfi\nif [ "$upload_code" -ne 0 ]; then exit "$upload_code"; fi\nexit "$code"\n`;
  return `#!/usr/bin/env bash\nset -euo pipefail\n${env}\nroot=${shellQuote(output)}\nimage=${shellQuote(spec.image)}\nsudo mkdir -p "$root" && sudo chmod 0777 "$root"\nsudo podman image exists "$image"\nsudo chronyc tracking > "$root/clock.txt"\n${guardedInvocation}\n${sync}\n${isPreload ? 'exit "$code"' : ""}\n`;
}

function awsCommands(spec, action, output, startAt, session = spec.matrix[0], runnerContext = { index: 0, count: 1 }) {
  if (action === "preflight") return [
    "set -eu",
    "podman --version",
    "test -d /opt/kvs-dashboard",
    `podman image exists ${spec.image}`,
    `/usr/local/bin/aws dynamodb describe-table --region ${spec.awsRegion} --table-name ${spec.awsTable} >/dev/null || { echo "AWS runner cannot reach ${spec.awsTable}; verify its instance-role and DynamoDB VPC endpoint policies include this table ARN" >&2; exit 21; }`,
    `printf '%s\n' "ready $(date -u +%FT%TZ) $(hostname)" | /usr/local/bin/aws s3 cp - s3://${spec.bucket}/results/${spec.runId}/preflight/aws${sourceRemote(spec, "aws", runnerContext.index)}/ready.txt --region ${spec.awsRegion} --only-show-errors || { echo "AWS runner cannot publish evidence under the permitted results/ prefix" >&2; exit 22; }`,
  ];
  const isRun = action.startsWith("run/"), isPreload = action === "preload", distributed = isRun || isPreload;
  const preloadRate = spec.preloadRate / runnerContext.count, preloadMaxInflight = Math.max(1, Math.ceil(spec.preloadMaxInflight / runnerContext.count));
  const command = isRun ? `run --start-at=${startAt} --shard-count=${runnerContext.count} --shard-index=${runnerContext.index}` : isPreload ? `preload --rate=${preloadRate} --max-inflight=${preloadMaxInflight} --shard-count=${runnerContext.count} --shard-index=${runnerContext.index}${startAt ? ` --start-at=${startAt}` : ""} --max-write-attempts=${spec.preloadMaxAttempts ?? 5} --retry-delay-ms=${spec.preloadRetryDelayMs ?? 250}` : `${action} --rate=20 --max-inflight=16`;
  const prefix = `results/${spec.runId}/${action}/aws${distributed ? sourceRemote(spec, "aws", runnerContext.index) : ""}`;
  const invocation = `podman run --rm --network host -e AWS_REGION=${spec.awsRegion} -v $root:/app/results:Z $image ${command} --config=configs/${session.configFile} ${runtimeArguments(spec, session, { workload: isRun })} --target=aws --table=${spec.awsTable} --output=results`;
  const runCommand = isRun ? `${liveMonitor("$root", localShardScheduled(session.scheduledOperationsPerTarget, runnerContext.index, runnerContext.count), `/usr/local/bin/aws s3 cp "$root/progress.json" s3://${spec.bucket}/${prefix}/progress.json --only-show-errors || true`)}${invocation} & benchmark_pid=$!; while kill -0 "$benchmark_pid" 2>/dev/null; do write_progress; sleep 1; done; set +e; wait "$benchmark_pid"; code=$?; set -e; write_progress; if [ "$code" -ne 0 ]; then exit "$code"; fi` : isPreload ? `set +e; ${invocation}; code=$?; set -e` : invocation;
  return ["set -eu", `root=${output}`, `image=${spec.image}`, "mkdir -p $root && chmod 0777 $root", "podman image exists $image", "chronyc tracking > $root/clock.txt", runCommand, `/usr/local/bin/aws s3 cp $root s3://${spec.bucket}/${prefix} --recursive --only-show-errors`, ...(isPreload ? ['exit "$code"'] : [])];
}

export class CliCloudAdapter {
  constructor({ execute = run, collectionRetryMs = 1000 } = {}) { this.execute = execute; this.collectionRetryMs = collectionRetryMs; this.activeCommands = new Map(); }
  commandKey(spec, target, source = "source-01") { return `${spec.runId}:${target}:${source}`; }
  commandEvent(spec, target, event, detail = {}) {
    const control = path.join(spec.localOutput, "control"); fs.mkdirSync(control, { recursive: true });
    fs.appendFileSync(path.join(control, "command-journal.ndjson"), `${JSON.stringify({ at: new Date().toISOString(), target, event, ...detail })}\n`);
  }
  track(spec, target, command) { this.activeCommands.set(this.commandKey(spec, target, command.source), command); this.commandEvent(spec, target, "created", command); }
  untrack(spec, target, source = "source-01") { const command = this.activeCommands.get(this.commandKey(spec, target, source)); if (command) this.commandEvent(spec, target, "controller-finished", command); this.activeCommands.delete(this.commandKey(spec, target, source)); }
  async aws(spec, action, output, startAt, session, runner = targetRunners(spec, "aws")[0], index = 0, count = targetRunners(spec, "aws").length || 1) {
    const control = path.join(spec.localOutput, "control"); fs.mkdirSync(control, { recursive: true });
    const source = sourceKey(index), file = path.join(control, `aws-${source}-${action.replaceAll("/", "-")}.json`); fs.writeFileSync(file, `${JSON.stringify({ commands: awsCommands(spec, action, output, startAt, session, { index, count }) })}\n`);
    const commandId = (await this.execute("aws", ["ssm", "send-command", "--profile", spec.awsProfile, "--region", spec.awsRegion, "--instance-ids", runner.id, "--document-name", "AWS-RunShellScript", "--comment", `${spec.runId}-${action}-${source}`, "--parameters", `file://${file.replaceAll("\\", "/")}`, "--query", "Command.CommandId", "--output", "text"])).trim();
    this.track(spec, "aws", { provider: "aws", target: "aws", source, instanceId: runner.id, commandId, action });
    const startDelayMs = startAt ? Math.max(0, new Date(startAt).getTime() - Date.now()) : 0;
    const workloadMs = action.startsWith("run/") ? Number(session?.durationSeconds || 0) * 1000 : 0;
    const waitBudgetMs = action === "preflight" ? 10 * 60_000 : startDelayMs + workloadMs + 15 * 60_000;
    const deadline = Date.now() + waitBudgetMs;
    try {
      let consecutivePollFailures = 0;
      while (Date.now() < deadline) {
        let raw;
        try {
          raw = await this.execute("aws", ["ssm", "get-command-invocation", "--profile", spec.awsProfile, "--region", spec.awsRegion, "--command-id", commandId, "--instance-id", runner.id, "--output", "json"], { timeout: 30_000 });
          consecutivePollFailures = 0;
        } catch (error) {
          consecutivePollFailures += 1;
          if (consecutivePollFailures === 1 || consecutivePollFailures % 12 === 0) this.commandEvent(spec, "aws", "polling-degraded", { action, source, commandId, consecutivePollFailures, message: error.message });
          await sleep(Math.min(30_000, 1000 * consecutivePollFailures));
          continue;
        }
        if (consecutivePollFailures) this.commandEvent(spec, "aws", "polling-recovered", { action, source, commandId, consecutivePollFailures });
        const result = JSON.parse(raw); if (["Success", "Failed", "Cancelled", "TimedOut"].includes(result.Status)) { if (result.Status !== "Success") throw new Error(`AWS ${action}: ${result.StandardErrorContent || result.Status}`); return { commandId, stdout: result.StandardOutputContent }; }
        await sleep(2000);
      }
      throw new Error(`AWS ${action} timed out`);
    } finally { this.untrack(spec, "aws", source); }
  }
  async oci(spec, target, action, output, startAt, session, runner = targetRunners(spec, target)[0], index = 0, count = targetRunners(spec, target).length || 1) {
    const control = path.join(spec.localOutput, "control"); fs.mkdirSync(control, { recursive: true });
    const source = sourceKey(index), safeAction = action.replaceAll("/", "-"), script = remoteScript(spec, target, action, output, startAt, session, { index, count });
    const instanceId = runner.id, compartmentId = runner.compartmentId, profile = target === "adb" ? spec.adbOciProfile : spec.ndcsOciProfile, region = target === "adb" ? spec.adbOciRegion : spec.ndcsOciRegion;
    try {
      return await executeOciRunCommand({ executeCommand: this.execute, profile, region, compartmentId, instanceId, script, displayName: `${spec.runId}-${target}-${source}-${safeAction}`, controlDirectory: control, timeoutSeconds: action === "preflight" ? 300 : 3600, deliveryTimeoutSeconds: 900, onCommandCreated: commandId => this.track(spec, target, { provider: "oci", target, source, instanceId, commandId, action }) });
    } finally { this.untrack(spec, target, source); }
  }
  async cancel(spec) {
    const commands = [...this.activeCommands.entries()].filter(([key]) => key.startsWith(`${spec.runId}:`));
    const results = await Promise.allSettled(commands.map(([, command]) => command.provider === "aws"
      ? this.execute("aws", ["ssm", "cancel-command", "--profile", spec.awsProfile, "--region", spec.awsRegion, "--command-id", command.commandId, "--instance-ids", command.instanceId])
      : this.execute("oci", ["instance-agent", "command", "cancel", "--profile", command.target === "adb" ? spec.adbOciProfile : spec.ndcsOciProfile, "--region", command.target === "adb" ? spec.adbOciRegion : spec.ndcsOciRegion, "--command-id", command.commandId, "--force"])));
    return { requested: commands.length, rejected: results.filter(item => item.status === "rejected").length };
  }
  async preflight(spec) {
    const entries = await Promise.all(spec.enabled.map(async target => {
      const runners = targetRunners(spec, target);
      const values = await Promise.all(runners.map((runner, index) => {
        const output = `/opt/kvs-dashboard/${spec.runId}/preflight/${target}${sourceRemote(spec, target, index)}`;
        return target === "aws" ? this.aws(spec, "preflight", output, null, undefined, runner, index, runners.length).then(() => "Online") : this.oci(spec, target, "preflight", output, null, undefined, runner, index, runners.length).then(value => value.stdout.trim());
      }));
      return [target, values];
    }));
    return Object.fromEntries(entries);
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
    const workload = action.startsWith("run/"), distributed = workload || action === "preload";
    const tasks = spec.enabled.flatMap(target => {
      const runners = targetRunners(spec, target), selected = distributed ? runners : runners.slice(0, 1);
      return selected.map((runner, index) => {
        const output = `${base}/${target}${distributed ? sourceRemote(spec, target, index) : ""}`;
        return target === "aws" ? this.aws(spec, action, output, startAt, session, runner, index, runners.length) : this.oci(spec, target, action, output, startAt, session, runner, index, runners.length);
      });
    });
    return Promise.all(tasks);
  }
  async collect(spec, action) {
    const local = path.join(spec.localOutput, "evidence", action); fs.mkdirSync(local, { recursive: true });
    await Promise.all(spec.enabled.map(target => this.collectWithRecovery(spec, action, target)));
    return local;
  }
  missingEvidence(spec, action, target) {
    if (!action.startsWith("run/") && action !== "preload") return [];
    const destination = path.join(spec.localOutput, "evidence", action, target);
    const required = action === "preload" ? finalPreloadEvidence : finalWorkloadEvidence;
    return evidenceSources(spec, action, target).flatMap(source => required
      .filter(name => !fs.existsSync(path.join(destination, source.relative, name)) || fs.statSync(path.join(destination, source.relative, name)).size === 0)
      .map(name => ({ source: source.key, index: source.index, name })));
  }
  async collectWithRecovery(spec, action, target) {
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.collectTarget(spec, action, target);
        const missing = this.missingEvidence(spec, action, target);
        if (missing.length) throw new Error(`Incomplete ${target} evidence for ${action}: ${missing.map(item => `${item.source}/${item.name}`).join(", ")}`);
        if (targetRunners(spec, target).length > 1) {
          if (action === "preload") await aggregatePreloadEvidence(spec, target);
          else if (action.startsWith("run/")) await aggregateTargetEvidence(spec, action, target);
        }
        if (attempt > 1) this.commandEvent(spec, target, "evidence-collection-recovered", { action, attempt });
        return;
      } catch (error) {
        lastError = error;
        this.commandEvent(spec, target, "evidence-collection-degraded", { action, attempt, message: error.message });
        if (attempt < 2) await sleep(this.collectionRetryMs * attempt);
      }
    }
    if (!action.startsWith("run/") || !new Set(["adb", "ndcs"]).has(target)) throw lastError;
    this.commandEvent(spec, target, "evidence-republish-started", { action, reason: lastError.message });
    const missingSources = [...new Set(this.missingEvidence(spec, action, target).map(item => item.index))];
    for (const index of missingSources) await this.republishTargetEvidence(spec, action, target, index);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.collectTarget(spec, action, target);
        const missing = this.missingEvidence(spec, action, target);
        if (missing.length) throw new Error(`Incomplete ${target} evidence after republish for ${action}: ${missing.map(item => `${item.source}/${item.name}`).join(", ")}`);
        if (targetRunners(spec, target).length > 1) {
          if (action === "preload") await aggregatePreloadEvidence(spec, target);
          else if (action.startsWith("run/")) await aggregateTargetEvidence(spec, action, target);
        }
        this.commandEvent(spec, target, "evidence-republish-recovered", { action, attempt });
        return;
      } catch (error) {
        lastError = error;
        this.commandEvent(spec, target, "evidence-republish-pending", { action, attempt, message: error.message });
        if (attempt < 3) await sleep(this.collectionRetryMs * attempt);
      }
    }
    throw lastError;
  }
  async republishTargetEvidence(spec, action, target, index = 0) {
    const sessionId = action.slice("run/".length);
    if (!spec.matrix.some(item => item.id === sessionId)) throw new Error(`Evidence recovery refused for unknown session ${sessionId}`);
    const profile = target === "adb" ? spec.adbOciProfile : spec.ndcsOciProfile;
    const region = target === "adb" ? spec.adbOciRegion : spec.ndcsOciRegion;
    const runners = targetRunners(spec, target), runner = runners[index];
    if (!runner) throw new Error(`Evidence recovery refused for unknown ${target} runner index ${index}`);
    const compartmentId = runner.compartmentId;
    const instanceId = runner.id;
    const bucket = target === "adb" ? spec.adbBucket : spec.ndcsBucket;
    const source = sourceKey(index), root = `/opt/kvs-dashboard/${spec.runId}/${action}/${target}${sourceRemote(spec, target, index)}`, prefix = `results/${spec.runId}/${action}/${target}${sourceRemote(spec, target, index)}`;
    const checks = finalWorkloadEvidence.map(name => `test -s "$root/${name}"`).join("\n");
    const script = `#!/usr/bin/env bash\nset -euo pipefail\nroot=${shellQuote(root)}\nimage=${shellQuote(spec.image)}\n${checks}\nsudo -n podman run --rm --network host -e OCI_REGION=${shellQuote(region)} -v "$root:/app/results:z" --entrypoint node "$image" src/cloud/oci-evidence.mjs --directory=/app/results --bucket=${shellQuote(bucket)} --prefix=${shellQuote(prefix)}\necho EVIDENCE_REPUBLISHED\n`;
    const control = path.join(spec.localOutput, "control");
    try {
      return await executeOciRunCommand({ executeCommand: this.execute, profile, region, compartmentId, instanceId, script, displayName: `${spec.runId}-${target}-${source}-republish-${sessionId}`, controlDirectory: control, timeoutSeconds: 1800, deliveryTimeoutSeconds: 900, onCommandCreated: commandId => this.track(spec, target, { provider: "oci", target, source, instanceId, commandId, action: `republish/${sessionId}` }) });
    } finally { this.untrack(spec, target, source); }
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
  async collectRunnerMetrics(spec, session, summaries) {
    const entries = await Promise.all(spec.enabled.map(async target => {
      try {
        const summary = summaries[target], startAt = summary.scheduledStartAt || summary.actualStartAt, endAt = summary.scheduledEndAt || summary.actualEndAt;
        const runners = targetRunners(spec, target);
        const collected = await Promise.allSettled(runners.map(runner => target === "aws" ? this.awsRunnerMetrics(spec, startAt, endAt, runner) : this.ociRunnerMetrics(spec, target, startAt, endAt, runner)));
        const reports = collected.map((value, index) => value.status === "fulfilled" ? value.value : { schemaVersion: 1, target, available: false, resourceId: runners[index].id, runner: runners[index], region: target === "aws" ? spec.awsRegion : target === "adb" ? spec.adbOciRegion : spec.ndcsOciRegion, startAt, endAt, metrics: {}, unavailable: ["all"], error: value.reason?.message || String(value.reason) });
        const report = aggregateRunnerMetricReports(target, reports);
        const directory = path.join(spec.localOutput, "evidence", "run", session.id, target); fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, "runner-metrics.json"), `${JSON.stringify(report, null, 2)}\n`);
        if (reports.length > 1) reports.forEach((sourceReport, index) => fs.writeFileSync(path.join(directory, sourceRelative(spec, target, index), "runner-metrics.json"), `${JSON.stringify(sourceReport, null, 2)}\n`));
        this.commandEvent(spec, target, "runner-metrics-collected", { action: `run/${session.id}`, source: report.source });
        return [target, report];
      } catch (error) {
        this.commandEvent(spec, target, "runner-metrics-unavailable", { action: `run/${session.id}`, message: error.message });
        return [target, { schemaVersion: 1, target, available: false, error: error.message }];
      }
    }));
    return Object.fromEntries(entries);
  }
  async awsRunnerMetrics(spec, startAt, endAt, runner = targetRunners(spec, "aws")[0]) {
    const metric = (id, metricName, stat) => ({ Id: id, MetricStat: { Metric: { Namespace: "AWS/EC2", MetricName: metricName, Dimensions: [{ Name: "InstanceId", Value: runner.id }] }, Period: 60, Stat: stat }, ReturnData: true });
    const queries = [metric("cpu_average", "CPUUtilization", "Average"), metric("cpu_maximum", "CPUUtilization", "Maximum"), metric("network_in", "NetworkIn", "Sum"), metric("network_out", "NetworkOut", "Sum"), metric("status_failed", "StatusCheckFailed", "Maximum")];
    const raw = JSON.parse(await this.execute("aws", ["cloudwatch", "get-metric-data", "--profile", spec.awsProfile, "--region", spec.awsRegion, "--start-time", startAt, "--end-time", endAt, "--scan-by", "TimestampAscending", "--metric-data-queries", JSON.stringify(queries), "--output", "json"]));
    const byId = Object.fromEntries((raw.MetricDataResults || []).map(item => [item.Id, sortedMetricPoints((item.Timestamps || []).map((timestamp, index) => ({ timestamp, value: item.Values?.[index] })))]));
    const perSecond = points => points.map(point => ({ ...point, value: point.value / 60 }));
    return { schemaVersion: 1, target: "aws", available: true, source: "AWS/EC2", resourceId: runner.id, runner, region: spec.awsRegion, startAt, endAt, periodSeconds: 60, metrics: { cpuUtilizationPercent: byId.cpu_average || [], cpuMaximumPercent: byId.cpu_maximum || [], memoryUtilizationPercent: [], loadAverage1m: [], networkReceiveBytesPerSecond: perSecond(byId.network_in || []), networkTransmitBytesPerSecond: perSecond(byId.network_out || []), statusCheckFailed: byId.status_failed || [] }, unavailable: ["memoryUtilizationPercent", "loadAverage1m"] };
  }
  async ociRunnerMetrics(spec, target, startAt, endAt, runner = targetRunners(spec, target)[0]) {
    const profile = target === "adb" ? spec.adbOciProfile : spec.ndcsOciProfile, region = target === "adb" ? spec.adbOciRegion : spec.ndcsOciRegion, compartmentId = runner.compartmentId, resourceId = runner.id;
    const definitions = [["cpuUtilizationPercent", "CpuUtilization", "mean"], ["memoryUtilizationPercent", "MemoryUtilization", "mean"], ["loadAverage1m", "LoadAverage", "mean"], ["networkReceiveCounter", "NetworksBytesIn", "mean"], ["networkTransmitCounter", "NetworksBytesOut", "mean"]];
    const values = await Promise.all(definitions.map(async ([key, name, statistic]) => {
      const raw = JSON.parse(await this.execute("oci", ["monitoring", "metric-data", "summarize-metrics-data", "--profile", profile, "--region", region, "--compartment-id", compartmentId, "--namespace", "oci_computeagent", "--start-time", startAt, "--end-time", endAt, "--query-text", `${name}[1m]{resourceId = "${resourceId}"}.${statistic}()`, "--output", "json"]));
      return [key, sortedMetricPoints((raw.data || []).flatMap(item => item["aggregated-datapoints"] || []))];
    }));
    const metrics = Object.fromEntries(values);
    metrics.networkReceiveBytesPerSecond = counterRates(metrics.networkReceiveCounter); metrics.networkTransmitBytesPerSecond = counterRates(metrics.networkTransmitCounter);
    delete metrics.networkReceiveCounter; delete metrics.networkTransmitCounter;
    return { schemaVersion: 1, target, available: true, source: "oci_computeagent", resourceId, runner, region, startAt, endAt, periodSeconds: 60, metrics, unavailable: [] };
  }
  async progress(spec, target, action, runner = targetRunners(spec, target)[0], index = 0) {
    try {
      const suffix = sourceRemote(spec, target, index);
      if (target === "aws") {
        const raw = await this.execute("aws", ["s3", "cp", `s3://${spec.bucket}/results/${spec.runId}/${action}/aws${suffix}/progress.json`, "-", "--only-show-errors", "--profile", spec.awsProfile, "--region", spec.awsRegion], { timeout: 15_000 });
        return JSON.parse(raw);
      }
      const bucket = target === "adb" ? spec.adbBucket : spec.ndcsBucket, profile = target === "adb" ? spec.adbOciProfile : spec.ndcsOciProfile, region = target === "adb" ? spec.adbOciRegion : spec.ndcsOciRegion;
      const raw = await this.execute("oci", ["os", "object", "get", "--profile", profile, "--region", region, "--bucket-name", bucket, "--name", `results/${spec.runId}/${action}/${target}${suffix}/progress.json`, "--file", "-"] , { timeout: 15_000 });
      return JSON.parse(raw);
    } catch { return null; }
  }
  async progressAll(spec, action) {
    const entries = await Promise.all(spec.enabled.map(async target => {
      const runners = targetRunners(spec, target);
      const values = await Promise.all(runners.map(async (runner, index) => ({ source: sourceKey(index), value: await this.progress(spec, target, action, runner, index) })));
      const available = values.filter(source => source.value);
      return [target, available.length ? aggregateProgressSources(available) : null];
    }));
    return Object.fromEntries(entries.filter(([, value]) => value));
  }
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
async function mergeLineFiles(inputs, output, onLine = null) {
  const temporary = `${output}.tmp-${process.pid}`;
  const stream = fs.createWriteStream(temporary, { encoding: "utf8" });
  try {
    for (const input of inputs) {
      const lines = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        if (!stream.write(`${line}\n`)) await new Promise(resolve => stream.once("drain", resolve));
        if (onLine) onLine(line);
      }
    }
    await new Promise((resolve, reject) => { stream.once("error", reject); stream.end(resolve); });
    fs.renameSync(temporary, output);
  } catch (error) {
    stream.destroy();
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
    throw error;
  }
}
function sumBy(values, read) { return values.reduce((sum, value) => sum + Number(read(value) || 0), 0); }
function extremaIso(values, mode) {
  const dates = values.filter(Boolean).map(value => new Date(value)).filter(value => Number.isFinite(value.getTime()));
  if (!dates.length) return null;
  const epoch = mode === "min" ? Math.min(...dates.map(value => value.getTime())) : Math.max(...dates.map(value => value.getTime()));
  return new Date(epoch).toISOString();
}
async function aggregatePreloadEvidence(spec, target) {
  const action = "preload", directory = path.join(spec.localOutput, "evidence", action, target), sources = evidenceSources(spec, action, target);
  if (sources.length <= 1) return null;
  const sourceDirectories = sources.map(source => path.join(directory, source.relative));
  const summaries = sourceDirectories.map(source => readJson(path.join(source, "preload-summary.json")));
  if (new Set(summaries.map(value => value.configSha256)).size !== 1) throw new Error(`${target} preload generators used different configuration hashes`);
  if (new Set(summaries.map(value => value.scheduledStartAt)).size !== 1) throw new Error(`${target} preload generators used different T0 values`);
  const shardCounts = new Set(summaries.map(value => Number(value.shard?.count)));
  const shardIndexes = new Set(summaries.map(value => Number(value.shard?.index)));
  if (shardCounts.size !== 1 || !shardCounts.has(sources.length) || shardIndexes.size !== sources.length) throw new Error(`${target} preload shard evidence is incomplete or inconsistent`);
  const successfulLatency = [], observedIndexes = new Set();
  await mergeLineFiles(sourceDirectories.map(source => path.join(source, "preload-operations.ndjson")), path.join(directory, "preload-operations.ndjson"), line => {
    const operation = JSON.parse(line), index = Number(operation.index), latency = Number(operation.latencyMs);
    if (!Number.isInteger(index) || observedIndexes.has(index)) throw new Error(`${target} preload contains a missing or duplicate logical index`);
    observedIndexes.add(index);
    if (operation.error == null && Number.isFinite(latency)) successfulLatency.push(latency);
  });
  const errors = {};
  for (const summary of summaries) for (const [name, count] of Object.entries(summary.errors || {})) errors[name] = (errors[name] || 0) + Number(count || 0);
  const requested = sumBy(summaries, value => value.requested), completed = sumBy(summaries, value => value.completed), failures = sumBy(summaries, value => value.failures);
  const actualStartAt = extremaIso(summaries.map(value => value.actualStartAt || value.startedAt), "min"), endedAt = extremaIso(summaries.map(value => value.endedAt), "max");
  const durationMs = actualStartAt && endedAt ? Date.parse(endedAt) - Date.parse(actualStartAt) : Math.max(...summaries.map(value => Number(value.durationMs || 0)));
  const durationSeconds = durationMs / 1000, first = summaries[0], logicalRequested = Number(first.logicalRequested ?? first.dataset?.keyCount ?? requested);
  const sourceViews = sources.map((source, index) => ({ source: source.key, runner: source.runner, shard: summaries[index].shard, requested: summaries[index].requested, completed: summaries[index].completed, failures: summaries[index].failures, requestedOperationsPerSecond: summaries[index].requestedOperationsPerSecond, successfulOperationsPerSecond: summaries[index].successfulOperationsPerSecond, startSkewMs: summaries[index].startSkewMs }));
  const summary = {
    ...first,
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    actualStartAt,
    startedAt: actualStartAt,
    endedAt,
    durationMs,
    durationSeconds,
    startSkewMs: Math.max(...summaries.map(value => Math.abs(Number(value.startSkewMs || 0)))),
    requested,
    logicalRequested,
    completed,
    failures,
    requestedOperationsPerSecond: sumBy(summaries, value => value.requestedOperationsPerSecond),
    attemptedOperationsPerSecond: durationSeconds > 0 ? requested / durationSeconds : null,
    successfulOperationsPerSecond: durationSeconds > 0 ? completed / durationSeconds : null,
    rate: sumBy(summaries, value => value.rate),
    maxInflight: sumBy(summaries, value => value.maxInflight),
    latencyMs: distribution(successfulLatency),
    attempts: sumBy(summaries, value => value.attempts),
    retryCount: sumBy(summaries, value => value.retryCount),
    writeUnits: sumBy(summaries, value => value.writeUnits),
    errors,
    shard: null,
    loadGenerators: { count: sources.length, sources: sourceViews },
  };
  summary.passed = summaries.every(value => value.passed === true) && failures === 0 && requested === logicalRequested && observedIndexes.size === logicalRequested;
  fs.writeFileSync(path.join(directory, "preload-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(directory, "clock.txt"), sources.map((source, index) => `[${source.key} ${source.runner.id}]\n${fs.readFileSync(path.join(sourceDirectories[index], "clock.txt"), "utf8").trim()}\n`).join("\n"));
  return summary;
}
async function aggregateTargetEvidence(spec, action, target) {
  const directory = path.join(spec.localOutput, "evidence", action, target), sources = evidenceSources(spec, action, target);
  if (sources.length <= 1) return null;
  const sourceDirectories = sources.map(source => path.join(directory, source.relative));
  const summaries = sourceDirectories.map(source => readJson(path.join(source, "summary.json")));
  if (new Set(summaries.map(value => value.configSha256)).size !== 1) throw new Error(`${target} load generators used different configuration hashes`);
  if (new Set(summaries.map(value => value.scheduledStartAt)).size !== 1) throw new Error(`${target} load generators used different T0 values`);
  const successfulService = [], successfulIntended = [], failedService = [], queueDelays = [], concurrency = [];
  await mergeLineFiles(sourceDirectories.map(source => path.join(source, "operations.ndjson")), path.join(directory, "operations.ndjson"), line => {
    const operation = JSON.parse(line), service = Number(operation.serviceLatencyMs), intended = Number(operation.intendedLatencyMs), queue = Number(operation.queueDelayMs), inFlight = Number(operation.inFlightAtStart);
    if (Number.isFinite(queue)) queueDelays.push(queue);
    if (Number.isFinite(inFlight)) concurrency.push(inFlight);
    if (operation.error == null) { if (Number.isFinite(service)) successfulService.push(service); if (Number.isFinite(intended)) successfulIntended.push(intended); }
    else if (Number.isFinite(service)) failedService.push(service);
  });
  await mergeLineFiles(sourceDirectories.map(source => path.join(source, "telemetry.ndjson")), path.join(directory, "telemetry.ndjson"));
  const errors = {};
  for (const summary of summaries) for (const [name, count] of Object.entries(summary.errors || {})) errors[name] = (errors[name] || 0) + Number(count || 0);
  const actualStartAt = extremaIso(summaries.map(value => value.actualStartAt), "min"), actualEndAt = extremaIso(summaries.map(value => value.actualEndAt), "max"), actualDurationMs = actualStartAt && actualEndAt ? Date.parse(actualEndAt) - Date.parse(actualStartAt) : Math.max(...summaries.map(value => Number(value.actualDurationMs || 0)));
  const completed = sumBy(summaries, value => value.completed), failed = sumBy(summaries, value => value.failed), scheduled = sumBy(summaries, value => value.scheduled), schedulerDrops = sumBy(summaries, value => value.schedulerDrops), accounted = sumBy(summaries, value => value.accounted);
  const sourceViews = sources.map((source, index) => ({ source: source.key, runner: source.runner, shard: summaries[index].shard || { count: sources.length, index }, scheduled: summaries[index].scheduled, completed: summaries[index].completed, failed: summaries[index].failed, achievedOperationsPerSecond: summaries[index].achievedOperationsPerSecond, startSkewMs: summaries[index].startSkewMs }));
  const first = summaries[0], configuredMaxInflight = sumBy(summaries, value => value.concurrency?.configuredMaxInflight), peakInflight = sumBy(summaries, value => value.concurrency?.observedAtOperationStart?.max);
  const summary = {
    ...first,
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    actualStartAt,
    actualEndAt,
    actualDurationMs,
    startSkewMs: Math.max(...summaries.map(value => Math.abs(Number(value.startSkewMs || 0)))),
    scheduled,
    logicalScheduled: Number(first.logicalScheduled ?? scheduled),
    attempted: sumBy(summaries, value => value.attempted),
    completed,
    failed,
    accounted,
    completionRate: scheduled ? completed / scheduled : 0,
    serviceSuccessRate: scheduled ? completed / scheduled : 0,
    achievedOperationsPerSecond: actualDurationMs > 0 ? completed / (actualDurationMs / 1000) : 0,
    errors,
    schedulerDrops,
    retries: sumBy(summaries, value => value.retries),
    successfulServiceLatencyMs: distribution(successfulService),
    successfulIntendedLatencyMs: distribution(successfulIntended),
    failedServiceLatencyMs: distribution(failedService),
    queueDelayMs: distribution(queueDelays),
    concurrency: { ...(first.concurrency || {}), configuredMaxInflight, effectiveMaxInflight: configuredMaxInflight, observedAtOperationStart: { ...distribution(concurrency), max: peakInflight }, aggregation: "per-source samples; peak is the sum of source peaks" },
    client: { loadGenerators: sourceViews.map((source, index) => ({ source: source.source, runner: source.runner, client: summaries[index].client || null })) },
    consumedCapacity: { readUnits: sumBy(summaries, value => value.consumedCapacity?.readUnits), writeUnits: sumBy(summaries, value => value.consumedCapacity?.writeUnits) },
    loadGenerators: { count: sources.length, sourceIpModel: "provider network identity; egress identity is not inferred", sources: sourceViews },
  };
  summary.harnessPassed = summaries.every(value => value.harnessPassed) && accounted === scheduled && schedulerDrops === 0;
  summary.passed = summary.harnessPassed;
  fs.writeFileSync(path.join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  const firstConfig = readJson(path.join(sourceDirectories[0], "run-config.json"));
  fs.writeFileSync(path.join(directory, "run-config.json"), `${JSON.stringify({ ...firstConfig, shard: null, loadGenerators: { count: sources.length, sources: sourceViews.map(value => ({ source: value.source, runner: value.runner, shard: value.shard })) } }, null, 2)}\n`);
  fs.writeFileSync(path.join(directory, "clock.txt"), sources.map((source, index) => `[${source.key} ${source.runner.id}]\n${fs.readFileSync(path.join(sourceDirectories[index], "clock.txt"), "utf8").trim()}\n`).join("\n"));
  return summary;
}
function allFiles(directory) { return fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter(item => item.isFile()).map(item => path.join(item.parentPath || item.path, item.name)); }
async function workloadStageSummaries(state, session) {
  const pairs = await Promise.all(state.spec.enabled.map(async target => {
    const directory = path.join(state.output, "evidence", "run", session.id, target);
    return [target, fs.existsSync(path.join(directory, "operations.ndjson")) ? await writeWorkloadStageSummary(directory, session.loadSchedule || []) : null];
  }));
  return Object.fromEntries(pairs.filter(([, summary]) => summary));
}
async function packageRun(state) {
  const preloadRows = Object.entries(state.preloadSummaries || {}).map(([target, value]) => `<tr><td>${target.toUpperCase()}</td><td>${value.actualStartAt}</td><td>${value.startSkewMs ?? "-"}</td><td>${value.completed}/${value.requested}</td><td>${value.failures}</td><td>${value.successfulOperationsPerSecond ?? "-"}</td><td>${value.latencyMs?.p95 ?? "-"}</td><td>${value.latencyMs?.p99 ?? "-"}</td><td>${value.writeUnits ?? "-"}</td></tr>`).join("");
  const preloadSection = preloadRows ? `<h2>Canonical preload performance</h2><table><thead><tr><th>Target</th><th>Actual start UTC</th><th>Start skew ms</th><th>Completed</th><th>Failures</th><th>Successful ops/s</th><th>P95 ms</th><th>P99 ms</th><th>Write units</th></tr></thead><tbody>${preloadRows}</tbody></table>` : "";
  const rows = state.sessionResults.flatMap(session => { const matrix = state.spec.matrix.find(item => item.id === session.id) || {}; return Object.entries(session.summaries).map(([target, value]) => `<tr><td>${session.id}</td><td>${target.toUpperCase()}</td><td>${value.actualStartAt}</td><td>${value.startSkewMs}</td><td>${value.completed}/${value.scheduled}</td><td>${matrix.payloadBytes ?? value.dataset?.payloadBytes ?? "-"} B payload / ${matrix.logicalItemBytes ?? value.dataset?.logicalItemBytes ?? "-"} B logical max</td><td>${value.successfulServiceLatencyMs?.p95 ?? "-"}</td><td>${value.successfulServiceLatencyMs?.p99 ?? "-"}</td><td>${value.successfulServiceLatencyMs?.max ?? "-"}</td></tr>`); }).join("");
  const certificate = Object.values(state.certificates)[0];
  const inventory = JSON.stringify(state.resourceInventory || {}, null, 2).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>KVS cloud benchmark</title><style>body{max-width:1100px;margin:40px auto;font:15px system-ui;color:#172033}table{width:100%;border-collapse:collapse}th,td{padding:9px;border-bottom:1px solid #ddd;text-align:left}.ok{color:#087a55}pre{padding:14px;background:#f3f5f7;border-radius:8px;overflow:auto}</style><h1>KVS cloud benchmark</h1><p class="ok"><b>COMPLETE</b> — ${state.sessionResults.length} synchronized matrix session(s) across ${state.spec.enabled.map(value => value.toUpperCase()).join(", ")} using ${state.spec.loadGeneratorCount || 1} load generator(s) per target.</p><p>Dataset SHA-256: <code>${certificate.observedSha256}</code>. Item size is reported as configured payload bytes and the provider-neutral largest logical JSON record; provider billing size can differ.</p><h2>Benchmark resource inventory</h2><pre>${inventory}</pre><table><thead><tr><th>Session</th><th>Target</th><th>Actual start UTC</th><th>Start skew ms</th><th>Completed</th><th>Item size</th><th>P95 ms</th><th>P99 ms</th><th>Max ms</th></tr></thead><tbody>${rows}</tbody></table><h2>Evidence</h2><p>The ZIP contains preload records, strong-read dataset certificates, operation-level NDJSON, telemetry, summaries, clock evidence, stage events, resource IDs, per-load-generator evidence, and SHA-256 manifest.</p></html>`;
  fs.writeFileSync(path.join(state.output, "index.html"), html.replace("<table><thead><tr><th>Session</th>", `${preloadSection}<h2>Workload sessions</h2><table><thead><tr><th>Session</th>`));
  fs.writeFileSync(path.join(state.output, "run-state.json"), `${JSON.stringify(visible(state), null, 2)}\n`);
  fs.writeFileSync(path.join(state.output, "pipeline-log.ndjson"), `${(state.logs || []).map(item => JSON.stringify(item)).join("\n")}\n`);
  const archiveName = `${state.id}-benchmark-output.zip`;
  const files = allFiles(state.output).filter(file => !file.endsWith(".zip") && !file.endsWith("manifest-sha256.json") && !path.basename(file).startsWith(`${archiveName}.tmp-`) && path.basename(file) !== stateFileName);
  const entries = [];
  for (const file of files) {
    const inspected = await inspectFile(file);
    entries.push({ path: path.relative(state.output, file).replaceAll("\\", "/"), sourcePath: file, ...inspected });
  }
  const manifest = { schemaVersion: 1, runId: state.id, generatedAt: new Date().toISOString(), entries: entries.map(item => ({ path: item.path, bytes: item.bytes, sha256: item.sha256 })) };
  const manifestData = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`); fs.writeFileSync(path.join(state.output, "manifest-sha256.json"), manifestData);
  state.archiveFile = path.join(state.output, archiveName);
  await createZipFile(state.archiveFile, [...entries.map(item => ({ name: item.path, sourcePath: item.sourcePath, bytes: item.bytes, crc32: item.crc32 })), { name: "manifest-sha256.json", data: manifestData }]);
}

export class CloudAcceptanceRuns {
  constructor({ outputRoot = defaultOutput, adapter = new CliCloudAdapter() } = {}) {
    this.outputRoot = outputRoot; this.adapter = adapter; this.runs = new Map(); this.ownedRuns = new Set();
    for (const state of readRunStates(outputRoot)) {
      if (state.archiveFile && !fs.existsSync(state.archiveFile)) state.archiveFile = null;
      this.runs.set(state.id, state);
    }
  }
  refreshExternal() { for (const state of readRunStates(this.outputRoot)) if (!this.ownedRuns.has(state.id)) { if (state.archiveFile && !fs.existsSync(state.archiveFile)) state.archiveFile = null; this.runs.set(state.id, state); } }
  persist(state) { state.heartbeatAt = new Date().toISOString(); writeStateAtomic(state.output, state); }
  start(input) {
    this.refreshExternal();
    if ([...this.runs.values()].some(run => ["queued", "running", "stopping"].includes(run.status))) throw new Error("A cloud acceptance run is already active");
    const spec = validate(input), id = `cloud-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`, output = path.join(this.outputRoot, id);
    Object.assign(spec, { runId: id, localOutput: output });
    const state = { id, spec, status: "queued", controlOwnerPid: process.pid, createdAt: new Date().toISOString(), output, outputRelative: path.relative(repositoryRoot, output).replaceAll("\\", "/"), stages: stages.map(stageView), targetStatus: Object.fromEntries(spec.enabled.map(name => [name, "pending"])), targetMetrics: {}, sessionResults: [], logs: [] };
    appendLog(state, { message: `Run queued for ${spec.enabled.map(name => name.toUpperCase()).join(", ")}; ${spec.matrix.length} synchronized session(s); ${spec.loadGeneratorCount || 1} load generator(s) per target` });
    this.runs.set(id, state); this.ownedRuns.add(id); this.persist(state); void this.execute(state); return visible(state);
  }
  get(id) { this.refreshExternal(); const state = this.runs.get(id); if (!state) throw new Error("Cloud run not found"); return visible(state); }
  active() {
    this.refreshExternal();
    const state = [...this.runs.values()].find(run => ["queued", "running", "stopping"].includes(run.status));
    return state ? visible(state) : null;
  }
  latest() {
    this.refreshExternal();
    const state = [...this.runs.values()].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
    return state ? visible(state) : null;
  }
  list() {
    this.refreshExternal();
    return [...this.runs.values()].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))).map(historyVisible);
  }
  download(id) { this.refreshExternal(); const state = this.runs.get(id); if (!state?.archiveFile) throw new Error("Cloud benchmark output is not ready"); return state.archiveFile; }
  async stop(id) {
    this.refreshExternal(); const state = this.runs.get(id); if (!state) throw new Error("Cloud run not found");
    if (terminalStatuses.has(state.status)) return visible(state);
    if (!this.ownedRuns.has(id) || state.controlOwnerPid !== process.pid) throw new Error("This dashboard is attached read-only; stop the run from its owning controller");
    state.stopRequestedAt = new Date().toISOString(); state.status = "stopping"; appendLog(state, { level: "warning", message: "Stop requested; cancelling active remote commands without cleanup" }); this.persist(state);
    const result = typeof this.adapter.cancel === "function" ? await this.adapter.cancel(state.spec) : { requested: 0, rejected: 0 };
    appendLog(state, { level: result.rejected ? "warning" : "info", message: `Remote cancellation requested for ${result.requested} command(s); ${result.rejected} request(s) failed` }); this.persist(state);
    return visible(state);
  }
  resume(id) {
    this.refreshExternal(); const state = this.runs.get(id); if (!state) throw new Error("Cloud run not found");
    const active = [...this.runs.values()].find(run => run.id !== id && ["queued", "running", "stopping"].includes(run.status));
    if (active) throw new Error(`Cloud run ${active.id} is already active`);
    if (!resumable(state)) throw new Error("This run does not have a verified workload checkpoint that can be resumed");
    state.status = "queued"; state.error = null; state.completedAt = null; state.controlOwnerPid = process.pid; state.resumeCount = Number(state.resumeCount || 0) + 1;
    delete state.stopRequestedAt;
    appendLog(state, { level: "warning", message: `Checkpoint resume ${state.resumeCount} accepted; completed prerequisite gates and finalized sessions will be reused` });
    this.ownedRuns.add(id); this.persist(state); void this.execute(state, { resume: true }); return visible(state);
  }
  async step(state, name, task) {
    if (state.stopRequestedAt) throw new Error("Run stopped by operator");
    const stage = state.stages.find(item => item.name === name);
    if (stage.status !== "pending") { stage.attempts ||= []; stage.attempts.push({ status: stage.status, startedAt: stage.startedAt || null, completedAt: stage.completedAt || null, detail: stage.detail || null }); }
    stage.status = "running"; stage.startedAt = new Date().toISOString(); stage.completedAt = null; stage.detail = null;
    appendLog(state, { stage: name, message: "Stage started" }); this.persist(state);
    try { const result = await task(); stage.status = "complete"; stage.completedAt = new Date().toISOString(); stage.detail = typeof result === "string" ? result : result ? JSON.stringify(result).slice(0, 600) : "Passed"; appendLog(state, { level: "success", stage: name, message: stage.detail }); this.persist(state); return result; }
    catch (error) { stage.status = "failed"; stage.completedAt = new Date().toISOString(); stage.detail = error.message; appendLog(state, { level: "error", stage: name, message: error.message }); this.persist(state); throw error; }
  }
  async completePackage(state) {
    const stage = state.stages.find(item => item.name === "package-generation");
    stage.status = "running"; stage.startedAt = new Date().toISOString(); stage.completedAt = null; stage.detail = null;
    appendLog(state, { stage: "package-generation", message: "Stage started" }); this.persist(state);
    const completedAt = new Date().toISOString(), projected = structuredClone(state);
    projected.status = "complete"; projected.completedAt = completedAt;
    projected.archiveFile = path.join(projected.output, `${projected.id}-benchmark-output.zip`);
    const projectedStage = projected.stages.find(item => item.name === "package-generation");
    projectedStage.status = "complete"; projectedStage.completedAt = completedAt; projectedStage.detail = "Benchmark package generated";
    appendLog(projected, { level: "success", stage: "package-generation", message: projectedStage.detail });
    appendLog(projected, { level: "success", message: "Benchmark pipeline completed" });
    try { await packageRun(projected); }
    catch (error) {
      stage.status = "failed"; stage.completedAt = new Date().toISOString(); stage.detail = error.message;
      appendLog(state, { level: "error", stage: "package-generation", message: error.message }); this.persist(state); throw error;
    }
    state.status = projected.status; state.completedAt = projected.completedAt; state.archiveFile = projected.archiveFile; state.stages = projected.stages; state.logs = projected.logs;
    this.persist(state);
  }
  async recoverInterruptedSession(state) {
    const current = state.currentSession;
    if (!current || state.sessionResults.some(item => item.id === current.id)) return;
    const session = state.spec.matrix.find(item => item.id === current.id);
    if (!session) throw new Error(`Interrupted session ${current.id} is not present in the immutable matrix`);
    state.targetStatus = Object.fromEntries(state.spec.enabled.map(name => [name, "collecting"]));
    appendLog(state, { level: "warning", stage: "workload", message: `Collecting final evidence for interrupted session ${current.id} before continuing the matrix` }); this.persist(state);
    await this.adapter.collect(state.spec, `run/${current.id}`);
    const summaries = Object.fromEntries(state.spec.enabled.map(target => [target, readJson(path.join(state.output, "evidence", "run", current.id, target, "summary.json"))]));
    const stageSummaries = await workloadStageSummaries(state, session);
    const values = Object.values(summaries);
    if (values.some(value => Number(value.accounted) !== Number(value.scheduled))) throw new Error(`Interrupted session ${current.id} evidence is not fully accounted`);
    if (new Set(values.map(value => value.configSha256)).size !== 1 || new Set(values.map(value => value.scheduledStartAt)).size !== 1 || values[0]?.scheduledStartAt !== state.sharedStartAt) throw new Error(`Interrupted session ${current.id} evidence does not match its immutable configuration or shared T0`);
    state.summaries = summaries;
    state.targetMetrics = Object.fromEntries(Object.entries(summaries).map(([target, value]) => [target, { completed: value.completed, scheduled: value.scheduled, failed: value.failed, operationsPerSecond: value.achievedOperationsPerSecond, inFlight: 0, observedMaxInFlight: value.concurrency?.observedAtOperationStart?.max ?? null, latestLatencyMs: value.successfulServiceLatencyMs?.max ?? null, p95: value.successfulServiceLatencyMs?.p95 ?? null, p99: value.successfulServiceLatencyMs?.p99 ?? null, max: value.successfulServiceLatencyMs?.max ?? null, provisional: false }]));
    const runnerMetrics = typeof this.adapter.collectRunnerMetrics === "function" ? await this.adapter.collectRunnerMetrics(state.spec, session, summaries) : {};
    state.sessionResults.push({ id: session.id, configFile: session.configFile, repetition: session.repetition, sharedStartAt: state.sharedStartAt, summaries, stageSummaries, runnerMetrics });
    state.targetStatus = Object.fromEntries(state.spec.enabled.map(name => [name, "completed"]));
    for (const [target, summary] of Object.entries(summaries)) appendLog(state, { level: summary.failed ? "error" : "success", stage: "workload", target, message: `Recovered session; ${summary.completed}/${summary.scheduled} operations; ${summary.failed} failed; p95 ${summary.successfulServiceLatencyMs?.p95 ?? "-"} ms` });
    this.persist(state);
  }
  async execute(state, { resume = false } = {}) {
    const spec = state.spec; fs.mkdirSync(state.output, { recursive: true }); state.status = "running";
    if (!resume) { state.startedAt = new Date().toISOString(); appendLog(state, { message: `Pipeline started; evidence path ${state.outputRelative}` }); }
    else appendLog(state, { message: `Pipeline resumed from verified checkpoint; ${state.sessionResults.length} session(s) were already finalized` });
    this.persist(state);
    try {
      if (!resume) {
        await this.step(state, "runner-readiness", () => this.adapter.preflight(spec));
        await this.step(state, "resource-validation", async () => { const observed = await this.adapter.validateResources(spec); state.resourceInventory = resourceInventory(spec, observed); return observed; });
        await this.step(state, "dataset-preload", async () => {
        state.targetStatus = Object.fromEntries(spec.enabled.map(name => [name, "preloading"]));
        state.preloadStartAt = spec.capturePreloadMetrics ? new Date(Math.ceil((Date.now() + spec.t0LeadSeconds * 1000) / 10_000) * 10_000).toISOString() : null;
        const value = await this.adapter.stage(spec, "preload", state.preloadStartAt);
        if (spec.capturePreloadMetrics) {
          await this.adapter.collect(spec, "preload");
          state.preloadSummaries = Object.fromEntries(spec.enabled.map(target => [target, readJson(path.join(state.output, "evidence", "preload", target, "preload-summary.json"))]));
        }
        state.targetStatus = Object.fromEntries(spec.enabled.map(name => [name, "preloaded"]));
        return state.preloadSummaries || value.map(item => item.stdout?.slice(-120));
        });
        await this.step(state, "dataset-certification", async () => { state.targetStatus = Object.fromEntries(spec.enabled.map(name => [name, "certifying"])); await this.adapter.stage(spec, "certify"); await this.adapter.collect(spec, "certify"); state.certificates = Object.fromEntries(spec.enabled.map(target => [target, readJson(path.join(state.output, "evidence", "certify", target, "dataset-certificate.json"))])); state.targetStatus = Object.fromEntries(spec.enabled.map(name => [name, "certified"])); return Object.fromEntries(Object.entries(state.certificates).map(([key, value]) => [key, value.observedSha256])); });
        await this.step(state, "dataset-hash-match", () => { const hashes = Object.values(state.certificates).map(value => value.observedSha256); if (new Set(hashes).size !== 1 || Object.values(state.certificates).some(value => !value.passed)) throw new Error("Dataset certificates do not match"); return hashes[0]; });
        await this.step(state, "t0-scheduled", () => `${spec.matrix.length} synchronized session T0 value(s) will use a ${spec.t0LeadSeconds}s delivery window`);
      } else await this.recoverInterruptedSession(state);
      await this.step(state, "workload", async () => {
        for (const session of spec.matrix) {
          if (state.sessionResults.some(item => item.id === session.id)) continue;
          state.currentSession = { id: session.id, name: session.name || session.configName, description: session.description, configFile: session.configFile, repetition: session.repetition, index: state.sessionResults.length + 1, total: spec.matrix.length, offeredOperationsPerSecond: session.averageScheduledOperationsPerSecond, durationSeconds: session.durationSeconds, loadGeneratorCount: spec.loadGeneratorCount || 1, properties: { readPercent: session.readPercent, writePercent: session.writePercent, consistency: session.consistency, loadModel: session.loadModel, executionMode: session.executionMode, loadSchedule: session.loadSchedule, fixedConcurrency: session.fixedConcurrency, maxInflight: session.maxInflight, scheduledOperationsPerTarget: session.scheduledOperationsPerTarget, averageScheduledOperationsPerSecond: session.averageScheduledOperationsPerSecond, maxAttempts: session.maxAttempts, requestTimeoutMs: session.requestTimeoutMs, keyCount: session.keyCount, payloadBytes: session.payloadBytes, logicalItemBytes: session.logicalItemBytes, loadGeneratorCount: spec.loadGeneratorCount || 1 } };
          state.runnerMetricSamples = [];
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
                state.targetMetrics = Object.fromEntries(Object.entries(progress).map(([target, value]) => [target, { completed: value.completed, failed: value.failed, scheduled: value.scheduled, operationsPerSecond: value.achievedOperationsPerSecond, inFlight: value.inFlight, latestLatencyMs: value.latestLatencyMs, rollingP95Ms: value.rollingP95Ms, runner: value.runner || null, at: value.at, provisional: true }]));
                const sampleAt = Object.values(progress).map(value => value.at).filter(Boolean).sort().at(-1);
                if (sampleAt && Date.parse(sampleAt) >= Date.parse(state.sharedStartAt) && state.runnerMetricSamples.at(-1)?.at !== sampleAt) {
                  state.runnerMetricSamples.push({ at: sampleAt, targets: Object.fromEntries(Object.entries(progress).filter(([, value]) => value.runner).map(([target, value]) => [target, value.runner])) });
                  if (state.runnerMetricSamples.length > 900) state.runnerMetricSamples.splice(0, state.runnerMetricSamples.length - 900);
                }
                if (Date.now() - lastProgressLogAt >= 5000) { for (const [target, value] of Object.entries(progress)) appendLog(state, { stage: "workload", target, message: `${value.completed || 0}/${value.scheduled || session.scheduledOperationsPerTarget} completed; ${Number(value.achievedOperationsPerSecond || 0).toFixed(1)} ops/s; p95 ${value.rollingP95Ms == null ? "-" : Number(value.rollingP95Ms).toFixed(2)} ms; ${value.failed || 0} failed` }); lastProgressLogAt = Date.now(); }
                this.persist(state);
              }
            }
          }
          await running;
          if (stageError) { appendLog(state, { level: "warning", stage: "workload", message: `A remote command reported a terminal error; collecting its final evidence before deciding whether the session is recoverable: ${stageError.message}` }); this.persist(state); }
          state.targetStatus = Object.fromEntries(spec.enabled.map(name => [name, "collecting"]));
          try { await this.adapter.collect(spec, `run/${session.id}`); }
          catch (collectionError) { throw new Error(stageError ? `${stageError.message}; final evidence collection also failed: ${collectionError.message}` : collectionError.message); }
          const summaries = Object.fromEntries(spec.enabled.map(target => [target, readJson(path.join(state.output, "evidence", "run", session.id, target, "summary.json"))]));
          const stageSummaries = await workloadStageSummaries(state, session);
          const values = Object.values(summaries);
          if (values.some(value => Number(value.accounted) !== Number(value.scheduled))) throw new Error(`${session.id} evidence is not fully accounted`);
          if (new Set(values.map(value => value.configSha256)).size !== 1 || new Set(values.map(value => value.scheduledStartAt)).size !== 1) throw new Error(`${session.id} evidence does not match its immutable configuration or shared T0`);
          state.summaries = summaries;
          state.targetMetrics = Object.fromEntries(Object.entries(summaries).map(([target, value]) => [target, { completed: value.completed, scheduled: value.scheduled, failed: value.failed, operationsPerSecond: value.achievedOperationsPerSecond, inFlight: 0, observedMaxInFlight: value.concurrency?.observedAtOperationStart?.max ?? null, latestLatencyMs: value.successfulServiceLatencyMs?.max ?? null, p95: value.successfulServiceLatencyMs?.p95 ?? null, p99: value.successfulServiceLatencyMs?.p99 ?? null, max: value.successfulServiceLatencyMs?.max ?? null, provisional: false }]));
          const runnerMetrics = typeof this.adapter.collectRunnerMetrics === "function" ? await this.adapter.collectRunnerMetrics(spec, session, summaries) : {};
          state.sessionResults.push({ id: session.id, configFile: session.configFile, repetition: session.repetition, sharedStartAt: state.sharedStartAt, summaries, stageSummaries, runnerMetrics });
          state.targetStatus = Object.fromEntries(spec.enabled.map(name => [name, "completed"]));
          for (const [target, summary] of Object.entries(summaries)) appendLog(state, { level: summary.failed ? "error" : "success", stage: "workload", target, message: `Session complete; ${summary.completed}/${summary.scheduled} operations; p95 ${summary.successfulServiceLatencyMs?.p95 ?? "-"} ms; p99 ${summary.successfulServiceLatencyMs?.p99 ?? "-"} ms` });
        }
        state.currentSession = null;
        return `${state.sessionResults.length} matrix session(s) completed`;
      });
      await this.step(state, "evidence-collection", () => path.join(state.output, "evidence", "run"));
      await this.step(state, "acceptance-validation", () => { let maximumStartSkewMs = 0, serviceFailures = 0; for (const session of state.sessionResults) { const values = Object.values(session.summaries); if (values.some(value => !value.harnessPassed || value.accounted !== value.scheduled)) throw new Error(`${session.id} failed workload accounting acceptance`); if (new Set(values.map(value => value.configSha256)).size !== 1 || new Set(values.map(value => value.scheduledStartAt)).size !== 1) throw new Error(`${session.id} configuration hash or T0 differs across targets`); maximumStartSkewMs = Math.max(maximumStartSkewMs, ...values.map(value => Math.abs(value.startSkewMs))); serviceFailures += values.reduce((sum, value) => sum + Number(value.failed || 0), 0); } return { sessions: state.sessionResults.length, maximumStartSkewMs, serviceFailures, note: serviceFailures ? "Service errors are preserved as benchmark results and do not invalidate complete accounting" : "No service errors" }; });
      await this.completePackage(state);
    } catch (error) { const stopped = Boolean(state.stopRequestedAt); state.status = stopped ? "stopped" : "failed"; state.error = stopped ? null : error.message; state.completedAt = new Date().toISOString(); state.targetStatus = Object.fromEntries(Object.keys(state.targetStatus || {}).map(target => [target, state.targetStatus[target] === "completed" ? "completed" : stopped ? "stopped" : "failed"])); appendLog(state, { level: stopped ? "warning" : "error", message: stopped ? "Pipeline stopped by operator; resources and evidence were preserved" : `Pipeline stopped: ${error.message}` }); this.persist(state); }
  }
}

export { aggregatePreloadEvidence, aggregateProgressSources, aggregateTargetEvidence, defaultImage, remoteScript, validate as validateCloudSpecification };
