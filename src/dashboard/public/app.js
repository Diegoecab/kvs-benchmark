const $ = id => document.getElementById(id);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const number = value => value == null ? "-" : Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
const value = id => $(id).value.trim();
const optionalNumber = id => value(id) === "" ? undefined : Number(value(id));
let bootstrap = null;
let lastSpec = null;
let currentStep = 1;
let runLocked = false;
let wizardActive = false;
let suppressPreview = true;
let discovered = null;
let destinations = null;
let liveChartSession = null;
let liveChartSamples = [];
let terminalRunId = null;
let terminalLogs = [];
let terminalClearedCount = 0;
let terminalPaused = false;
let runHistory = [];
let runHistoryPending = false;
let runHistoryPage = 1;
const runHistoryPageSize = 5;
let stageBrowserRunId = null;
let selectedStageKey = null;
let stageChartSession = null;
let stageChartResult = null;
const selectedTargets = new Set();
let automaticDiscovery = null;
let automaticDiscoveryPending = false;
const draftKey = "kvs-dashboard-draft-v1";
const incompatibleRunnerKey = "kvs-dashboard-incompatible-runners-v1";
const incompatibleRunners = new Set((() => { try { const values = JSON.parse(localStorage.getItem(incompatibleRunnerKey)); return Array.isArray(values) ? values : []; } catch { return []; } })());
const runnerSelectIds = ["aws-runner", "adb-runner", "ndcs-runner"];
const draftFieldIds = ["infra-repo", "infra-ref", "infra-workspace", "destination-cloud", "destination-product", "load-generator-count", "aws-profile", "aws-region", "aws-runner", "aws-table", "aws-table-manual", "artifact-bucket", "adb-profile", "adb-region", "adb-compartment", "adb-database", "adb-runner", "adb-table", "adb-table-manual", "adb-artifact-bucket", "ndcs-profile", "ndcs-region", "ndcs-compartment", "ndcs-runner", "ndcs-table", "ndcs-table-manual", "ndcs-artifact-bucket", "image-digest", "t0-lead-seconds", "preload-rate", "preload-max-inflight", "preload-max-attempts", "preload-retry-delay-ms"];
let draftSaveTimer = null;
let restoringDraft = false;

function readDraft() { try { const draft = JSON.parse(localStorage.getItem(draftKey)); return draft?.schemaVersion === 1 ? draft : null; } catch { return null; } }
function draftSnapshot() {
  const fields = Object.fromEntries(draftFieldIds.map(id => [id, runnerSelectIds.includes(id) ? selectedValues(id) : $(id)?.value ?? ""]));
  const presets = Object.fromEntries([...document.querySelectorAll("#configs tr")].map(row => [row.dataset.config, { selected: row.querySelector('input[name="config"]').checked, repetitions: row.querySelector(".preset-repetitions").value, readPercent: row.querySelector(".preset-read-percent").value, consistency: row.querySelector(".preset-consistency").value, duration: row.querySelector(".preset-duration").value, load: row.querySelector(".preset-load")?.value, concurrency: row.querySelector(".preset-concurrency")?.value }]));
  return { schemaVersion: 1, savedAt: new Date().toISOString(), step: currentStep, infrastructureMode: document.querySelector('input[name="infra-mode"]:checked')?.value, runMode: runMode(), capturePreloadMetrics: $("capture-preload-metrics").checked, selectedTargets: [...selectedTargets], fields, presets };
}
function saveDraft() { if (restoringDraft || !bootstrap) return; const draft = draftSnapshot(); localStorage.setItem(draftKey, JSON.stringify(draft)); $("draft-status").textContent = `Saved locally at ${new Date(draft.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`; }
function scheduleDraftSave() { if (restoringDraft) return; clearTimeout(draftSaveTimer); draftSaveTimer = setTimeout(saveDraft, 250); }
function setDraftField(id, item) { const element = $(id); if (!element || item == null) return; if (element.multiple && Array.isArray(item)) { const selected = new Set(item.map(String)); for (const option of element.options) option.selected = selected.has(option.value); return; } if (element.tagName === "SELECT" && ![...element.options].some(option => option.value === String(item))) return; element.value = String(item); }
function applyPresetDraft(presets = {}) { for (const row of document.querySelectorAll("#configs tr")) { const item = presets[row.dataset.config]; if (!item) continue; row.querySelector('input[name="config"]').checked = Boolean(item.selected); for (const [selector, key] of [[".preset-repetitions", "repetitions"], [".preset-read-percent", "readPercent"], [".preset-consistency", "consistency"], [".preset-duration", "duration"], [".preset-load", "load"], [".preset-concurrency", "concurrency"]]) { const control = row.querySelector(selector); if (control && item[key] != null) control.value = item[key]; } row.querySelector(".preset-read-percent").dispatchEvent(new Event("input")); } updatePresetCount(); }
async function restoreDraft(draft) {
  if (!draft) { void autoDiscoverActiveTarget(); return; }
  restoringDraft = true;
  for (const id of draftFieldIds) setDraftField(id, draft.fields?.[id]);
  const infra = document.querySelector(`input[name="infra-mode"][value="${CSS.escape(draft.infrastructureMode || "existing")}"]`); if (infra) infra.checked = true;
  const mode = document.querySelector(`input[name="run-mode"][value="${CSS.escape(draft.runMode || "async")}"]`); if (mode) mode.checked = true;
  $("capture-preload-metrics").checked = Boolean(draft.capturePreloadMetrics);
  selectedTargets.clear(); for (const target of draft.selectedTargets || []) if (["aws", "adb", "ndcs"].includes(target)) selectedTargets.add(target);
  syncDestinationProducts(); setDraftField("destination-product", draft.fields?.["destination-product"]); syncCloudCatalog(); applyPresetDraft(draft.presets);
  restoringDraft = false;
  await discoverDestinations({ automatic: true });
  restoringDraft = true; for (const id of draftFieldIds) setDraftField(id, draft.fields?.[id]); restoringDraft = false;
  for (const target of ["aws", "adb", "ndcs"]) $(`${target}-enabled`).checked = selectedTargets.has(target);
  for (const prefix of ["aws-table", "adb-table", "ndcs-table"]) syncManual(prefix);
  updateRunnerSelectionStatus(); renderDestinationSummary(); renderDestinationDetails(); syncLiveChartVisibility(); currentStep = draft.step || 1;
  $("draft-status").textContent = `Draft restored from ${new Date(draft.savedAt).toLocaleString()}`;
}

function selected(select, preferred) { if (!select.options.length) return; ([...select.options].find(option => option.value === preferred) || select.options[0]).selected = true; }
function profiles(select, values, preferred) { select.size = 1; select.replaceChildren(...values.map(item => new Option(item, item))); selected(select, preferred); }
const recommendedPreset = file => file.includes("5m") || file.includes("mixed-70-30");
function presetDuration(seconds) { if (seconds == null) return "Variable"; return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} sec`; }
function updatePresetCount() { const selected = document.querySelectorAll('input[name="config"]:checked').length; $("preset-count").textContent = `${selected} preset${selected === 1 ? "" : "s"} selected`; }
function renderRunnerImage() {
  const reference = value("image-digest"), [repository = "", digest = ""] = reference.split("@"), slash = repository.indexOf("/");
  const registry = slash > 0 ? repository.slice(0, slash) : repository || "—", imageRepository = slash > 0 ? repository.slice(slash + 1) : "—", shortDigest = digest ? `${digest.slice(0, 19)}…${digest.slice(-12)}` : "Not pinned";
  $("image-metadata").innerHTML = [["Registry", registry], ["Repository", imageRepository], ["Digest", shortDigest]].map(([label, item]) => `<dt>${escapeHtml(label)}</dt><dd title="${escapeHtml(item)}">${escapeHtml(item)}</dd>`).join("");
}

function renderConfigs(configs) {
  $("configs").replaceChildren(...configs.map(config => {
    const row = document.createElement("tr"), selectedByDefault = recommendedPreset(config.file);
    row.dataset.config = config.file; row.dataset.model = config.model;
    const choice = document.createElement("td"), input = document.createElement("input"); input.type = "checkbox"; input.value = config.file; input.checked = selectedByDefault; input.name = "config"; input.setAttribute("aria-label", `Run ${config.name}`); choice.append(input);
    const preset = document.createElement("td"), title = document.createElement("b"); title.textContent = config.name; preset.append(title); if (selectedByDefault) { const badge = document.createElement("small"); badge.className = "preset-badge"; badge.textContent = "Recommended"; preset.append(badge); }
    const repetitionCell = document.createElement("td"), repetitions = document.createElement("input"); repetitions.type = "number"; repetitions.min = "1"; repetitions.step = "1"; repetitions.value = "1"; repetitions.className = "preset-repetitions"; repetitions.dataset.config = config.file; repetitions.setAttribute("aria-label", `Repetitions for ${config.name}`); repetitionCell.append(repetitions);
    const modelCell = document.createElement("td"); modelCell.textContent = config.model === "open-loop" ? "Open-loop" : "Fixed workers";
    const mixCell = document.createElement("td"), mixControl = document.createElement("div"), mix = document.createElement("input"), mixValue = document.createElement("output"), mixEnds = document.createElement("div"); mixCell.className = "mix-cell"; mixControl.className = "mix-control"; mix.type = "range"; mix.min = "0"; mix.max = "100"; mix.step = "1"; mix.value = String(config.readPercent); mix.className = "preset-read-percent"; mix.setAttribute("aria-label", `Read percentage for ${config.name}`); mixValue.className = "mix-value"; mixEnds.className = "mix-ends"; mixEnds.innerHTML = "<span>Writes</span><span>Reads</span>"; const updateMix = () => { const reads = Number(mix.value); mixValue.textContent = `${reads}% reads · ${100 - reads}% writes`; mix.style.setProperty("--read-percent", `${reads}%`); }; updateMix(); mix.addEventListener("input", updateMix); mixControl.append(mixValue, mix, mixEnds); mixCell.append(mixControl);
    const consistencyCell = document.createElement("td"), consistency = document.createElement("select"); consistency.className = "preset-consistency"; consistency.append(new Option("Strong", "strong"), new Option("Eventual", "eventual")); consistency.value = config.consistency; consistencyCell.append(consistency);
    const durationCell = document.createElement("td"), duration = document.createElement("input"); duration.type = "number"; duration.min = "1"; duration.step = "1"; duration.value = String(config.durationSeconds); duration.className = "preset-duration"; duration.setAttribute("aria-label", `Duration seconds for ${config.name}`); durationCell.append(duration);
    const loadCell = document.createElement("td"), load = document.createElement("input"); loadCell.className = "load-cell"; load.type = "number"; load.min = "0.001"; load.step = "0.1"; load.value = String(config.rateMultiplier || 1); load.className = "preset-load"; load.title = `${config.loadSummary}; multiplier applied to every offered-load step`; load.setAttribute("aria-label", `Load multiplier for ${config.name}`); if (config.model === "open-loop") loadCell.append(load); else loadCell.innerHTML = '<span class="not-applicable">N/A · closed-loop</span>';
    const concurrencyCell = document.createElement("td"), concurrency = document.createElement("input"); concurrencyCell.className = "concurrency-cell"; concurrency.type = "number"; concurrency.min = "1"; concurrency.step = "1"; concurrency.value = config.fixedConcurrency == null ? "1" : String(config.fixedConcurrency); concurrency.className = "preset-concurrency"; concurrency.title = config.loadSummary || "Constant worker count"; concurrency.setAttribute("aria-label", `Fixed concurrency for ${config.name}`); if (config.model === "closed-loop") concurrencyCell.append(concurrency); else concurrencyCell.innerHTML = '<span class="not-applicable">N/A · open-loop</span>';
    row.append(choice, preset, repetitionCell, modelCell, mixCell, consistencyCell, durationCell, loadCell, concurrencyCell);
    input.addEventListener("change", updatePresetCount); return row;
  }));
  updatePresetCount();
}

function selectPresets(predicate) { document.querySelectorAll('input[name="config"]').forEach(input => { input.checked = predicate(input.value); }); updatePresetCount(); }

function syncOverrideApplicability() {
  return undefined;
}

async function load() {
  $("connection").textContent = "Discovering profiles...";
  const response = await fetch("/api/bootstrap", { cache: "no-store" });
  if (!response.ok) throw new Error(`Bootstrap failed (${response.status})`);
  bootstrap = await response.json();
  $("session-status").after($("live-chart-panel"));
  const draft = readDraft();
  profiles($("aws-profile"), bootstrap.profiles.aws, draft?.fields?.["aws-profile"] || "default"); profiles($("adb-profile"), bootstrap.profiles.oci, draft?.fields?.["adb-profile"] || "DEFAULT"); profiles($("ndcs-profile"), bootstrap.profiles.oci, draft?.fields?.["ndcs-profile"] || "DEFAULT");
  $("image-digest").value = bootstrap.defaults.imageDigest || ""; renderRunnerImage();
  $("adb-table-manual").value = localStorage.getItem("kvs-dashboard-adb-table") || "";
  renderConfigs(bootstrap.configs); syncOverrideApplicability();
  $("warnings").innerHTML = bootstrap.profiles.warnings.map(item => `<div class="callout warning">${escapeHtml(item)}</div>`).join("");
  $("connection").textContent = `${bootstrap.profiles.aws.length} AWS | ${bootstrap.profiles.oci.length} OCI profiles`; $("connection").className = "status ok";
  await restoreDraft(draft);
  const savedRun = localStorage.getItem("kvs-dashboard-run-id");
  const activeResponse = await fetch("/api/runs/active", { cache: "no-store" });
  const activeResult = activeResponse.ok ? await activeResponse.json() : { active: null };
  const restoredRun = activeResult.active || (activeResult.latest?.id === savedRun ? activeResult.latest : null) || activeResult.latest;
  const runId = restoredRun?.id || savedRun;
  if (runId) {
    localStorage.setItem("kvs-dashboard-run-id", runId);
    showOperations();
    if (restoredRun) showSmoke(restoredRun);
    void monitorRun(runId, restoredRun?.mode || "async", true);
  }
  await refreshRunHistory({ preserveSelection: true });
  setInterval(() => void syncServerActiveRun(), 5000);
  suppressPreview = false;
}

const terminalRunStatuses = new Set(["complete", "failed", "stopped"]);
const runKindLabel = kind => kind === "local-mock-smoke" ? "Local functional test" : "Cloud benchmark";
const runTargetLabel = target => ({ aws: "AWS DynamoDB", adb: "ADB DynamoDB API", ndcs: "OCI NoSQL", mock: "Local mock" })[target] || String(target).toUpperCase();
const runStageLabel = name => ({
  "runner-readiness": "Runner readiness",
  "resource-validation": "Resource validation",
  "dataset-preload": "Dataset preload",
  "dataset-certification": "Dataset certification",
  "dataset-hash-match": "Dataset hash match",
  "t0-scheduled": "T0 scheduling",
  workload: "Workload matrix",
  "evidence-collection": "Evidence collection",
  "acceptance-validation": "Acceptance validation",
  "package-generation": "Package generation"
})[name] || String(name || "pending").replaceAll("-", " ");
const targetStatusView = status => ({
  queued: ["Queued", "Waiting for the control plane"],
  validating: ["Validating", "Checking the existing runner and table"],
  preloading: ["Preloading", "Writing the canonical dataset"],
  preloaded: ["Preloaded", "Canonical writes completed"],
  certifying: ["Certifying", "Strong-reading and hashing every key"],
  certified: ["Certified", "Dataset hash verified locally"],
  scheduled: ["Scheduled", "Waiting for the shared T0"],
  running: ["Running", "Workload traffic is active"],
  collecting: ["Collecting", "Retrieving provider evidence"],
  completed: ["Complete", "Target evidence finalized"],
  complete: ["Complete", "Target evidence finalized"],
  stopping: ["Stopping", "Cancelling the active command"],
  stopped: ["Stopped", "Execution stopped; evidence preserved"],
  failed: ["Failed", "Target did not complete this stage"]
})[status] || [String(status || "Pending").replaceAll("-", " "), "Waiting for its next pipeline action"];
function compactResourceId(item) { const value = String(item || "-"); return value.length > 30 ? `${value.slice(0, 14)}...${value.slice(-10)}` : value; }
function localDateTime(item) { return item ? new Date(item).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" }) : "Pending"; }
function durationLabel(start, end = new Date().toISOString()) { const milliseconds = Date.parse(end) - Date.parse(start); if (!Number.isFinite(milliseconds) || milliseconds < 0) return "-"; const seconds = Math.round(milliseconds / 1000); return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m` : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`; }
function renderRunOverview(run) {
  const view = $("run-overview"), cloud = run.kind === "cloud-benchmark" || run.kind === "cloud-acceptance";
  if (!cloud) { view.classList.add("hidden"); view.innerHTML = ""; return; }
  const stage = (run.stages || []).find(item => item.status === "running") || (run.stages || []).find(item => item.status === "failed") || (run.stages || []).at(-1);
  const targets = Object.keys(run.targetStatus || {}), inventory = run.resourceInventory || {};
  const cards = targets.map(target => {
    const reportedStatus = run.targetStatus[target], waitingForT0 = reportedStatus === "running" && run.sharedStartAt && Date.now() < Date.parse(run.sharedStartAt), status = waitingForT0 ? "scheduled" : reportedStatus, [label, description] = targetStatusView(status), resource = inventory[target] || {};
    const fallbackRunner = resource.runnerInstanceId || resource.runnerInstanceOcid, runners = Array.isArray(resource.runnerInstances) && resource.runnerInstances.length ? resource.runnerInstances : fallbackRunner ? [{ id: fallbackRunner }] : [], table = resource.tableName || "Table pending validation";
    const identities = runners.map(item => `${item.displayName || compactResourceId(item.id)} @ ${item.publicIp || item.privateIp || "IP pending"}`), runnerLabel = identities.length ? `${identities.length} source${identities.length === 1 ? "" : "s"} · ${identities.join(", ")}` : "Pending";
    const database = target === "adb" ? `<div><dt>Database</dt><dd>${escapeHtml([resource.databaseVersion, resource.computeCount && `${resource.computeCount} ${resource.computeModel || "compute"}`, resource.licenseModel === "BRING_YOUR_OWN_LICENSE" ? "BYOL" : resource.licenseModel].filter(Boolean).join(" · ") || "Pending")}</dd></div>` : "";
    return `<article class="target-overview provider-${escapeHtml(target)}"><div class="target-overview-heading"><div>${providerMark(target)}<span><b>${escapeHtml(runTargetLabel(target))}</b><small>${escapeHtml(resource.region || "Region pending")}</small></span></div><span class="target-state ${escapeHtml(status || "pending")}">${escapeHtml(label)}</span></div><strong>${escapeHtml(description)}</strong><dl><div><dt>Table</dt><dd title="${escapeHtml(table)}">${escapeHtml(table)}</dd></div>${database}<div><dt>Load generators</dt><dd title="${escapeHtml(runnerLabel)}">${escapeHtml(runnerLabel)}</dd></div></dl></article>`;
  }).join("");
  view.classList.remove("hidden");
  view.innerHTML = `<div class="run-overview-heading"><div><p class="eyebrow">ACTIVE CLOUD RUN</p><h4>${escapeHtml(runStageLabel(stage?.name))}</h4><p>${escapeHtml(run.id)} · started ${escapeHtml(localDateTime(run.startedAt))} · elapsed ${escapeHtml(durationLabel(run.startedAt))}</p></div><span class="run-history-state ${escapeHtml(run.status)}">${escapeHtml(run.status.toUpperCase())}</span></div><div class="target-overview-grid">${cards}</div>`;
}
function stageTechnicalDetail(stage) {
  if (!stage?.detail || stage.detail === "Passed") return "";
  return `<details class="stage-evidence"><summary>Technical stage evidence</summary><pre>${escapeHtml(stage.detail)}</pre></details>`;
}
function preloadStageDetail(run) {
  const summaries = run.preloadSummaries || {};
  if (!Object.keys(summaries).length) return '<p class="stage-empty">Preload metrics will appear here as soon as all target summaries are collected.</p>';
  const rows = Object.entries(summaries).map(([target, summary]) => `<tr><td>${providerMark(target)} ${escapeHtml(runTargetLabel(target))}</td><td>${number(summary.completed)} / ${number(summary.requested)}</td><td>${number(summary.failures)}</td><td>${number(summary.successfulOperationsPerSecond)} ops/s</td><td>${number(summary.latencyMs?.p50)} ms</td><td>${number(summary.latencyMs?.p95)} ms</td><td>${number(summary.latencyMs?.p99)} ms</td><td>${number(summary.latencyMs?.max)} ms</td><td>${number(summary.startSkewMs)} ms</td><td>${target === "adb" && Number(summary.writeUnits) === 0 ? "Unavailable" : number(summary.writeUnits)}</td></tr>`).join("");
  return `<div class="stage-result-callout success"><b>Canonical preload passed on ${Object.keys(summaries).length} targets</b><span>Shared T0 ${escapeHtml(run.preloadStartAt || "-")} · offered ${number(Object.values(summaries)[0]?.requestedOperationsPerSecond)} writes/s</span></div><div class="table-wrap stage-results"><table><thead><tr><th>Target</th><th>Completed</th><th>Failed</th><th>Throughput</th><th>P50</th><th>P95</th><th>P99</th><th>Max</th><th>T0 skew</th><th>Write units</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function certificationStageDetail(run) {
  const certificates = run.certificates || {};
  if (!Object.keys(certificates).length) return '<p class="stage-empty">Strong reads and hashes are still being collected from the enabled targets.</p>';
  const rows = Object.entries(certificates).map(([target, certificate]) => `<tr><td>${providerMark(target)} ${escapeHtml(runTargetLabel(target))}</td><td>${number(certificate.found ?? certificate.keyCount)} / ${number(certificate.keyCount)}</td><td>${number(certificate.mismatchCount)}</td><td><code title="${escapeHtml(certificate.observedSha256 || "-")}">${escapeHtml(compactResourceId(certificate.observedSha256 || "-"))}</code></td><td><span class="target-state ${certificate.passed ? "complete" : "failed"}">${certificate.passed ? "Passed" : "Failed"}</span></td></tr>`).join("");
  return `<div class="table-wrap stage-results"><table><thead><tr><th>Target</th><th>Keys found</th><th>Mismatches</th><th>Observed hash</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function inventoryStageDetail(run) {
  const rows = Object.entries(run.resourceInventory || {}).map(([target, resource]) => { const configuration = target === "adb" ? [resource.databaseVersion, resource.computeCount && `${resource.computeCount} ${resource.computeModel || "compute"}`, resource.licenseModel === "BRING_YOUR_OWN_LICENSE" ? "BYOL" : resource.licenseModel].filter(Boolean).join(" · ") : `${resource.loadGeneratorCount || 1} load generator(s)`; return `<tr><td>${providerMark(target)} ${escapeHtml(runTargetLabel(target))}</td><td>${escapeHtml(resource.region || "-")}</td><td>${escapeHtml(resource.tableName || "-")}</td><td>${escapeHtml(configuration || "-")}</td><td title="${escapeHtml(resource.runnerInstanceId || resource.runnerInstanceOcid || "-")}">${escapeHtml(compactResourceId(resource.runnerInstanceId || resource.runnerInstanceOcid || "-"))}</td><td title="${escapeHtml(resource.tableArn || resource.tableOcid || resource.autonomousDatabaseOcid || "-")}">${escapeHtml(compactResourceId(resource.tableArn || resource.tableOcid || resource.autonomousDatabaseOcid || "-"))}</td></tr>`; }).join("");
  return rows ? `<div class="table-wrap stage-results"><table><thead><tr><th>Target</th><th>Region</th><th>Table</th><th>Configuration</th><th>Runner</th><th>Service resource</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="stage-empty">Resource inventory is pending validation.</p>';
}
function sessionState(run, session) {
  if ((run.sessionResults || []).some(item => item.id === session.id)) return "complete";
  if (run.currentSession?.id === session.id) return run.sharedStartAt && Date.now() < Date.parse(run.sharedStartAt) ? "scheduled" : "running";
  if (["failed", "stopped"].includes(run.status)) return "not-run";
  return "pending";
}
function sessionSchedule(session, status, startAt) {
  if (!Array.isArray(session.loadSchedule) || !session.loadSchedule.length) return "";
  let offset = 0, elapsed = status === "running" && startAt ? Math.max(0, (Date.now() - Date.parse(startAt)) / 1000) : null;
  return `<div class="load-stage-grid">${session.loadSchedule.map((step, index) => { const start = offset, end = offset += Number(step.seconds); const phaseStatus = status === "complete" ? "complete" : status === "running" && elapsed >= end ? "complete" : status === "running" && elapsed >= start ? "running" : status === "not-run" ? "not-run" : "pending"; return `<article class="load-stage ${phaseStatus}"><span>Stage ${index}</span><b>${number(step.operationsPerSecond)} ops/s</b><small>${number(step.seconds)}s · T+${number(start)}s to T+${number(end)}s</small><i>${phaseStatus === "not-run" ? "Not run" : phaseStatus}</i></article>`; }).join("")}</div>`;
}
function drawStageBarChart(canvas, session, stageSummaries, { metric, offered = false, logarithmic = false, suffix = "" }) {
  const context = canvas.getContext("2d"), width = canvas.width, height = canvas.height, margin = { left: 66, right: 18, top: 26, bottom: 62 }, enabled = enabledSeries();
  context.clearRect(0, 0, width, height); context.fillStyle = "#0b1017"; context.fillRect(0, 0, width, height);
  const targets = Object.keys(stageSummaries).filter(target => enabled.has(target) && Array.isArray(stageSummaries[target])), series = [...(offered && enabled.has("offered") ? ["offered"] : []), ...targets];
  const values = session.loadSchedule.map((step, index) => Object.fromEntries(series.map(target => [target, target === "offered" ? Number(step.operationsPerSecond) : Number(metric(stageSummaries[target][index] || {}))])));
  const rawMaximum = Math.max(1, ...values.flatMap(item => Object.values(item).filter(Number.isFinite))), scale = value => logarithmic ? Math.log10(Math.max(0, value) + 1) : value, maximum = scale(rawMaximum) * 1.12;
  context.strokeStyle = "#26303d"; context.fillStyle = "#9aa7b8"; context.font = "11px ui-monospace, monospace"; context.textAlign = "right";
  for (let tick = 0; tick <= 4; tick += 1) { const fraction = (4 - tick) / 4, y = margin.top + (height - margin.top - margin.bottom) * tick / 4, raw = logarithmic ? Math.pow(10, maximum * fraction) - 1 : maximum * fraction; context.beginPath(); context.moveTo(margin.left, y); context.lineTo(width - margin.right, y); context.stroke(); context.fillText(number(raw), margin.left - 8, y + 4); }
  if (!series.length || !values.length) { context.fillText("Select at least one target", width / 2, height / 2); return; }
  const plotWidth = width - margin.left - margin.right, groupWidth = plotWidth / values.length, barGap = 3, barWidth = Math.min(34, Math.max(5, (groupWidth - 18) / series.length - barGap));
  values.forEach((stage, stageIndex) => {
    const barsWidth = series.length * (barWidth + barGap) - barGap, startX = margin.left + groupWidth * stageIndex + (groupWidth - barsWidth) / 2;
    series.forEach((target, seriesIndex) => { const raw = stage[target], normalized = Number.isFinite(raw) ? scale(raw) / maximum : 0, barHeight = Math.max(0, (height - margin.top - margin.bottom) * normalized), x = startX + seriesIndex * (barWidth + barGap), y = height - margin.bottom - barHeight; context.fillStyle = chartColors[target] || "#64748b"; if (target === "offered") { context.strokeStyle = context.fillStyle; context.lineWidth = 2; context.strokeRect(x, y, barWidth, barHeight); } else context.fillRect(x, y, barWidth, barHeight); if (Number.isFinite(raw) && barWidth >= 12) { context.save(); context.translate(x + barWidth / 2, Math.max(margin.top + 8, y - 4)); context.rotate(-Math.PI / 2); context.fillStyle = "#cbd5e1"; context.font = "10px ui-monospace, monospace"; context.textAlign = "left"; context.fillText(`${number(raw)}${suffix}`, 0, 3); context.restore(); } });
    const step = session.loadSchedule[stageIndex]; context.fillStyle = "#b7c2d0"; context.textAlign = "center"; context.font = "11px ui-monospace, monospace"; context.fillText(`Stage ${stageIndex}`, margin.left + groupWidth * (stageIndex + .5), height - 38); context.fillStyle = "#748197"; context.fillText(`${number(step.operationsPerSecond)} ops/s · ${number(step.seconds)}s`, margin.left + groupWidth * (stageIndex + .5), height - 20);
  });
}
function renderOfferedLoadStageCharts(session, result) {
  const panel = $("offered-stage-panel"), stageSummaries = result?.stageSummaries || {}, targets = Object.keys(stageSummaries).filter(target => Array.isArray(stageSummaries[target]) && stageSummaries[target].length);
  stageChartSession = session || null; stageChartResult = result || null;
  if (!panel || !session || !targets.length || !Array.isArray(session.loadSchedule) || !session.loadSchedule.length) { if (panel) panel.classList.add("hidden"); return; }
  panel.classList.remove("hidden"); $("offered-stage-caption").textContent = `${session.id} · each ramp is shown independently; target visibility follows the comparison selector above.`;
  drawStageBarChart($("stage-throughput-chart"), session, stageSummaries, { offered: true, metric: item => item.successfulOperationsPerSecond, suffix: "" });
  drawStageBarChart($("stage-success-chart"), session, stageSummaries, { metric: item => Number(item.serviceSuccessRate || 0) * 100, suffix: "%" });
  drawStageBarChart($("stage-latency-chart"), session, stageSummaries, { metric: item => item.successfulServiceLatencyMs?.p95, logarithmic: true, suffix: "ms" });
}
const runnerMetricDefinitions = [
  ["runner-history-cpu", "CPU utilization · percent", "cpuUtilizationPercent", value => value],
  ["runner-history-memory", "Memory utilization · percent", "memoryUtilizationPercent", value => value],
  ["runner-history-load", "Load average · 1 minute", "loadAverage1m", value => value],
  ["runner-history-network", "Network throughput · Mbit/s", "network", value => value * 8 / 1_000_000],
];
function runnerMetricsMarkup(result) {
  const metrics = result?.runnerMetrics || {}, available = Object.values(metrics).filter(item => item?.available);
  if (!available.length) return "";
  const limitations = Object.entries(metrics).filter(([, item]) => item?.unavailable?.length).map(([target, item]) => `${runTargetLabel(target)}: ${item.unavailable.join(", ")} unavailable`).join(" · ");
  return `<section class="runner-metrics-panel"><div class="stage-chart-heading"><div><h6>Runner VM health</h6><p>Provider-native one-minute samples aligned to this workload window.</p></div><div class="stage-chart-legend">${Object.keys(metrics).map(target => `<span>${providerMark(target)}${escapeHtml(runTargetLabel(target))}</span>`).join("")}</div></div><div class="chart-grid runner-chart-grid">${runnerMetricDefinitions.map(([id, title]) => `<figure><figcaption>${escapeHtml(title)}</figcaption><canvas id="${id}" width="900" height="240"></canvas></figure>`).join("")}</div>${limitations ? `<p class="chart-note">${escapeHtml(limitations)}. Missing provider metrics are not rendered as zero.</p>` : ""}</section>`;
}
function runnerMetricSeries(result, key, transform) {
  return Object.entries(result?.runnerMetrics || {}).map(([target, report]) => {
    let points;
    if (key === "network") {
      const received = new Map((report.metrics?.networkReceiveBytesPerSecond || []).map(point => [point.timestamp, Number(point.value)])), transmitted = new Map((report.metrics?.networkTransmitBytesPerSecond || []).map(point => [point.timestamp, Number(point.value)]));
      points = [...new Set([...received.keys(), ...transmitted.keys()])].sort().map(timestamp => ({ timestamp, value: Number(received.get(timestamp) || 0) + Number(transmitted.get(timestamp) || 0) }));
    } else points = report.metrics?.[key] || [];
    return { name: target, values: points.map(point => transform(Number(point.value))).filter(Number.isFinite) };
  });
}
function renderRunnerMetricCharts(result) {
  for (const [id, _title, key, transform] of runnerMetricDefinitions) {
    const canvas = $(id); if (!canvas) continue;
    const series = runnerMetricSeries(result, key, transform), samples = Math.max(0, ...series.map(item => item.values.length));
    drawChart(canvas, series, "Metric unavailable for this workload window", `${samples} one-minute sample${samples === 1 ? "" : "s"}`);
  }
}
function sessionResultTable(run, session, result, status) {
  const summaries = result?.summaries || (status === "running" ? run.targetMetrics : null) || {};
  if (!Object.keys(summaries).length) return '<p class="stage-empty">Target results will appear here when this session starts.</p>';
  const rows = Object.entries(summaries).map(([target, summary]) => { const completed = Number(summary.completed || 0), failed = Number(summary.failed || 0), scheduled = Number(summary.scheduled || session.scheduledOperationsPerTarget || 0), latency = summary.successfulServiceLatencyMs || {}; return `<tr><td>${providerMark(target)} ${escapeHtml(runTargetLabel(target))}</td><td>${number(completed + failed)} / ${number(scheduled)}</td><td>${number(failed)}</td><td>${number(summary.achievedOperationsPerSecond ?? summary.operationsPerSecond)} ops/s</td><td>${number(latency.p95 ?? summary.rollingP95Ms ?? summary.p95)} ms</td><td>${number(latency.p99 ?? summary.p99)} ms</td><td>${number(summary.startSkewMs)} ms</td></tr>`; }).join("");
  const stageRows = (session.loadSchedule || []).flatMap((step, index) => Object.entries(result?.stageSummaries || {}).map(([target, stages]) => { const summary = stages[index] || {}, latency = summary.successfulServiceLatencyMs || {}; return `<tr><td>Stage ${index}</td><td>${number(step.operationsPerSecond)} ops/s · ${number(step.seconds)}s</td><td>${providerMark(target)} ${escapeHtml(runTargetLabel(target))}</td><td>${number(summary.accounted)} / ${number(summary.scheduled)}</td><td>${number(summary.failed)}</td><td>${number(summary.successfulOperationsPerSecond)} ops/s</td><td>${number(latency.p95)} ms</td><td>${number(latency.p99)} ms</td></tr>`; })).join("");
  const stages = stageRows ? `<h6 class="stage-result-title">Results by offered-load stage</h6><p class="chart-note">The comparative bar charts for these rows are shown in Execution performance.</p><div class="table-wrap stage-results"><table><thead><tr><th>Stage</th><th>Offered load</th><th>Target</th><th>Accounted</th><th>Failed</th><th>Successful throughput</th><th>P95</th><th>P99</th></tr></thead><tbody>${stageRows}</tbody></table></div>` : "";
  return `<div class="table-wrap stage-results"><table><thead><tr><th>Target</th><th>Accounted</th><th>Failed</th><th>Throughput</th><th>P95</th><th>P99</th><th>T0 skew</th></tr></thead><tbody>${rows}</tbody></table></div>${stages}${runnerMetricsMarkup(result)}`;
}
function sessionStageDetail(run, session) {
  const result = (run.sessionResults || []).find(item => item.id === session.id), status = sessionState(run, session), startAt = result?.sharedStartAt || (run.currentSession?.id === session.id ? run.sharedStartAt : null);
  return `<div class="stage-detail-heading"><div><span class="target-state ${escapeHtml(status)}">${escapeHtml(status === "not-run" ? "Not run" : status)}</span><h5>${escapeHtml(session.name || session.configName || session.id)}</h5><p>${escapeHtml(session.description || `${number(session.readPercent)}% reads / ${number(session.writePercent)}% writes · ${session.consistency || "-"} consistency`)}</p></div><dl><div><dt>Repetition</dt><dd>${number(session.repetition)}</dd></div><div><dt>Shared T0</dt><dd>${escapeHtml(startAt || "Pending")}</dd></div><div><dt>Operations / target</dt><dd>${number(session.scheduledOperationsPerTarget)}</dd></div></dl></div>${sessionSchedule(session, status, startAt)}${sessionResultTable(run, session, result, status)}`;
}
function workloadStageDetail(run) {
  const rows = (run.matrix || []).map((session, index) => { const status = sessionState(run, session), result = (run.sessionResults || []).find(item => item.id === session.id); return `<tr><td>${index + 1}</td><td>${escapeHtml(session.name || session.configName || session.id)}</td><td>${number(session.readPercent)}% / ${number(session.writePercent)}%</td><td>${escapeHtml(session.consistency || "-")}</td><td>${number(session.repetition)}</td><td><span class="target-state ${escapeHtml(status)}">${escapeHtml(status === "not-run" ? "Not run" : status)}</span></td><td>${escapeHtml(result?.sharedStartAt || (run.currentSession?.id === session.id ? run.sharedStartAt : "Pending"))}</td></tr>`; }).join("");
  return `<div class="table-wrap stage-results"><table><thead><tr><th>#</th><th>Session</th><th>Read / write</th><th>Consistency</th><th>Rep.</th><th>Status</th><th>Shared T0</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function renderStageBrowserDetail(run, key) {
  const detail = $("stage-browser-detail");
  if (key.startsWith("session:")) { const session = (run.matrix || []).find(item => item.id === key.slice(8)), result = (run.sessionResults || []).find(item => item.id === session?.id); detail.innerHTML = session ? sessionStageDetail(run, session) : '<p class="stage-empty">Session metadata is unavailable.</p>'; renderOfferedLoadStageCharts(session, result); if (result) renderRunnerMetricCharts(result); return; }
  renderOfferedLoadStageCharts(null, null);
  const stage = (run.stages || []).find(item => item.name === key.slice(5));
  if (!stage) { detail.innerHTML = '<p class="stage-empty">Select a stage to inspect its evidence.</p>'; return; }
  const content = stage.name === "dataset-preload" ? preloadStageDetail(run) : stage.name === "dataset-certification" ? certificationStageDetail(run) : stage.name === "resource-validation" ? inventoryStageDetail(run) : stage.name === "workload" ? workloadStageDetail(run) : stage.name === "dataset-hash-match" && run.certificates ? certificationStageDetail(run) : stage.name === "package-generation" && run.downloadUrl ? `<a class="button-link" href="${escapeHtml(run.downloadUrl)}">Download benchmark output (.zip)</a>` : stage.status === "running" ? '<p class="stage-empty">This stage is active. Its results will remain available here after it completes.</p>' : stage.status === "pending" ? '<p class="stage-empty">This stage has not started yet.</p>' : stageTechnicalDetail(stage);
  detail.innerHTML = `<div class="stage-detail-heading"><div><span class="target-state ${escapeHtml(stage.status)}">${escapeHtml(stage.status)}</span><h5>${escapeHtml(runStageLabel(stage.name))}</h5><p>${stage.startedAt ? `Started ${escapeHtml(localDateTime(stage.startedAt))}${stage.completedAt ? ` · completed in ${escapeHtml(durationLabel(stage.startedAt, stage.completedAt))}` : ` · elapsed ${escapeHtml(durationLabel(stage.startedAt))}`}` : "Waiting to start"}</p></div></div>${content}`;
}
function renderStageBrowser(run) {
  const browser = $("stage-browser"), cloud = run.kind === "cloud-benchmark" || run.kind === "cloud-acceptance";
  if (!cloud) { browser.classList.add("hidden"); return; }
  browser.classList.remove("hidden");
  if (stageBrowserRunId !== run.id) { stageBrowserRunId = run.id; selectedStageKey = null; }
  const stages = run.stages || [], sessions = run.matrix || [], activeStage = stages.find(item => item.status === "running"), activeSession = run.currentSession?.id;
  const keys = [...stages.map(item => `gate:${item.name}`), ...sessions.map(item => `session:${item.id}`)];
  if (!selectedStageKey || !keys.includes(selectedStageKey)) selectedStageKey = activeSession ? `session:${activeSession}` : activeStage ? `gate:${activeStage.name}` : `gate:${stages.filter(item => item.status === "complete").at(-1)?.name || stages[0]?.name}`;
  const gateButtons = stages.map((stage, index) => `<button type="button" role="tab" aria-selected="${selectedStageKey === `gate:${stage.name}`}" class="stage-tab ${escapeHtml(stage.status)}${selectedStageKey === `gate:${stage.name}` ? " selected" : ""}" data-stage-key="gate:${escapeHtml(stage.name)}"><i>${stage.status === "complete" ? "✓" : stage.status === "failed" ? "!" : stage.status === "running" ? "●" : index + 1}</i><span>${escapeHtml(runStageLabel(stage.name))}</span></button>`).join("");
  const sessionButtons = sessions.map((session, index) => { const status = sessionState(run, session); return `<button type="button" role="tab" aria-selected="${selectedStageKey === `session:${session.id}`}" class="stage-tab session ${escapeHtml(status)}${selectedStageKey === `session:${session.id}` ? " selected" : ""}" data-stage-key="session:${escapeHtml(session.id)}"><i>${index + 1}</i><span>${escapeHtml(session.name || session.configName || session.id)}<small>rep ${number(session.repetition)}</small></span></button>`; }).join("");
  $("stage-browser-tabs").innerHTML = `<div class="stage-tab-group"><b>Pipeline gates</b><div>${gateButtons}</div></div><div class="stage-tab-group"><b>Workload sessions</b><div>${sessionButtons}</div></div>`;
  for (const button of document.querySelectorAll("[data-stage-key]")) button.addEventListener("click", () => { selectedStageKey = button.dataset.stageKey; renderStageBrowser(run); });
  renderStageBrowserDetail(run, selectedStageKey);
}
function elapsedLabel(run) {
  const start = Date.parse(run.startedAt || run.createdAt), end = Date.parse(run.completedAt || new Date().toISOString());
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "-";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m` : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
function filteredRunHistory() {
  const status = value("run-history-status");
  if (status === "all") return runHistory;
  if (status === "non-failed") return runHistory.filter(run => run.status !== "failed");
  return runHistory.filter(run => run.status === status);
}
function renderRunHistoryList({ preserveSelection = true } = {}) {
  const select = $("run-history-select"), previous = preserveSelection ? select.value : "", runs = filteredRunHistory();
  select.replaceChildren(...runs.map(run => new Option(`${run.id === runHistory.find(item => !terminalRunStatuses.has(item.status))?.id ? "LIVE · " : ""}${new Date(run.createdAt).toLocaleString()} · ${run.status.toUpperCase()} · ${run.id}`, run.id)));
  if (previous && runs.some(run => run.id === previous)) select.value = previous;
  else if (runs.length) select.value = runs[0].id;
  else select.append(new Option("No runs match this filter", ""));
  const pageCount = Math.max(1, Math.ceil(runs.length / runHistoryPageSize));
  if (preserveSelection && select.value) { const selectedIndex = runs.findIndex(run => run.id === select.value); if (selectedIndex >= 0) runHistoryPage = Math.floor(selectedIndex / runHistoryPageSize) + 1; }
  runHistoryPage = Math.min(Math.max(1, runHistoryPage), pageCount);
  const offset = (runHistoryPage - 1) * runHistoryPageSize, visibleRuns = runs.slice(offset, offset + runHistoryPageSize);
  $("run-history-summary").textContent = `${number(runs.length)} execution${runs.length === 1 ? "" : "s"} · ${number(runs.filter(run => !terminalRunStatuses.has(run.status)).length)} active`;
  $("run-history-page-summary").textContent = runs.length ? `${number(offset + 1)}–${number(Math.min(offset + runHistoryPageSize, runs.length))} of ${number(runs.length)} · page ${number(runHistoryPage)} of ${number(pageCount)}` : "No executions";
  $("run-history-prev").disabled = runHistoryPage <= 1;
  $("run-history-next").disabled = runHistoryPage >= pageCount;
  $("run-history-list").innerHTML = visibleRuns.map(run => { const completed = `${number(run.completedSessions)} / ${number(run.sessionCount)}`; return `<button type="button" class="run-history-row${select.value === run.id ? " selected" : ""}" data-run-id="${escapeHtml(run.id)}"><span class="run-history-state ${escapeHtml(run.status)}">${escapeHtml(run.status.toUpperCase())}</span><span><b>${escapeHtml(run.id)}</b><small>${escapeHtml(runKindLabel(run.kind))} · ${escapeHtml(new Date(run.createdAt).toLocaleString())}</small></span><span class="run-targets">${(run.targets || []).map(target => `<i class="run-target-chip" title="${escapeHtml(runTargetLabel(target))}">${providerMark(target)}<span>${escapeHtml(({ aws: "AWS", adb: "ADB", ndcs: "NoSQL" })[target] || target.toUpperCase())}</span></i>`).join("")}</span><span><b>${escapeHtml(completed)}</b><small>sessions</small></span><span><b>${escapeHtml(elapsedLabel(run))}</b><small>elapsed</small></span></button>`; }).join("") || '<p class="run-history-empty">No executions match this filter.</p>';
  for (const button of document.querySelectorAll("[data-run-id]")) button.addEventListener("click", () => { select.value = button.dataset.runId; void showHistoricalRun(button.dataset.runId); renderRunHistoryList(); });
}
function changeRunHistoryPage(delta) {
  const runs = filteredRunHistory(), pageCount = Math.max(1, Math.ceil(runs.length / runHistoryPageSize));
  runHistoryPage = Math.min(Math.max(1, runHistoryPage + delta), pageCount);
  const selected = runs[(runHistoryPage - 1) * runHistoryPageSize];
  if (selected) $("run-history-select").value = selected.id;
  renderRunHistoryList({ preserveSelection: true });
  if (selected) void showHistoricalRun(selected.id);
}
async function showHistoricalRun(id) {
  const detail = $("run-history-detail");
  if (!id) { detail.classList.add("hidden"); return; }
  detail.classList.remove("hidden"); detail.innerHTML = '<p class="run-history-empty">Loading run evidence...</p>';
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(id)}`, { cache: "no-store" }), run = await response.json();
    if (!response.ok) throw new Error(run.error || `Run lookup failed (${response.status})`);
    const cloud = run.kind === "cloud-benchmark" || run.kind === "cloud-acceptance", targets = cloud ? Object.keys(run.targetStatus || {}) : ["mock"], sessions = run.sessionResults || [];
    const rows = sessions.flatMap(session => { const matrix = (run.matrix || []).find(item => item.id === session.id) || {}; return Object.entries(session.summaries || {}).map(([target, summary]) => `<tr><td>${escapeHtml(session.id)}</td><td>${providerMark(target)} ${escapeHtml(runTargetLabel(target))}</td><td>${number(summary.completed)} / ${number(summary.scheduled)}</td><td>${number(summary.failed)}</td><td>${number(summary.achievedOperationsPerSecond)} ops/s</td><td>${number(matrix.payloadBytes ?? summary.dataset?.payloadBytes)} B payload / ${number(matrix.logicalItemBytes ?? summary.dataset?.logicalItemBytes)} B logical max</td><td>${number(summary.successfulServiceLatencyMs?.p95)} ms</td><td>${number(summary.successfulServiceLatencyMs?.p99)} ms</td></tr>`); }).join("");
    const workloadNames = [...new Set((run.matrix || []).map(item => item.name || item.configName).filter(Boolean))];
    detail.innerHTML = `<div class="historical-heading"><div><p class="eyebrow">HISTORICAL · READ-ONLY</p><h4>${escapeHtml(run.id)}</h4><p>${escapeHtml(runKindLabel(run.kind))} · started ${escapeHtml(new Date(run.startedAt || run.createdAt).toLocaleString())} · ${escapeHtml(elapsedLabel(run))}</p></div><span class="run-history-state ${escapeHtml(run.status)}">${escapeHtml(run.status.toUpperCase())}</span></div><div class="historical-facts"><div><span>Targets</span><b>${targets.map(target => `${providerMark(target)} ${escapeHtml(runTargetLabel(target))}`).join(" &nbsp; ")}</b></div><div><span>Sessions</span><b>${number(sessions.length)} / ${number(run.matrix?.length || (run.summary ? 1 : 0))}</b></div><div><span>Workloads</span><b>${escapeHtml(workloadNames.join(", ") || "Local functional test")}</b></div><div><span>Evidence</span><b>${run.downloadUrl ? `<a href="${escapeHtml(run.downloadUrl)}">Download ZIP</a>` : "Package not available"}</b></div></div>${run.error ? `<div class="historical-error">${escapeHtml(run.error)}</div>` : ""}${rows ? `<div class="table-wrap historical-results"><table><thead><tr><th>Session</th><th>Target</th><th>Accounted</th><th>Failed</th><th>Throughput</th><th>Item size</th><th>P95</th><th>P99</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="run-history-empty">No finalized workload sessions are available for this run. Its pipeline state and error are preserved above.</p>`}`;
  } catch (error) { detail.innerHTML = `<div class="historical-error">${escapeHtml(error.message)}</div>`; }
}
async function refreshRunHistory({ preserveSelection = true, quiet = false } = {}) {
  if (runHistoryPending) return;
  runHistoryPending = true;
  try {
    const response = await fetch("/api/runs", { cache: "no-store" });
    let payload = await response.json();
    if (response.status === 404) {
      const legacyResponse = await fetch("/api/runs/active", { cache: "no-store" }), legacy = await legacyResponse.json();
      if (!legacyResponse.ok) throw new Error(legacy.error || `Run history fallback failed (${legacyResponse.status})`);
      const candidates = [legacy.active, legacy.latest].filter(Boolean), unique = [...new Map(candidates.map(run => [run.id, run])).values()];
      payload = { items: unique.map(run => ({ id: run.id, kind: run.kind, mode: run.mode, status: run.status, createdAt: run.createdAt, startedAt: run.startedAt, completedAt: run.completedAt, targets: Object.keys(run.targetStatus || {}), sessionCount: run.matrix?.length || (run.summary ? 1 : 0), completedSessions: run.sessionResults?.length || (run.summary ? 1 : 0), workloadNames: [...new Set((run.matrix || []).map(item => item.name || item.configName).filter(Boolean))], currentSession: run.currentSession, error: run.error, downloadUrl: run.downloadUrl })) };
    } else if (!response.ok) throw new Error(payload.error || `Run history failed (${response.status})`);
    runHistory = payload.items || []; renderRunHistoryList({ preserveSelection });
    if (payload.activeRunId) await syncServerActiveRun(payload.activeRunId);
    if ($("run-history-select").value) await showHistoricalRun($("run-history-select").value);
  } catch (error) { if (!quiet) $("run-history-list").innerHTML = `<div class="historical-error">${escapeHtml(error.message)}</div>`; }
  finally { runHistoryPending = false; }
}

async function syncServerActiveRun(activeRunId = null) {
  try {
    let activeRun;
    if (activeRunId) {
      const response = await fetch(`/api/runs/${encodeURIComponent(activeRunId)}`, { cache: "no-store" }); activeRun = await response.json();
      if (!response.ok) throw new Error(activeRun.error || `Active run lookup failed (${response.status})`);
    } else {
      const response = await fetch("/api/runs/active", { cache: "no-store" }), payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Active run lookup failed (${response.status})`);
      activeRun = payload.active;
    }
    if (!activeRun || activeRun.id === terminalRunId) return;
    localStorage.setItem("kvs-dashboard-run-id", activeRun.id);
    if (wizardActive) showOperations();
    showSmoke(activeRun); void monitorRun(activeRun.id, activeRun.mode || "async", true);
  } catch { /* Background discovery must not disturb the operator's current view. */ }
}

function runMode() { return document.querySelector('input[name="run-mode"]:checked').value; }
const activeTarget = () => value("destination-product");
const targetDiscoveryEnabled = name => selectedTargets.has(name) || activeTarget() === name;
const cloudEnabled = name => name === "aws" ? targetDiscoveryEnabled("aws") : targetDiscoveryEnabled("adb") || targetDiscoveryEnabled("ndcs");
function setDiscoveryBusy(busy) {
  const button = $("discover-destinations");
  button.disabled = busy; button.classList.toggle("is-loading", busy); button.setAttribute("aria-busy", String(busy));
  button.textContent = busy ? "Refreshing resources..." : "Refresh available resources";
}
function syncCloudCatalog() {
  const target = activeTarget();
  for (const name of ["aws", "adb", "ndcs"]) document.querySelector(`article.provider.${name}`).hidden = name !== target;
  $("cloud-aws").checked = value("destination-cloud") === "aws";
  $("cloud-oci").checked = value("destination-cloud") === "oci";
}
function syncDestinationProducts() {
  const cloud = value("destination-cloud"), previous = activeTarget();
  const products = cloud === "aws" ? [["aws", "AWS DynamoDB"]] : [["adb", "ADB DynamoDB API"], ["ndcs", "OCI NoSQL"]];
  $("destination-product").replaceChildren(...products.map(([id, label]) => new Option(label, id)));
  if (products.some(([id]) => id === previous)) $("destination-product").value = previous;
  syncCloudCatalog();
}
function renderDestinationSummary() {
  if (!selectedTargets.size) { $("destination-summary").innerHTML = '<p class="empty-selection">No destinations added yet.</p>'; return; }
  const cards = [];
  for (const name of selectedTargets) {
    const resource = resourceValue(`${name}-table`);
    if (name === "aws") {
      const table = destinations?.awsTables?.find(item => (item.name || item) === resource);
      cards.push(detailCard(name, "AWS DynamoDB", typeof table === "string" ? { name: table } : table || { name: resource }, Boolean(table)));
    } else if (name === "adb") {
      const table = destinations?.adbTables?.find(item => (item.name || item) === resource);
      const recent = destinations?.recentEvidenceTables?.adb?.find(item => item.table === resource);
      cards.push(detailCard(name, "ADB DynamoDB API", typeof table === "string" ? { name: table } : table || { name: recent?.table || resource }, Boolean(table)));
    } else {
      const table = destinations?.nosqlTables?.find(item => item.name === resource);
      cards.push(detailCard(name, "OCI NoSQL", table || { name: resource }, Boolean(table)));
    }
  }
  $("destination-summary").innerHTML = cards.join("");
}
async function addDestination() {
  const name = activeTarget(), resource = resourceValue(`${name}-table`), runnerIds = selectedValues(`${name}-runner`), required = loadGeneratorCount();
  if (!resource || resource === "__manual__") throw new Error("Select a table before adding the destination");
  if (runnerIds.length !== required) throw new Error(`Select exactly ${required} distinct regional runner VM${required === 1 ? "" : "s"} for every target`);
  // Evidence only supplies a table name. Retrieve the selected ADB table's
  // metadata before rendering its card whenever it is not already live.
  if (name === "adb" && !destinations?.adbTables?.some(item => (item.name || item) === resource)) {
    await lookupDestinations({ manageButton: false, probeAdbTables: true });
  }
  selectedTargets.add(name); $("aws-enabled").checked = selectedTargets.has("aws"); $("adb-enabled").checked = selectedTargets.has("adb"); $("ndcs-enabled").checked = selectedTargets.has("ndcs");
  renderDestinationSummary(); renderDestinationDetails();
  $("runner-status").className = "callout"; $("runner-status").textContent = `${name.toUpperCase()} destination added. Choose another provider/product to add more.`;
  scheduleDraftSave();
}
function selectedValues(id) { return [...($(id)?.selectedOptions || [])].map(option => option.value).filter(Boolean); }
function loadGeneratorCount() { return Math.max(1, Number.parseInt(value("load-generator-count"), 10) || 1); }
function runnerPool(id) { return id.startsWith("aws-") ? discovered?.aws : id.startsWith("adb-") ? discovered?.adbOci : discovered?.ndcsOci; }
function selectedRunners(id) { const ids = new Set(selectedValues(id)); return (runnerPool(id) || []).filter(item => ids.has(item.id)); }
function selectedRunner(id) { return selectedRunners(id)[0] || {}; }
function runnerAddress(item) { const addresses = [item.privateIp || item.privateIpAddress || item.ipAddress, item.publicIp || item.publicIpAddress].filter(Boolean); return addresses.join(" / ") || "IP pending discovery"; }
function runnerSpec(item) { return { id: item.id, compartmentId: item.compartmentId, privateIp: item.privateIp || item.privateIpAddress || item.ipAddress, publicIp: item.publicIp || item.publicIpAddress, egressIp: item.egressIp, egressIpVerified: item.egressIpVerified === true, displayName: item.name || item.displayName, availabilityDomain: item.availabilityDomain || item.availabilityZone || item.placement, shape: item.shape || item.instanceType, vcpus: item.vcpus, memoryGB: item.memoryGB, networkMode: item.networkMode }; }
function targetRunnerFields(id) {
  const runners = selectedRunners(id), runnerIds = runners.map(item => item.id), runnerCompartmentIds = runners.map(item => item.compartmentId || null);
  return { runnerId: runnerIds[0] || "", runnerIds, runnerCompartmentId: runnerCompartmentIds[0], runnerCompartmentIds, runners: runners.map(runnerSpec) };
}
function resourceValue(prefix) { return value(prefix) === "__manual__" ? value(`${prefix}-manual`) : value(prefix); }
function specification() {
  const mode = document.querySelector('input[name="infra-mode"]:checked').value;
  const awsRunners = targetRunnerFields("aws-runner"), adbRunners = targetRunnerFields("adb-runner"), ndcsRunners = targetRunnerFields("ndcs-runner");
  const adbDatabase = (destinations?.autonomousDatabases || []).find(item => item.id === value("adb-database")) || {};
  const configs = [...document.querySelectorAll('input[name="config"]:checked')].map(input => input.value);
  const repetitionsByFile = Object.fromEntries([...document.querySelectorAll(".preset-repetitions")].map(input => [input.dataset.config, Number(input.value)]));
  const presetRepetitions = Object.fromEntries(configs.map(file => [file, repetitionsByFile[file] || 1]));
  const presetOverrides = Object.fromEntries([...document.querySelectorAll("#configs tr")].map(row => {
    const readPercent = Number(row.querySelector(".preset-read-percent").value), model = row.dataset.model;
    const item = { readPercent, writePercent: 100 - readPercent, consistency: row.querySelector(".preset-consistency").value, durationSeconds: Number(row.querySelector(".preset-duration").value) };
    if (item.writePercent > 0) item.writeMode = "idempotent";
    if (model === "open-loop") item.rateMultiplier = Number(row.querySelector(".preset-load").value);
    else item.fixedConcurrency = Number(row.querySelector(".preset-concurrency").value);
    return [row.dataset.config, item];
  }));
  return { schemaVersion: 1, infrastructure: mode === "managed" ? { mode, repositoryPath: value("infra-repo"), gitRef: value("infra-ref"), terraformWorkspace: value("infra-workspace"), apply: false } : { mode }, targets: { aws: { enabled: selectedTargets.has("aws"), profile: value("aws-profile"), region: value("aws-region"), resource: resourceValue("aws-table"), ...awsRunners }, adb: { enabled: selectedTargets.has("adb"), profile: value("adb-profile"), region: value("adb-region"), resource: resourceValue("adb-table"), databaseId: value("adb-database"), databaseVersion: adbDatabase.dbVersion, workload: adbDatabase.workload, computeModel: adbDatabase.computeModel, computeCount: adbDatabase.computeCount ?? adbDatabase.cpuCoreCount, licenseModel: adbDatabase.licenseModel, ...adbRunners, compartmentId: value("adb-compartment"), evidenceBucket: value("adb-artifact-bucket") }, ndcs: { enabled: selectedTargets.has("ndcs"), profile: value("ndcs-profile"), region: value("ndcs-region"), resource: resourceValue("ndcs-table"), ...ndcsRunners, compartmentId: value("ndcs-compartment"), evidenceBucket: value("ndcs-artifact-bucket") } }, configs, presetRepetitions, presetOverrides, overrides: {}, execution: { mode: runMode(), mutableParameters: false, loadGeneratorCount: loadGeneratorCount(), t0LeadSeconds: optionalNumber("t0-lead-seconds"), capturePreloadMetrics: $("capture-preload-metrics").checked, preloadRate: optionalNumber("preload-rate"), preloadMaxInflight: optionalNumber("preload-max-inflight"), preloadMaxAttempts: optionalNumber("preload-max-attempts"), preloadRetryDelayMs: optionalNumber("preload-retry-delay-ms") }, artifactBucket: value("artifact-bucket"), imageDigest: value("image-digest"), writeAuthorization: $("write-authorization").checked };
}

function runnerOptions(select, values, preferredPattern) {
  const list = Array.isArray(values) ? values.filter(item => item && typeof item === "object") : [];
  const previous = new Set(selectedValues(select.id)), required = loadGeneratorCount();
  select.replaceChildren(...list.map(item => { const blocked = incompatibleRunners.has(item.id), addresses = [item.privateIp || item.privateIpAddress || item.ipAddress, item.publicIp || item.publicIpAddress].filter(Boolean).join(" / ") || "IP pending"; const option = new Option(`${item.name || item.displayName || "Unnamed"} | ${addresses} | ${item.placement || item.availabilityDomain || "unknown"} | ${item.remoteControl || "unknown"}${blocked ? " | INCOMPATIBLE: replace or repair" : ""}`, item.id || ""); option.disabled = blocked; option.selected = previous.has(item.id); return option; }));
  const compatible = list.filter(item => !incompatibleRunners.has(item.id)), preferred = compatible.find(item => preferredPattern.test(item.name || item.displayName || ""));
  const chosen = [...select.selectedOptions].filter(option => !option.disabled).slice(0, required);
  const preferredOption = preferred ? [...select.options].find(option => option.value === preferred.id) : null; if (!chosen.length && preferredOption) { preferredOption.selected = true; chosen.push(preferredOption); }
  for (const option of select.options) if (!option.disabled && chosen.length < required && option.selected && !chosen.includes(option)) chosen.push(option);
  for (const option of select.options) if (!option.disabled && chosen.length < required && !option.selected) { option.selected = true; chosen.push(option); }
  for (const option of select.options) if (!chosen.includes(option)) option.selected = false;
  updateRunnerSelectionStatus(select.id.replace("-runner", ""));
}
function configureRunnerSelects() {
  for (const id of runnerSelectIds) {
    const select = $(id), target = id.replace("-runner", ""), label = select.closest("label");
    select.multiple = true; select.size = 5; select.setAttribute("aria-describedby", `${target}-runner-selection`);
    const textNode = [...label.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim()); if (textNode) textNode.textContent = "";
    const heading = document.createElement("span"); heading.className = "label-line"; heading.textContent = "Regional load generators"; label.insertBefore(heading, select);
    const status = document.createElement("small"); status.id = `${target}-runner-selection`; status.className = "runner-selection-status"; select.after(status);
  }
}
function updateRunnerSelectionStatus(target) {
  const targets = target ? [target] : ["aws", "adb", "ndcs"], required = loadGeneratorCount();
  for (const name of targets) {
    const status = $(`${name}-runner-selection`); if (!status) continue;
    const runners = selectedRunners(`${name}-runner`), identities = runners.map(item => `${item.name || item.displayName || compactResourceId(item.id)} (${runnerAddress(item)})`);
    status.classList.toggle("invalid", runners.length !== required);
    status.textContent = `${runners.length} of ${required} selected${identities.length ? ` · ${identities.join(", ")}` : ""}`;
  }
}
function synchronizeRunnerCounts() {
  const required = loadGeneratorCount();
  for (const id of runnerSelectIds) {
    const select = $(id), chosen = [...select.selectedOptions].filter(option => !option.disabled).slice(0, required);
    for (const option of select.options) if (!option.disabled && chosen.length < required && !chosen.includes(option)) chosen.push(option);
    for (const option of select.options) option.selected = chosen.includes(option);
  }
  updateRunnerSelectionStatus(); renderDestinationSummary(); renderDestinationDetails(); scheduleDraftSave();
}
function flagIncompatibleRunner(run) {
  if (run.status !== "failed" || !/ocarun user requires passwordless access to Podman/i.test(run.error || "")) return;
  const target = /-adb-preflight/i.test(run.error) ? "adb" : /-ndcs-preflight/i.test(run.error) ? "ndcs" : null; if (!target) return;
  const runner = value(`${target}-runner`); if (!runner || incompatibleRunners.has(runner)) return;
  incompatibleRunners.add(runner); localStorage.setItem(incompatibleRunnerKey, JSON.stringify([...incompatibleRunners]));
  const option = [...$(`${target}-runner`).options].find(item => item.value === runner); if (option) { option.disabled = true; option.textContent += " | INCOMPATIBLE: replace or repair"; }
  selectedTargets.delete(target); $(`${target}-enabled`).checked = false; $(`${target}-runner`).value = ""; renderDestinationSummary(); scheduleDraftSave();
}
function flagDiscoveredIncompatibleRunner(target, runner, message) {
  if (!runner || !/Runner incompatible:/i.test(message || "")) return;
  incompatibleRunners.add(runner); localStorage.setItem(incompatibleRunnerKey, JSON.stringify([...incompatibleRunners]));
  const select = $(`${target}-runner`), option = [...select.options].find(item => item.value === runner); if (option) { option.disabled = true; if (!/INCOMPATIBLE/.test(option.textContent)) option.textContent += " | INCOMPATIBLE: replace or repair"; }
  selectedTargets.delete(target); $(`${target}-enabled`).checked = false; select.value = ""; renderDestinationSummary(); scheduleDraftSave();
}

async function discoverRunners({ manageButton = true } = {}) {
  if (manageButton) setDiscoveryBusy(true); $("runner-status").className = "callout"; $("runner-status").textContent = "Step 1/2: checking cloud identities, runners, remote-control health, placement, and evidence buckets...";
  try {
    if (!cloudEnabled("aws") && !cloudEnabled("oci")) throw new Error("Select at least one cloud provider");
    const fetchInventory = async (ociProfile, ociRegion, clouds) => { const response = await fetch("/api/discover-runners", { method: "POST", headers: { "content-type": "application/json", "x-kvs-csrf": bootstrap.csrfToken }, body: JSON.stringify({ awsProfile: value("aws-profile"), awsRegion: value("aws-region"), ociProfile, ociRegion, clouds }) }); const result = await response.json(); if (!response.ok) throw new Error(result?.error || `Discovery failed (${response.status})`); return result; };
    const adbContext = { profile: value("adb-profile"), region: value("adb-region") }, ndcsContext = { profile: value("ndcs-profile"), region: value("ndcs-region") };
    const adbResult = await fetchInventory(adbContext.profile, adbContext.region, { aws: cloudEnabled("aws"), oci: cloudEnabled("oci") }), sameOciContext = adbContext.profile === ndcsContext.profile && adbContext.region === ndcsContext.region;
    const ndcsResult = !cloudEnabled("oci") || sameOciContext ? adbResult : await fetchInventory(ndcsContext.profile, ndcsContext.region, { aws: false, oci: true });
    const adbOci = Array.isArray(adbResult?.oci) ? adbResult.oci : [], ndcsOci = Array.isArray(ndcsResult?.oci) ? ndcsResult.oci : [];
    discovered = { aws: Array.isArray(adbResult?.aws) ? adbResult.aws : [], adbOci, ndcsOci, oci: [...new Map([...adbOci, ...ndcsOci].map(item => [item.id, item])).values()], artifactBuckets: Array.isArray(adbResult?.artifactBuckets) ? adbResult.artifactBuckets : [] };
    runnerOptions($("aws-runner"), discovered.aws, /aws.*runner|runner.*aws/i); runnerOptions($("adb-runner"), discovered.adbOci, /adb.*runner/i); runnerOptions($("ndcs-runner"), discovered.ndcsOci, /ndcs|nosql/i);
    $("artifact-bucket").replaceChildren(new Option("Select an evidence bucket", ""), ...(discovered.artifactBuckets || []).map(name => new Option(name, name))); if (discovered.artifactBuckets?.length === 1) $("artifact-bucket").value = discovered.artifactBuckets[0];
    $("runner-status").className = "callout"; $("runner-status").innerHTML = `<b>Discovery complete.</b> ${discovered.aws.length} AWS, ${discovered.adbOci.length} ADB-profile OCI, and ${discovered.ndcsOci.length} NoSQL-profile OCI runner(s); ${discovered.artifactBuckets.length} evidence bucket(s).`; return true;
  } catch (error) { $("runner-status").className = "callout error"; $("runner-status").textContent = error?.message || String(error); return false; }
  finally { if (manageButton) setDiscoveryBusy(false); }
}

function lookupOptions(select, items, { label = item => item?.name || item, getValue = item => item?.id || item, placeholder = "Select a discovered value", manual = false, preferred } = {}) {
  if (!select) throw new Error("Destination form is out of date; reload the dashboard page");
  const list = Array.isArray(items) ? items.filter(item => item != null) : [];
  const normalized = list.map(item => ({ label: String(label(item) ?? "Unnamed"), value: String(getValue(item) ?? "") }));
  const selectedValue = preferred != null && normalized.some(item => item.value === String(preferred)) ? String(preferred) : normalized.length === 1 ? normalized[0].value : "";
  const optionHtml = [{ label: placeholder, value: "" }, ...normalized, ...(manual ? [{ label: "Enter manually...", value: "__manual__" }] : [])]
    .map(item => `<option value="${escapeHtml(item.value)}"${item.value === selectedValue ? " selected" : ""}>${escapeHtml(item.label)}</option>`).join("");
  select.innerHTML = optionHtml;
}

function syncManual(prefix) { $(`${prefix}-manual-wrap`).hidden = value(prefix) !== "__manual__"; }
function filterOptions(input) { const select = $(input.dataset.filterFor), query = input.value.trim().toLowerCase(), selected = new Set(selectedValues(select.id)); if (!select) return; for (const option of select.options) option.hidden = Boolean(query) && !selected.has(option.value) && !option.textContent.toLowerCase().includes(query); }
function bytes(value, fallback = "Not exposed by provider inventory") { if (value == null) return fallback; const units = ["B", "KB", "MB", "GB", "TB"]; let amount = Number(value), unit = 0; while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; } return `${number(amount)} ${units[unit]}`; }
function autoscalingLabel(table) {
  if (table?.billingMode === "PAY_PER_REQUEST") return "On-demand / service managed";
  if (table?.autoscaling?.mode === "SERVICE_MANAGED") return "Service managed";
  const read = table?.autoscaling?.read, write = table?.autoscaling?.write;
  if (read || write) return [read && `Read ${read.min}-${read.max}`, write && `Write ${write.min}-${write.max}`].filter(Boolean).join("; ");
  return table?.autoscaling?.mode === "NOT_DETECTED" ? "Not configured / not exposed" : "Not configured";
}
function providerMark(target) {
  if (target === "aws") return '<span class="provider-mark provider-mark-aws" role="img" aria-label="AWS"><svg viewBox="0 0 48 28" aria-hidden="true"><text x="2" y="17">aws</text><path d="M4 22c10 6 26 5 38-2"/></svg></span>';
  return '<span class="provider-mark provider-mark-oracle" role="img" aria-label="Oracle Cloud"><svg viewBox="0 0 40 28" aria-hidden="true"><rect x="3" y="6" width="34" height="16" rx="8"/></svg></span>';
}
function detailCard(target, provider, table, verified = true) {
  if (!table) return "";
  const unavailable = verified ? "Not exposed by provider inventory" : "Not live-verified";
  const mode = verified ? table.billingMode || table.capacityMode || unavailable : unavailable;
  const readValue = table.readCapacityUnits != null ? `${number(table.readCapacityUnits)} RCU` : table.readUnits != null ? `${number(table.readUnits)} RU` : unavailable;
  const writeValue = table.writeCapacityUnits != null ? `${number(table.writeCapacityUnits)} WCU` : table.writeUnits != null ? `${number(table.writeUnits)} WU` : unavailable;
  const storageLimit = provider === "OCI NoSQL" && table.storageGB != null ? `${number(table.storageGB)} GB` : provider === "AWS DynamoDB" ? "Not table-configurable" : provider === "ADB DynamoDB API" ? "Database-scoped, not table-scoped" : unavailable;
  const rows = [
    ["Status", verified ? table.status || table.state || unavailable : unavailable],
    ["Capacity mode", mode],
    ["Read capacity", verified ? readValue : unavailable],
    ["Write capacity", verified ? writeValue : unavailable],
    ["Autoscaling", verified ? autoscalingLabel(table) : unavailable],
    ["Current table size", verified ? bytes(table.tableSizeBytes) : unavailable],
    ["Storage limit", storageLimit],
    ["Item count", verified ? table.itemCount == null ? unavailable : number(table.itemCount) : unavailable]
  ];
  const verification = verified ? "" : `<div class="resource-verification"><span>The name came from local evidence. Select the ADB runner and refresh available resources to retrieve live metadata automatically.</span></div>`;
  return `<article class="resource-detail provider-${escapeHtml(target)}"><div class="resource-detail-heading"><h3>${providerMark(target)}<span>${escapeHtml(provider)} · ${escapeHtml(table.name)}</span></h3><button type="button" data-remove-destination="${target}" aria-label="Remove ${escapeHtml(provider)}">×</button></div><p>${verified ? "Live provider metadata" : "Selected destination · not live-verified"}</p><dl>${rows.map(([key, item]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(item)}</dd>`).join("")}</dl>${verification}</article>`;
}
function renderDestinationDetails() {
  renderDestinationSummary();
}

async function lookupDestinations({ manageButton = true, probeAdbTables = true } = {}) {
  if (manageButton) setDiscoveryBusy(true); $("runner-status").className = "callout"; $("runner-status").textContent = "Step 2/2: reading accessible compartments, databases, tables, and evidence stores without modifying them...";
  let stage = "initialization";
  try {
    if (!bootstrap?.csrfToken) throw new Error("Dashboard session is not ready; reload the page");
    stage = "runner discovery";
    if (!discovered && (targetDiscoveryEnabled("adb") || targetDiscoveryEnabled("ndcs"))) {
      const ready = await discoverRunners();
      if (!ready) throw new Error("Runner discovery did not complete; see the discovery message and retry");
    }
    stage = "request preparation";
    const adbRunner = selectedRunner("adb-runner"), ndcsRunner = selectedRunner("ndcs-runner");
    const previous = { awsTable: resourceValue("aws-table"), adbTable: resourceValue("adb-table"), ndcsTable: resourceValue("ndcs-table") };
    const request = { awsProfile: value("aws-profile"), awsRegion: value("aws-region"), adbOciProfile: value("adb-profile"), adbOciRegion: value("adb-region"), ndcsOciProfile: value("ndcs-profile"), ndcsOciRegion: value("ndcs-region"), adbCompartmentId: value("adb-compartment") || adbRunner.compartmentId, ndcsCompartmentId: value("ndcs-compartment") || ndcsRunner.compartmentId, adbRunnerId: adbRunner.id, adbRunnerCompartmentId: adbRunner.compartmentId, probeAdbTables: probeAdbTables && targetDiscoveryEnabled("adb") && Boolean(adbRunner.id), targets: { aws: targetDiscoveryEnabled("aws"), adb: targetDiscoveryEnabled("adb"), ndcs: targetDiscoveryEnabled("ndcs") } };
    stage = "cloud inventory request";
    const response = await fetch("/api/discover-destinations", { method: "POST", headers: { "content-type": "application/json", "x-kvs-csrf": bootstrap.csrfToken }, body: JSON.stringify(request) });
    const result = await response.json(); if (!response.ok) throw new Error(result?.error || `Destination lookup failed (${response.status})`);
    stage = "response normalization";
    destinations = result && typeof result === "object" ? result : {};
    const previousAdbCompartment = request.adbCompartmentId, previousNdcsCompartment = request.ndcsCompartmentId;
    const adbCompartments = Array.isArray(destinations.adbCompartments) ? destinations.adbCompartments : [], ndcsCompartments = Array.isArray(destinations.ndcsCompartments) ? destinations.ndcsCompartments : [], awsTables = Array.isArray(destinations.awsTables) ? destinations.awsTables : [], databases = Array.isArray(destinations.autonomousDatabases) ? destinations.autonomousDatabases : [], adbTables = Array.isArray(destinations.adbTables) ? destinations.adbTables : [], recentAdbTables = Array.isArray(destinations.recentEvidenceTables?.adb) ? destinations.recentEvidenceTables.adb : [], nosqlTables = Array.isArray(destinations.nosqlTables) ? destinations.nosqlTables : [];
    stage = "ADB compartment rendering";
    lookupOptions($("adb-compartment"), adbCompartments, { label: item => item.path, preferred: previousAdbCompartment, placeholder: "Select an ADB-profile compartment" });
    stage = "OCI NoSQL compartment rendering";
    lookupOptions($("ndcs-compartment"), ndcsCompartments, { label: item => item.path, preferred: previousNdcsCompartment, placeholder: "Select a NoSQL-profile compartment" });
    stage = "AWS table rendering";
    lookupOptions($("aws-table"), awsTables, { getValue: item => item.name || item, label: item => typeof item === "string" ? item : `${item.name} | ${item.billingMode || "?"} | ${item.readCapacityUnits ?? "-"} RCU / ${item.writeCapacityUnits ?? "-"} WCU | ${bytes(item.tableSizeBytes)}`, placeholder: "Select an AWS table", manual: true, preferred: previous.awsTable });
    stage = "Autonomous Database rendering";
    lookupOptions($("adb-database"), databases, { label: item => `${item.name} | ${item.state} | ${item.dbVersion || "version ?"} | ${item.computeCount ?? item.cpuCoreCount ?? "?"} ${item.computeModel || "compute"} | ${item.licenseModel === "BRING_YOUR_OWN_LICENSE" ? "BYOL" : item.licenseModel || "license ?"}`, preferred: destinations.adbRuntimeDatabaseId, placeholder: "Select an Autonomous Database" });
    stage = "ADB DynamoDB-API table rendering";
    const liveAdbNames = new Set(adbTables.map(table => table.name || table));
    const adbTableChoices = [...adbTables.map(table => ({ table: table.name || table, label: `${table.name || table} · live${typeof table === "object" ? ` | ${table.billingMode || "?"} | ${table.readCapacityUnits ?? "-"} RCU / ${table.writeCapacityUnits ?? "-"} WCU | ${bytes(table.tableSizeBytes)}` : ""}` })), ...recentAdbTables.filter(item => !liveAdbNames.has(item.table)).map(item => ({ table: item.table, label: `${item.table} · recent local evidence${item.observedAt ? ` · ${item.observedAt.slice(0, 10)}` : ""}` }))];
    lookupOptions($("adb-table"), adbTableChoices, { getValue: item => item.table, label: item => item.label, placeholder: "Select a DynamoDB-API table", manual: true, preferred: previous.adbTable || recentAdbTables[0]?.table });
    if (adbTableChoices.length === 0) $("adb-table").value = "__manual__";
    stage = "OCI NoSQL table rendering";
    lookupOptions($("ndcs-table"), nosqlTables, { label: item => `${item.name} | ${item.state} | ${item.capacityMode || "?"} | ${item.readUnits ?? "?"} RU / ${item.writeUnits ?? "?"} WU | ${item.storageGB ?? "?"} GB limit`, getValue: item => item.name, placeholder: "Select an OCI NoSQL table", manual: true, preferred: previous.ndcsTable });
    stage = "evidence bucket rendering";
    lookupOptions($("adb-artifact-bucket"), destinations.adbEvidenceBuckets, { getValue: item => item, label: item => item, placeholder: "Select an ADB evidence bucket", preferred: value("adb-artifact-bucket") });
    lookupOptions($("ndcs-artifact-bucket"), destinations.ndcsEvidenceBuckets, { getValue: item => item, label: item => item, placeholder: "Select a NoSQL evidence bucket", preferred: value("ndcs-artifact-bucket") });
    stage = "manual destination synchronization";
    for (const prefix of ["aws-table", "adb-table", "ndcs-table"]) syncManual(prefix);
    renderDestinationDetails();
    const mismatch = destinations.adbRuntimeDatabaseId && value("adb-database") !== destinations.adbRuntimeDatabaseId, partialErrors = Object.entries(destinations.discoveryErrors || {});
    flagDiscoveredIncompatibleRunner("adb", adbRunner.id, destinations.discoveryErrors?.adbTables);
    const errorList = partialErrors.length ? `<ul>${partialErrors.map(([key, message]) => `<li><b>${escapeHtml(key)}:</b> ${escapeHtml(message)}</li>`).join("")}</ul>` : "";
    const countParts = [];
    if (request.targets.aws) countParts.push(`${awsTables.length} AWS table(s)`);
    if (request.targets.adb) countParts.push(`${adbCompartments.length} ADB-profile compartment(s)`, `${adbTables.length} live ADB DynamoDB-API table(s)`, `${recentAdbTables.length} recent ADB evidence candidate(s)`);
    if (request.targets.ndcs) countParts.push(`${ndcsCompartments.length} NoSQL-profile compartment(s)`, `${nosqlTables.length} OCI NoSQL table(s)`);
    const manualNote = request.targets.adb && !adbRunner.id ? " Select an ADB runner and refresh again to load live DynamoDB-API tables." : "";
    $("runner-status").className = `callout${mismatch || partialErrors.length ? " warning" : ""}`; $("runner-status").innerHTML = `<b>${partialErrors.length ? "Partial lookup complete." : "Lookup complete."}</b> ${countParts.join(", ")}.${manualNote}${mismatch ? " The selected ADB runner credentials belong to a database outside the selected compartment." : ""}${errorList}`;
  } catch (error) { console.error("Destination lookup failed", { stage, error }); $("runner-status").className = "callout error"; $("runner-status").textContent = `Destination lookup failed during ${stage}: ${error?.message || String(error)}`; }
  finally { if (manageButton) setDiscoveryBusy(false); }
}

async function discoverDestinations({ automatic = false } = {}) {
  setDiscoveryBusy(true);
  try {
    const ready = await discoverRunners({ manageButton: false });
    if (ready) await lookupDestinations({ manageButton: false, probeAdbTables: true });
  } finally { setDiscoveryBusy(false); }
}

function autoDiscoverActiveTarget() {
  if (!bootstrap) return null;
  if (automaticDiscovery) { automaticDiscoveryPending = true; return automaticDiscovery; }
  automaticDiscovery = discoverDestinations({ automatic: true }).finally(() => {
    automaticDiscovery = null;
    if (automaticDiscoveryPending) { automaticDiscoveryPending = false; void autoDiscoverActiveTarget(); }
  });
  return automaticDiscovery;
}

function renderReview() {
  const spec = specification(), enabled = Object.entries(spec.targets).filter(([, target]) => target.enabled); const targets = enabled.map(([name, target]) => `${name.toUpperCase()} (${target.profile || "no profile"}, ${target.region})`), sources = enabled.map(([name, target]) => `${name.toUpperCase()}: ${target.runners.map(runner => `${runner.displayName || compactResourceId(runner.id)} @ ${[runner.privateIp, runner.publicIp].filter(Boolean).join(" / ") || "IP pending"}`).join(", ") || "none"}`);
  const repetitions = Object.values(spec.presetRepetitions).reduce((sum, count) => sum + count, 0), cards = [["Targets", targets.join("; ") || "None"], ["Load generators", `${spec.execution.loadGeneratorCount} per target · ${spec.execution.loadGeneratorCount * enabled.length} source VM selection(s)`], ["Source identities", sources.join("; ") || "None"], ["Infrastructure", spec.infrastructure.mode], ["Workloads", `${spec.configs.length} preset(s), ${repetitions} session(s)`], ["Execution", `${spec.execution.mode}; immutable parameters`], ["Preset values", "Configured independently in the workload matrix"]];
  $("review-summary").innerHTML = cards.map(([label, item]) => `<div class="summary-card"><span>${escapeHtml(label)}</span><b>${escapeHtml(item)}</b></div>`).join("");
}
function validateRunnerSelections(spec) {
  const required = spec.execution.loadGeneratorCount;
  for (const [name, target] of Object.entries(spec.targets).filter(([, item]) => item.enabled)) {
    const distinct = new Set(target.runnerIds || []);
    if (distinct.size !== required) throw new Error(`${name.toUpperCase()} requires exactly ${required} distinct load-generator VM${required === 1 ? "" : "s"}; ${distinct.size} selected`);
  }
}

function setRunLock(locked) {
  runLocked = Boolean(locked);
  document.querySelectorAll("[data-go-step]").forEach(button => { button.disabled = runLocked; });
  for (const id of ["preview-button", "start-smoke", "start-benchmark", "write-authorization"]) {
    $(id).disabled = runLocked;
    $(id).setAttribute("aria-disabled", String(runLocked));
  }
  $("download").disabled = runLocked || !lastSpec;
  document.querySelector(".stepper").classList.toggle("run-locked", runLocked);
  $("new-benchmark").disabled = runLocked; $("new-benchmark").setAttribute("aria-disabled", String(runLocked));
  $("cancel-benchmark").disabled = runLocked;
  if (runLocked && wizardActive) showOperations();
}

function showStep(step) {
  if (runLocked) { showOperations(); return; }
  wizardActive = true; document.body.dataset.workspace = "wizard"; $("operations-dashboard").hidden = true; $("wizard-heading").hidden = false; document.querySelector(".stepper").hidden = false; $("wizard-heading").scrollIntoView({ block: "start" });
  currentStep = Math.max(1, Math.min(5, step)); document.querySelectorAll(".wizard-panel").forEach(panel => { panel.hidden = Number(panel.dataset.step) !== currentStep; });
  document.querySelectorAll(".stepper li").forEach((item, index) => { item.classList.toggle("active", index + 1 === currentStep); item.classList.toggle("done", index + 1 < currentStep); });
  $("back").disabled = currentStep === 1; $("next").hidden = currentStep === 5; $("step-label").textContent = `Step ${currentStep} of 5`;
  if (currentStep === 5 && !suppressPreview) { renderReview(); void preview(); }
  window.scrollTo({ top: 0, behavior: "smooth" });
  scheduleDraftSave();
}
function showOperations() {
  wizardActive = false; document.body.dataset.workspace = "operations"; $("operations-dashboard").hidden = false; $("wizard-heading").hidden = true; document.querySelector(".stepper").hidden = true; document.querySelectorAll(".wizard-panel").forEach(panel => { panel.hidden = true; }); document.querySelector(".wizard-actions").hidden = true;
  $("operations-dashboard").scrollIntoView({ block: "start" });
}
function beginNewBenchmark() {
  if (runLocked) return;
  document.querySelector(".wizard-actions").hidden = false; showStep(1);
}
function initializeWorkspaceShell() {
  const operations = $("operations-dashboard"), history = $("run-history-title")?.closest(".run-browser"), review = document.querySelector('.wizard-panel[data-step="5"]');
  if (history && review) {
    const nodes = [history, history.nextElementSibling, $("run-overview"), $("smoke-status"), $("session-status"), $("pipeline"), $("stage-browser"), $("live-stats"), $("execution-log")?.closest(".execution-console"), $("live-chart-panel"), $("stop-run")?.closest(".actions"), $("smoke-detail")?.closest(".technical-details")];
    for (const node of nodes) if (node && node !== operations && node.parentElement === review) operations.append(node);
    review.querySelector("hr")?.remove();
  }
  configureRunnerSelects(); showOperations();
}

function showPreview(preview) {
  const warnings = preview.warnings?.length ? `<ul>${preview.warnings.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "";
  $("preview-status").className = `callout${preview.warnings?.length ? " warning" : ""}`; $("preview-status").innerHTML = `<b>Valid immutable preview.</b> Infrastructure: ${escapeHtml(preview.infrastructure.mode)}. No cloud mutation was performed.${warnings}`;
  const values = [["Synchronized workload sessions", preview.totals.tripletSessions], ["Target executions", preview.totals.targetExecutions], ["Scheduled operations", preview.totals.totalScheduledOperations], ["Database minutes", preview.totals.totalDatabaseMinutes]];
  $("totals").innerHTML = values.map(([label, metric]) => `<div class="stat"><span>${escapeHtml(label)}</span><b>${number(metric)}</b></div>`).join("");
  $("matrix").innerHTML = preview.rows.map(row => `<tr><td>${escapeHtml(row.id)}</td><td>${escapeHtml(row.configFile)}</td><td>${escapeHtml(row.loadModel)}</td><td>${row.readPercent}/${row.writePercent}</td><td>${escapeHtml(row.consistency)}</td><td>${number(row.durationSeconds)} s</td><td>${number(row.payloadBytes)} B payload<br><small>${number(row.logicalItemBytes)} B logical max</small></td><td>${number(row.scheduledOperationsPerTarget)}</td><td>${number(row.averageScheduledOperationsPerSecond)}</td><td>${escapeHtml(row.targets.join(", "))}</td><td><code>${escapeHtml(row.configSha256.slice(0, 12))}...</code></td></tr>`).join("");
  $("download").disabled = false;
}

async function preview() {
  if (!bootstrap) return;
  try { lastSpec = specification(); validateRunnerSelections(lastSpec); renderReview(); const response = await fetch("/api/preview", { method: "POST", headers: { "content-type": "application/json", "x-kvs-csrf": bootstrap.csrfToken }, body: JSON.stringify(lastSpec) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || `Preview failed (${response.status})`); showPreview(result); }
  catch (error) { $("preview-status").className = "callout error"; $("preview-status").textContent = error.message; $("download").disabled = true; }
}

function downloadSpec() { const blob = new Blob([`${JSON.stringify(lastSpec, null, 2)}\n`], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `kvs-run-spec-${new Date().toISOString().replace(/[:.]/g, "-")}.json`; link.click(); URL.revokeObjectURL(link.href); }

const chartColors = { aws: "#ef7d00", adb: "#7b3fc6", ndcs: "#008c95", offered: "#3f4b5f" };
function enabledSeries() { return new Set([...document.querySelectorAll('#live-series-controls input:checked')].map(input => input.value)); }
function drawChart(canvas, series, emptyText, timelineLabel = null) {
  const context = canvas.getContext("2d"), width = canvas.width, height = canvas.height, margin = { left: 54, right: 18, top: 16, bottom: 34 };
  context.clearRect(0, 0, width, height); context.fillStyle = "#0b1017"; context.fillRect(0, 0, width, height);
  const active = series.filter(item => enabledSeries().has(item.name) && item.values.some(value => Number.isFinite(value)));
  if (!active.length) { context.fillStyle = "#7f8c9d"; context.font = "13px system-ui"; context.fillText(emptyText, 24, 42); return; }
  const maximum = Math.max(1, ...active.flatMap(item => item.values.filter(Number.isFinite))) * 1.1, points = Math.max(2, ...active.map(item => item.values.length));
  context.strokeStyle = "#26303d"; context.fillStyle = "#7f8c9d"; context.font = "11px ui-monospace, monospace"; context.textAlign = "right";
  for (let tick = 0; tick <= 4; tick += 1) { const y = margin.top + (height - margin.top - margin.bottom) * tick / 4; context.beginPath(); context.moveTo(margin.left, y); context.lineTo(width - margin.right, y); context.stroke(); context.fillText(number(maximum * (4 - tick) / 4), margin.left - 8, y + 4); }
  for (const item of active) { context.strokeStyle = chartColors[item.name]; context.lineWidth = item.name === "offered" ? 2 : 3; context.setLineDash(item.name === "offered" ? [8, 5] : []); context.beginPath(); item.values.forEach((value, index) => { if (!Number.isFinite(value)) return; const x = margin.left + (width - margin.left - margin.right) * index / (points - 1), y = height - margin.bottom - (height - margin.top - margin.bottom) * value / maximum; if (index === 0) context.moveTo(x, y); else context.lineTo(x, y); }); context.stroke(); }
  context.setLineDash([]); context.fillStyle = "#68758a"; context.textAlign = "center"; context.fillText(`0 s`, margin.left, height - 10); context.fillText(timelineLabel || `${Math.max(0, liveChartSamples.length - 1)} samples`, width - margin.right, height - 10);
}
function offeredAt(run, at) {
  const schedule = run.currentSession?.properties?.loadSchedule;
  if (!Array.isArray(schedule) || !run.sharedStartAt) return run.currentSession?.offeredOperationsPerSecond;
  let elapsed = Math.max(0, (new Date(at).getTime() - new Date(run.sharedStartAt).getTime()) / 1000);
  for (const step of schedule) { if (elapsed < Number(step.seconds)) return Number(step.operationsPerSecond); elapsed -= Number(step.seconds); }
  return Number(schedule.at(-1)?.operationsPerSecond);
}
function accounted(metric) { return Number(metric?.completed || 0) + Number(metric?.failed || 0); }
function observedLiveRate(target, metric, run) {
  const prior = [...liveChartSamples].reverse().find(sample => sample[target]?.at && sample[target].at !== metric?.at)?.[target];
  const fromAt = prior?.at || run.sharedStartAt, fromCount = prior ? accounted(prior) : 0;
  const seconds = (new Date(metric?.at).getTime() - new Date(fromAt).getTime()) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? Math.max(0, (accounted(metric) - fromCount) / seconds) : 0;
}
function hydrateLiveSamples(run) {
  const sessionId = run.currentSession?.id; if (!sessionId || (liveChartSession === sessionId && liveChartSamples.length)) return;
  liveChartSession = sessionId; const samples = new Map();
  for (const runnerSample of run.runnerMetricSamples || []) {
    const sample = samples.get(runnerSample.at) || { at: runnerSample.at, offered: offeredAt(run, runnerSample.at) };
    for (const [target, runner] of Object.entries(runnerSample.targets || {})) sample[target] = { ...(sample[target] || {}), at: runnerSample.at, runner };
    samples.set(runnerSample.at, sample);
  }
  for (const entry of run.logs || []) {
    if (entry.stage !== "workload" || !["aws", "adb", "ndcs"].includes(entry.target)) continue;
    const match = String(entry.message).match(/([\d,]+)\/([\d,]+) completed; ([\d.]+) ops\/s; p95 ([\d.-]+) ms; ([\d,]+) failed/);
    if (!match) continue;
    const at = entry.at, sample = samples.get(at) || { at, offered: offeredAt(run, at) };
    sample[entry.target] = { ...(sample[entry.target] || {}), completed: Number(match[1].replaceAll(",", "")), scheduled: Number(match[2].replaceAll(",", "")), operationsPerSecond: Number(match[3]), rollingP95Ms: match[4] === "-" ? null : Number(match[4]), failed: Number(match[5].replaceAll(",", "")) }; samples.set(at, sample);
  }
  liveChartSamples = [...samples.values()].sort((left, right) => left.at.localeCompare(right.at)).slice(-600);
  for (const target of ["aws", "adb", "ndcs"]) {
    let prior = null;
    for (const sample of liveChartSamples) {
      const metric = sample[target]; if (!metric) continue;
      if (metric.completed == null && metric.failed == null) { metric.operationsPerSecond = null; continue; }
      const fromAt = prior?.at || run.sharedStartAt, fromCount = prior ? accounted(prior) : 0, seconds = (new Date(metric.at || sample.at).getTime() - new Date(fromAt).getTime()) / 1000;
      metric.operationsPerSecond = Number.isFinite(seconds) && seconds > 0 ? Math.max(0, (accounted(metric) - fromCount) / seconds) : 0;
      metric.at ||= sample.at; prior = metric;
    }
  }
}
function renderLiveCharts() {
  const targets = ["aws", "adb", "ndcs"];
  drawChart($("throughput-chart"), [...targets.map(name => ({ name, values: liveChartSamples.map(sample => sample[name]?.operationsPerSecond) })), { name: "offered", values: liveChartSamples.map(sample => sample.offered) }], "Waiting for throughput samples...");
  drawChart($("latency-chart"), targets.map(name => ({ name, values: liveChartSamples.map(sample => sample[name]?.rollingP95Ms) })), "Waiting for latency samples...");
  const liveRunner = (key, transform = value => value) => targets.map(name => ({ name, values: liveChartSamples.map(sample => { const runner = sample[name]?.runner; if (!runner?.available) return null; if (key === "network") return transform(Number(runner.networkReceiveBytesPerSecond || 0) + Number(runner.networkTransmitBytesPerSecond || 0)); return transform(Number(runner[key])); }) }));
  if ($("runner-cpu-chart")) drawChart($("runner-cpu-chart"), liveRunner("cpuUtilizationPercent"), "Waiting for runner CPU samples...");
  if ($("runner-memory-chart")) drawChart($("runner-memory-chart"), liveRunner("memoryUtilizationPercent"), "Waiting for runner memory samples...");
  if ($("runner-load-chart")) drawChart($("runner-load-chart"), liveRunner("loadAverage1m"), "Waiting for runner load samples...");
  if ($("runner-network-chart")) drawChart($("runner-network-chart"), liveRunner("network", value => value * 8 / 1_000_000), "Waiting for runner network samples...");
  if (stageChartSession && stageChartResult) renderOfferedLoadStageCharts(stageChartSession, stageChartResult);
}
function syncLiveChartVisibility() {
  const live = runMode() === "live";
  $("live-chart-panel").classList.toggle("hidden", !live);
  if (live) { $("live-chart-caption").textContent = liveChartSamples.length ? $("live-chart-caption").textContent : "Waiting for the workload stage and the first runner sample."; renderLiveCharts(); }
}
function captureLiveSample(run) {
  const sessionId = run.currentSession?.id; if (!sessionId) return;
  if (liveChartSession !== sessionId) { liveChartSession = sessionId; liveChartSamples = []; }
  const metrics = run.targetMetrics || {}, sampleAt = Object.values(metrics).map(item => item.at).filter(Boolean).sort().at(-1);
  if (!sampleAt || liveChartSamples.at(-1)?.at === sampleAt) return;
  const normalized = Object.fromEntries(Object.entries(metrics).map(([target, metric]) => [target, { ...metric, operationsPerSecond: metric.provisional ? observedLiveRate(target, metric, run) : metric.operationsPerSecond }]));
  liveChartSamples.push({ at: sampleAt, offered: offeredAt(run, sampleAt), ...normalized });
  if (liveChartSamples.length > 600) liveChartSamples.shift();
  $("live-chart-caption").textContent = `${sessionId} | ${run.currentSession.durationSeconds} s | ${number(run.currentSession.offeredOperationsPerSecond)} offered ops/s | ${liveChartSamples.length} sample(s)`;
  renderLiveCharts();
}

function fallbackLogs(run) {
  return (run.stages || []).filter(stage => stage.status !== "pending").map(stage => ({ at: stage.completedAt || stage.startedAt || run.startedAt || run.createdAt, level: stage.status === "failed" ? "error" : stage.status === "complete" ? "success" : "info", stage: stage.name, target: "control", message: stage.detail || (stage.status === "running" ? "Stage running" : stage.status) }));
}
function terminalText(logs) {
  return logs.map(item => `${item.at || "-"} [${String(item.level || "info").toUpperCase()}] [${item.stage || "pipeline"}] [${item.target || "control"}] ${item.message || ""}`).join("\n");
}
function renderExecutionLog(run) {
  if (terminalRunId !== run.id) { terminalRunId = run.id; terminalClearedCount = 0; terminalPaused = false; $("pause-log").textContent = "Pause"; $("pause-log").setAttribute("aria-pressed", "false"); }
  terminalLogs = Array.isArray(run.logs) && run.logs.length ? run.logs : fallbackLogs(run);
  if (terminalPaused) return;
  const logs = terminalLogs.slice(terminalClearedCount), view = $("execution-log");
  if (!logs.length) view.innerHTML = '<div class="kvs-run-log-empty"><span>$</span> Waiting for the next pipeline event...</div>';
  else view.innerHTML = logs.map(item => { const timestamp = item.at ? new Date(item.at).toISOString().slice(11, 23) : "--:--:--.---"; return `<div class="kvs-run-log-line level-${escapeHtml(item.level || "info")}"><span class="kvs-run-log-time">${escapeHtml(timestamp)}</span><span class="kvs-run-log-level">${escapeHtml(item.level || "info")}</span><span class="kvs-run-log-stage">${escapeHtml(item.stage || "pipeline")}</span><span class="kvs-run-log-target">${escapeHtml(item.target || "control")}</span><span class="kvs-run-log-message">${escapeHtml(item.message || "")}</span></div>`; }).join("");
  if ($("log-autoscroll").checked) view.scrollTop = view.scrollHeight;
}

function showSmoke(run) {
  const progress = run.progress || {}; const terminal = ["complete", "failed", "stopped"].includes(run.status); const latency = run.summary?.successfulServiceLatencyMs || {};
  setRunLock(!terminal);
  const cloud = run.kind === "cloud-benchmark" || run.kind === "cloud-acceptance", session = run.currentSession, targetMetrics = run.targetMetrics || {};
  renderRunOverview(run); renderStageBrowser(run);
  const accounting = cloud ? ` | ${session ? `session ${escapeHtml(session.id)} (${session.index}/${session.total}) | ` : ""}shared T0 ${escapeHtml(run.sharedStartAt || "pending")}` : ` | ${number(progress.accounted)} of ${number(progress.scheduled)} operations accounted`;
  $("smoke-status").className = `callout run-status ${run.status}${run.status === "failed" ? " error" : ""}`; $("smoke-status").innerHTML = `<b>${escapeHtml(run.status.toUpperCase())}</b> | run ${escapeHtml(run.id)}${accounting}.${run.error ? ` ${escapeHtml(run.error)}` : ""}`;
  const matrixSession = session ? (run.matrix || []).find(item => item.id === session.id) : null, profileMetadata = matrixSession ? bootstrap?.configs?.find(item => item.file === matrixSession.configFile) : null;
  const sessionStatus = $("session-status"), properties = session?.properties || matrixSession || {};
  sessionStatus.classList.toggle("hidden", !session);
  if (session) {
    const schedule = Array.isArray(properties.loadSchedule) && properties.loadSchedule.length ? properties.loadSchedule.map(step => `${number(step.operationsPerSecond)} ops/s × ${number(step.seconds)} s`).join(" → ") : properties.fixedConcurrency ? `${number(properties.fixedConcurrency)} workers` : profileMetadata?.loadSummary || "Profile-defined";
    const detail = [["Read / write", `${number(properties.readPercent)}% / ${number(properties.writePercent)}%`], ["Consistency", properties.consistency], ["Load", `${properties.loadModel || "-"} · ${properties.executionMode || "-"}`], ["Schedule / concurrency", schedule], ["Duration", `${number(session.durationSeconds)} s`], ["Operations / target", number(properties.scheduledOperationsPerTarget)], ["Average offered", `${number(properties.averageScheduledOperationsPerSecond ?? session.offeredOperationsPerSecond)} ops/s`], ["Load generators", `${number(properties.loadGeneratorCount ?? session.loadGeneratorCount ?? run.loadGeneratorCount)} per target`], ["Max in-flight", number(properties.maxInflight)], ["Attempts / request", number(properties.maxAttempts)], ["Request timeout", `${number(properties.requestTimeoutMs)} ms`], ["Dataset", `${number(properties.keyCount)} keys`], ["Item size", `${number(properties.payloadBytes)} B payload · ${number(properties.logicalItemBytes)} B logical max`], ["Repetition", `${number(session.repetition)} · ${number(session.index)} of ${number(session.total)}`], ["Shared T0", run.sharedStartAt || "pending"]];
    const targetProgress = Object.values(targetMetrics).filter(metric => Number(metric.scheduled) > 0).map(metric => (Number(metric.completed || 0) + Number(metric.failed || 0)) * 100 / Number(metric.scheduled));
    const sessionPercent = targetProgress.length ? targetProgress.reduce((sum, item) => sum + item, 0) / targetProgress.length : 0;
    const matrixPercent = session.total ? (Number(run.sessionResults?.length || 0) + sessionPercent / 100) * 100 / session.total : 0;
    const fallbackDescription = `${number(properties.readPercent)}% reads / ${number(properties.writePercent)}% writes, ${properties.consistency || "-"} consistency; ${properties.loadModel || "-"} · ${properties.executionMode || "-"}; ${schedule}`;
    const visibleDetail = detail.filter(([, item]) => item != null && !String(item).includes("undefined") && !String(item).startsWith("- "));
    sessionStatus.innerHTML = `<p class="eyebrow">CURRENT EXECUTION</p><h3>${escapeHtml(session.name || matrixSession?.configName || session.id)}</h3><p>${escapeHtml(session.description || matrixSession?.description || fallbackDescription)}</p><div class="execution-progress"><div><b>Current session</b><span>${number(sessionPercent)}%</span></div><div class="pipeline-track" role="progressbar" aria-label="Current workload session progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${sessionPercent}"><span style="--pipeline-progress:${sessionPercent / 100}"></span></div><div><b>Complete matrix</b><span>${number(matrixPercent)}% · ${number(run.sessionResults?.length || 0)} of ${number(session.total)} sessions finalized</span></div><div class="pipeline-track" role="progressbar" aria-label="Complete benchmark matrix progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${matrixPercent}"><span style="--pipeline-progress:${matrixPercent / 100}"></span></div></div><div class="session-properties">${visibleDetail.map(([label, item]) => `<div><span>${escapeHtml(label)}</span><b>${escapeHtml(item)}</b></div>`).join("")}</div>`;
  }
  const stages = run.stages || [], processed = stages.filter(stage => ["complete", "failed"].includes(stage.status)).length, activeStage = stages.find(stage => stage.status === "running"), failedStage = stages.find(stage => stage.status === "failed"), progressUnits = processed + (activeStage ? 0.5 : 0), percentage = stages.length ? Math.round(progressUnits * 100 / stages.length) : 0, progressLabel = failedStage ? `Stopped at ${failedStage.name.replaceAll("-", " ")}` : activeStage ? `Running ${activeStage.name.replaceAll("-", " ")}` : percentage === 100 ? "All pipeline stages completed" : "Waiting to start";
  const pipelineHeadline = failedStage ? `FAILED AT ${failedStage.name.replaceAll("-", " ").toUpperCase()}` : `${percentage}%`;
  $("pipeline").innerHTML = stages.length ? `<div class="pipeline-summary${failedStage ? " has-failure" : ""}"><div class="pipeline-progress-heading"><div><b>${escapeHtml(pipelineHeadline)}</b><span>${failedStage ? `${percentage}% of gates reached` : escapeHtml(progressLabel)}</span></div><small>${processed} of ${stages.length} gates finalized</small></div><div class="pipeline-track" role="progressbar" aria-label="Benchmark pipeline" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percentage}"><span style="--pipeline-progress:${percentage / 100}"></span></div><ol class="pipeline-steps">${stages.map((stage, index) => { const symbol = stage.status === "complete" ? "✓" : stage.status === "failed" ? "!" : stage.status === "running" ? "●" : String(index + 1); return `<li class="${escapeHtml(stage.status)}" title="${escapeHtml(stage.detail || stage.status)}"><span>${symbol}</span><b>${escapeHtml(stage.name.replaceAll("-", " "))}</b></li>`; }).join("")}</ol></div>` : "";
  const showLiveChart = cloud && Boolean(session || Object.keys(targetMetrics).length); $("live-chart-panel").classList.toggle("hidden", !showLiveChart); if (showLiveChart) { hydrateLiveSamples(run); captureLiveSample(run); $("live-chart-caption").textContent = session ? `${session.id} · compare targets or hide series using the controls` : `Workload comparison · run ${run.status}`; renderLiveCharts(); }
  if (cloud && Object.keys(targetMetrics).length) $("live-stats").innerHTML = Object.entries(targetMetrics).map(([target, metric]) => { const accountedTotal = accounted(metric), percent = metric.scheduled ? accountedTotal * 100 / metric.scheduled : 0, completion = metric.scheduled ? `${number(accountedTotal)} / ${number(metric.scheduled)}` : number(accountedTotal), provider = { aws: "AWS DynamoDB", adb: "ADB DynamoDB API", ndcs: "OCI NoSQL" }[target] || target.toUpperCase(), liveRate = liveChartSamples.at(-1)?.[target]?.operationsPerSecond ?? metric.operationsPerSecond, values = [["Accounted", completion], ["Failed", number(metric.failed)], [metric.provisional ? "Current throughput" : "Average throughput", `${number(metric.provisional ? liveRate : metric.operationsPerSecond)} ops/s`], ["In flight", number(metric.inFlight)], [metric.provisional ? "Rolling P95" : "Final P95", `${number(metric.rollingP95Ms ?? metric.p95)} ms`], ["Latest latency", `${number(metric.latestLatencyMs)} ms`]]; if (!metric.provisional) values.push(["Final P99", `${number(metric.p99)} ms`], ["Final max", `${number(metric.max)} ms`]); return `<section class="target-live provider-${escapeHtml(target)}"><div class="target-live-heading"><h4>${providerMark(target)}<span>${escapeHtml(provider)}</span></h4><span>${metric.provisional ? "LIVE PREVIEW" : "FINAL"}</span><b>${number(percent)}%</b></div><div class="pipeline-track" role="progressbar" aria-label="${escapeHtml(provider)} progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="--pipeline-progress:${percent / 100}"></span></div><div class="target-metrics">${values.map(([label, item]) => `<div><span>${escapeHtml(label)}</span><b>${escapeHtml(item)}</b></div>`).join("")}</div></section>`; }).join("");
  else { const cloudCompleted = run.summaries ? Object.values(run.summaries).reduce((sum, item) => sum + item.completed, 0) : null; const values = [["Completed", cloudCompleted ?? progress.completed ?? 0], ["Failed", progress.failed ?? (run.summaries ? Object.values(run.summaries).reduce((sum, item) => sum + item.failed, 0) : 0)], ["Current ops/s", progress.achievedOperationsPerSecond ?? run.summary?.achievedOperationsPerSecond], ["In flight", progress.inFlight ?? 0], ["Latest latency ms", progress.latestLatencyMs], ["Final P95 ms", latency.p95]]; $("live-stats").innerHTML = values.map(([label, metric]) => `<div class="stat"><span>${escapeHtml(label)}</span><b>${number(metric)}</b></div>`).join(""); }
  renderExecutionLog(run);
  flagIncompatibleRunner(run);
  $("smoke-detail").textContent = JSON.stringify({ kind: run.kind, mode: run.mode, status: run.status, startedAt: run.startedAt, completedAt: run.completedAt, targetStatus: run.targetStatus, certificates: run.certificates, summaries: run.summaries, evidence: run.output, latestOperation: progress.latestOperation, latestError: progress.latestError }, null, 2);
  $("download-output").classList.toggle("hidden", !run.downloadUrl); if (run.downloadUrl) $("download-output").href = run.downloadUrl;
  $("stop-run").classList.toggle("hidden", terminal || !run.canStop); $("stop-run").disabled = run.status === "stopping";
  $("resume-run").classList.toggle("hidden", !run.canResume); $("resume-run").disabled = !run.canResume;
  $("start-smoke").disabled = !terminal; $("start-benchmark").disabled = !terminal; if (terminal) localStorage.removeItem("kvs-dashboard-run-id");
}

async function monitorRun(id, mode, restoring = false) {
  try { let terminal = false; while (!terminal) { const response = await fetch(`/api/runs/${encodeURIComponent(id)}`, { cache: "no-store" }); const run = await response.json(); if (!response.ok) throw new Error(run.error || `Status failed (${response.status})`); showSmoke(run); terminal = ["complete", "failed", "stopped"].includes(run.status); if (!terminal) await pause(mode === "live" ? 200 : 1000); } await refreshRunHistory({ preserveSelection: true, quiet: true }); }
  catch (error) { if (!restoring) { $("smoke-status").className = "callout error"; $("smoke-status").textContent = error.message; } localStorage.removeItem("kvs-dashboard-run-id"); $("start-smoke").disabled = false; $("start-benchmark").disabled = false; }
}

async function startSmoke() {
  if (runLocked) return;
  $("start-smoke").disabled = true; $("start-benchmark").disabled = true; $("download-output").classList.add("hidden"); $("smoke-status").className = "callout"; $("smoke-status").textContent = "Submitting local smoke test...";
  try { const mode = runMode(); const response = await fetch("/api/local-smoke", { method: "POST", headers: { "content-type": "application/json", "x-kvs-csrf": bootstrap.csrfToken }, body: JSON.stringify({ mode }) }); const run = await response.json(); if (!response.ok) throw new Error(run.error || `Start failed (${response.status})`); localStorage.setItem("kvs-dashboard-run-id", run.id); showSmoke(run); await monitorRun(run.id, mode); }
  catch (error) { $("smoke-status").className = "callout error"; $("smoke-status").textContent = error.message; $("start-smoke").disabled = false; $("start-benchmark").disabled = false; }
}

async function startCloud() {
  if (runLocked) return;
  $("start-smoke").disabled = true; $("start-benchmark").disabled = true; $("download-output").classList.add("hidden"); $("smoke-status").className = "callout"; $("smoke-status").textContent = "Submitting cloud acceptance pipeline...";
  try { const spec = specification(); validateRunnerSelections(spec); const response = await fetch("/api/cloud-acceptance", { method: "POST", headers: { "content-type": "application/json", "x-kvs-csrf": bootstrap.csrfToken }, body: JSON.stringify(spec) }); const run = await response.json(); if (response.status === 409 && run.active) { localStorage.setItem("kvs-dashboard-run-id", run.active.id); showOperations(); showSmoke(run.active); await monitorRun(run.active.id, run.active.mode || "async"); return; } if (!response.ok) throw new Error(run.error || `Start failed (${response.status})`); localStorage.setItem("kvs-dashboard-run-id", run.id); showSmoke(run); await monitorRun(run.id, runMode()); }
  catch (error) { $("smoke-status").className = "callout error"; $("smoke-status").textContent = error.message; $("start-smoke").disabled = false; $("start-benchmark").disabled = false; }
}

async function stopRun() {
  if (!terminalRunId || !confirm("Stop this benchmark run? Active remote commands will be cancelled. Tables, infrastructure, and collected evidence will be preserved.")) return;
  $("stop-run").disabled = true;
  try { const response = await fetch(`/api/runs/${encodeURIComponent(terminalRunId)}/stop`, { method: "POST", headers: { "x-kvs-csrf": bootstrap.csrfToken } }); const run = await response.json(); if (!response.ok) throw new Error(run.error || `Stop failed (${response.status})`); showSmoke(run); }
  catch (error) { $("smoke-status").className = "callout error"; $("smoke-status").textContent = error.message; $("stop-run").disabled = false; }
}

async function resumeRun() {
  if (!terminalRunId || !confirm("Resume this verified benchmark checkpoint? Completed prerequisite gates and finalized sessions will be reused. Evidence for the interrupted session will be reconciled before the next session starts; no resource will be recreated.")) return;
  $("resume-run").disabled = true;
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(terminalRunId)}/resume`, { method: "POST", headers: { "x-kvs-csrf": bootstrap.csrfToken } });
    const run = await response.json();
    if (!response.ok) throw new Error(run.error || `Resume failed (${response.status})`);
    localStorage.setItem("kvs-dashboard-run-id", run.id); showOperations(); showSmoke(run); await monitorRun(run.id, run.mode || "async");
  } catch (error) { $("smoke-status").className = "callout error"; $("smoke-status").textContent = error.message; $("resume-run").disabled = false; }
}

document.querySelectorAll('input[name="infra-mode"]').forEach(input => input.addEventListener("change", () => $("managed-fields").classList.toggle("hidden", document.querySelector('input[name="infra-mode"]:checked').value !== "managed")));
$("destination-cloud").addEventListener("change", () => { syncDestinationProducts(); discovered = null; destinations = null; void autoDiscoverActiveTarget(); });
$("destination-product").addEventListener("change", () => { syncCloudCatalog(); discovered = null; destinations = null; void autoDiscoverActiveTarget(); });
$("add-destination").addEventListener("click", async () => { try { await addDestination(); } catch (error) { $("runner-status").className = "callout error"; $("runner-status").textContent = error.message; } });
$("destination-summary").addEventListener("click", event => { const button = event.target.closest("[data-remove-destination]"); if (!button) return; selectedTargets.delete(button.dataset.removeDestination); $(`${button.dataset.removeDestination}-enabled`).checked = false; renderDestinationSummary(); renderDestinationDetails(); scheduleDraftSave(); });
document.querySelectorAll("[data-go-step]").forEach(button => button.addEventListener("click", () => showStep(Number(button.dataset.goStep))));
$("back").addEventListener("click", () => showStep(currentStep - 1)); $("next").addEventListener("click", () => showStep(currentStep + 1));
$("new-benchmark").addEventListener("click", beginNewBenchmark); $("cancel-benchmark").addEventListener("click", showOperations);
$("load-generator-count").addEventListener("change", synchronizeRunnerCounts);
for (const id of runnerSelectIds) $(id).addEventListener("change", () => { updateRunnerSelectionStatus(id.replace("-runner", "")); renderDestinationDetails(); scheduleDraftSave(); });
for (const prefix of ["aws-table", "adb-table", "ndcs-table"]) $(prefix).addEventListener("change", () => { syncManual(prefix); renderDestinationDetails(); });
$("adb-table-manual").addEventListener("input", () => localStorage.setItem("kvs-dashboard-adb-table", value("adb-table-manual")));
document.querySelectorAll(".option-search").forEach(input => input.addEventListener("input", () => filterOptions(input)));
document.querySelectorAll('#live-series-controls input').forEach(input => input.addEventListener("change", renderLiveCharts));
document.querySelectorAll('input[name="run-mode"]').forEach(input => input.addEventListener("change", syncLiveChartVisibility));
for (const id of ["adb-compartment", "ndcs-compartment"]) $(id).addEventListener("change", () => { if (destinations) void lookupDestinations({ probeAdbTables: false }); });
for (const context of ["adb", "ndcs"]) for (const suffix of ["profile", "region"]) $(`${context}-${suffix}`).addEventListener("change", () => {
  discovered = null; destinations = null;
  $("adb-runner").innerHTML = '<option value="">Discover runners again</option>'; $("ndcs-runner").innerHTML = '<option value="">Discover runners again</option>';
  if (context === "adb") { $("adb-compartment").innerHTML = '<option value="">Lookup using selected ADB profile</option>'; $("adb-database").innerHTML = '<option value="">Lookup Autonomous Databases</option>'; $("adb-table").innerHTML = '<option value="">Lookup DynamoDB-API tables</option>'; }
  else { $("ndcs-compartment").innerHTML = '<option value="">Lookup using selected NoSQL profile</option>'; $("ndcs-table").innerHTML = '<option value="">Lookup OCI NoSQL tables</option>'; }
  void autoDiscoverActiveTarget();
});
$("select-recommended").addEventListener("click", () => selectPresets(recommendedPreset)); $("select-all-presets").addEventListener("click", () => selectPresets(() => true)); $("clear-presets").addEventListener("click", () => selectPresets(() => false));
$("image-digest").addEventListener("input", renderRunnerImage);
$("pause-log").addEventListener("click", () => { terminalPaused = !terminalPaused; $("pause-log").textContent = terminalPaused ? "Resume" : "Pause"; $("pause-log").setAttribute("aria-pressed", String(terminalPaused)); if (!terminalPaused && terminalRunId) renderExecutionLog({ id: terminalRunId, logs: terminalLogs }); });
$("clear-log").addEventListener("click", () => { terminalClearedCount = terminalLogs.length; $("execution-log").innerHTML = '<div class="kvs-run-log-empty"><span>$</span> View cleared. New events will continue to appear.</div>'; });
$("copy-log").addEventListener("click", async () => { const button = $("copy-log"); try { await navigator.clipboard.writeText(terminalText(terminalLogs.slice(terminalClearedCount))); button.textContent = "Copied"; } catch { button.textContent = "Copy failed"; } setTimeout(() => { button.textContent = "Copy"; }, 1500); });
$("reset-draft").addEventListener("click", () => { localStorage.removeItem(draftKey); localStorage.removeItem("kvs-dashboard-adb-table"); location.reload(); });
document.querySelector("main").addEventListener("input", event => { if (!event.target.matches(".option-search") && event.target.id !== "write-authorization") scheduleDraftSave(); });
document.querySelector("main").addEventListener("change", event => { if (event.target.id !== "write-authorization") scheduleDraftSave(); });
$("preview-button").addEventListener("click", preview); $("download").addEventListener("click", downloadSpec); $("start-smoke").addEventListener("click", startSmoke); $("start-benchmark").addEventListener("click", startCloud); $("discover-destinations").addEventListener("click", discoverDestinations);
$("stop-run").addEventListener("click", stopRun);
$("resume-run").addEventListener("click", resumeRun);
$("refresh-run-history").addEventListener("click", () => refreshRunHistory({ preserveSelection: true }));
$("run-history-status").addEventListener("change", () => { runHistoryPage = 1; renderRunHistoryList({ preserveSelection: false }); if ($("run-history-select").value) void showHistoricalRun($("run-history-select").value); else $("run-history-detail").classList.add("hidden"); });
$("run-history-select").addEventListener("change", () => { renderRunHistoryList({ preserveSelection: true }); void showHistoricalRun($("run-history-select").value); });
$("run-history-prev").addEventListener("click", () => changeRunHistoryPage(-1));
$("run-history-next").addEventListener("click", () => changeRunHistoryPage(1));
function showLoadError(error) { $("connection").textContent = error.message; $("connection").className = "status error"; }
initializeWorkspaceShell(); syncDestinationProducts(); renderDestinationSummary(); syncLiveChartVisibility(); load().catch(showLoadError);
