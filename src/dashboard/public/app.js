const $ = id => document.getElementById(id);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const number = value => value == null ? "-" : Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
const value = id => $(id).value.trim();
const optionalNumber = id => value(id) === "" ? undefined : Number(value(id));
let bootstrap = null;
let lastSpec = null;
let currentStep = 1;
let discovered = null;
let destinations = null;

function selected(select, preferred) { if (!select.options.length) return; ([...select.options].find(option => option.value === preferred) || select.options[0]).selected = true; }
function profiles(select, values, preferred) { select.replaceChildren(...values.map(item => new Option(item, item))); selected(select, preferred); }
const recommendedPreset = file => file.includes("5m") || file.includes("mixed-70-30");
function presetDuration(seconds) { if (seconds == null) return "Variable"; return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} sec`; }
function updatePresetCount() { const selected = document.querySelectorAll('input[name="config"]:checked').length; $("preset-count").textContent = `${selected} preset${selected === 1 ? "" : "s"} selected`; }

function renderConfigs(configs) {
  $("configs").replaceChildren(...configs.map(config => {
    const row = document.createElement("tr"), selectedByDefault = recommendedPreset(config.file);
    const choice = document.createElement("td"), input = document.createElement("input"); input.type = "checkbox"; input.value = config.file; input.checked = selectedByDefault; input.name = "config"; input.setAttribute("aria-label", `Run ${config.name}`); choice.append(input);
    const preset = document.createElement("td"), title = document.createElement("b"); title.textContent = config.name; preset.append(title); if (selectedByDefault) { const badge = document.createElement("small"); badge.className = "preset-badge"; badge.textContent = "Recommended"; preset.append(badge); }
    const repetitionCell = document.createElement("td"), repetitions = document.createElement("input"); repetitions.type = "number"; repetitions.min = "1"; repetitions.step = "1"; repetitions.value = "1"; repetitions.className = "preset-repetitions"; repetitions.dataset.config = config.file; repetitions.setAttribute("aria-label", `Repetitions for ${config.name}`); repetitionCell.append(repetitions);
    const values = [config.model === "open-loop" ? "Open-loop" : "Fixed workers", `${config.readPercent}% / ${config.writePercent}%`, config.consistency === "strong" ? "Strong" : "Eventual", presetDuration(config.durationSeconds), config.loadSummary || "Profile-defined"];
    row.append(choice, preset, repetitionCell, ...values.map(value => { const cell = document.createElement("td"); cell.textContent = value; return cell; }));
    input.addEventListener("change", () => { syncOverrideApplicability(); updatePresetCount(); }); return row;
  }));
  updatePresetCount();
}

function selectPresets(predicate) { document.querySelectorAll('input[name="config"]').forEach(input => { input.checked = predicate(input.value); }); syncOverrideApplicability(); updatePresetCount(); }

function syncOverrideApplicability() {
  if (!bootstrap) return;
  const files = new Set([...document.querySelectorAll('input[name="config"]:checked')].map(input => input.value));
  const models = bootstrap.configs.filter(config => files.has(config.file)).map(config => config.model);
  const rules = [["execution-mode", models.includes("open-loop"), "Select an open-loop workload to override request scheduling."], ["rate-multiplier", models.includes("open-loop"), "Select an open-loop workload to override offered rate."], ["fixed-concurrency", models.includes("closed-loop"), "Select a closed-loop workload to override worker concurrency."]];
  for (const [id, enabled, reason] of rules) { $(id).disabled = !enabled; $(id).title = enabled ? "" : reason; if (!enabled) $(id).value = ""; }
}

async function load() {
  $("connection").textContent = "Discovering profiles...";
  const response = await fetch("/api/bootstrap", { cache: "no-store" });
  if (!response.ok) throw new Error(`Bootstrap failed (${response.status})`);
  bootstrap = await response.json();
  profiles($("aws-profile"), bootstrap.profiles.aws, "dynamodb_poc"); profiles($("adb-profile"), bootstrap.profiles.oci, "PITWALL_API"); profiles($("ndcs-profile"), bootstrap.profiles.oci, "PITWALL_API");
  $("image-digest").value = bootstrap.defaults.imageDigest || "";
  renderConfigs(bootstrap.configs); syncOverrideApplicability();
  $("warnings").innerHTML = bootstrap.profiles.warnings.map(item => `<div class="callout warning">${escapeHtml(item)}</div>`).join("");
  $("connection").textContent = `${bootstrap.profiles.aws.length} AWS | ${bootstrap.profiles.oci.length} OCI profiles`; $("connection").className = "status ok";
  const savedRun = localStorage.getItem("kvs-dashboard-run-id"); if (savedRun) void monitorRun(savedRun, "async", true);
}

function runMode() { return document.querySelector('input[name="run-mode"]:checked').value; }
function selectedRunner(id) { return discovered?.oci?.find(item => item.id === value(id)) || discovered?.aws?.find(item => item.id === value(id)) || {}; }
function resourceValue(prefix) { return value(prefix) === "__manual__" ? value(`${prefix}-manual`) : value(prefix); }
function specification() {
  const mode = document.querySelector('input[name="infra-mode"]:checked').value;
  const overrides = { durationSeconds: optionalNumber("duration"), readPercent: optionalNumber("read-percent"), writePercent: optionalNumber("write-percent"), rateMultiplier: optionalNumber("rate-multiplier"), fixedConcurrency: optionalNumber("fixed-concurrency"), consistency: value("consistency") || undefined, executionMode: value("execution-mode") || undefined };
  Object.keys(overrides).forEach(key => overrides[key] === undefined && delete overrides[key]);
  const adbRunner = selectedRunner("adb-runner"), ndcsRunner = selectedRunner("ndcs-runner");
  const configs = [...document.querySelectorAll('input[name="config"]:checked')].map(input => input.value);
  const repetitionsByFile = Object.fromEntries([...document.querySelectorAll(".preset-repetitions")].map(input => [input.dataset.config, Number(input.value)]));
  const presetRepetitions = Object.fromEntries(configs.map(file => [file, repetitionsByFile[file] || 1]));
  return { schemaVersion: 1, infrastructure: mode === "managed" ? { mode, repositoryPath: value("infra-repo"), gitRef: value("infra-ref"), terraformWorkspace: value("infra-workspace"), apply: false } : { mode }, targets: { aws: { enabled: $("aws-enabled").checked, profile: value("aws-profile"), region: value("aws-region"), resource: resourceValue("aws-table"), runnerId: value("aws-runner") }, adb: { enabled: $("adb-enabled").checked, profile: value("adb-profile"), region: value("adb-region"), resource: resourceValue("adb-table"), databaseId: value("adb-database"), runnerId: value("adb-runner"), runnerHost: adbRunner.publicIp, compartmentId: value("adb-compartment") }, ndcs: { enabled: $("ndcs-enabled").checked, profile: value("ndcs-profile"), region: value("ndcs-region"), resource: resourceValue("ndcs-table"), runnerId: value("ndcs-runner"), runnerHost: ndcsRunner.publicIp, compartmentId: value("ndcs-compartment") } }, configs, presetRepetitions, overrides, execution: { mode: runMode(), mutableParameters: false }, artifactBucket: value("artifact-bucket"), imageDigest: value("image-digest"), writeAuthorization: $("write-authorization").checked };
}

function runnerOptions(select, values, preferredPattern) {
  const list = Array.isArray(values) ? values.filter(item => item && typeof item === "object") : [];
  select.replaceChildren(new Option("Select a discovered runner", ""), ...list.map(item => new Option(`${item.name || "Unnamed"} | ${item.placement || "unknown"} | ${item.remoteControl || "unknown"}`, item.id || "")));
  const preferred = list.find(item => preferredPattern.test(item.name || "")); if (preferred) select.value = preferred.id;
}

async function discoverRunners() {
  $("discover-runners").disabled = true; $("runner-status").className = "callout"; $("runner-status").textContent = "Checking cloud identities, running instances, remote-control health, placement, and evidence buckets...";
  try {
    const response = await fetch("/api/discover-runners", { method: "POST", headers: { "content-type": "application/json", "x-kvs-csrf": bootstrap.csrfToken }, body: JSON.stringify({ awsProfile: value("aws-profile"), awsRegion: value("aws-region"), ociProfile: value("adb-profile"), ociRegion: value("adb-region") }) });
    const result = await response.json(); if (!response.ok) throw new Error(result?.error || `Discovery failed (${response.status})`);
    discovered = { aws: Array.isArray(result?.aws) ? result.aws : [], oci: Array.isArray(result?.oci) ? result.oci : [], artifactBuckets: Array.isArray(result?.artifactBuckets) ? result.artifactBuckets : [] };
    runnerOptions($("aws-runner"), discovered.aws, /aws.*runner|runner.*aws/i); runnerOptions($("adb-runner"), discovered.oci, /adb.*runner/i); runnerOptions($("ndcs-runner"), discovered.oci, /ndcs|nosql/i);
    $("artifact-bucket").replaceChildren(new Option("Select an evidence bucket", ""), ...(discovered.artifactBuckets || []).map(name => new Option(name, name))); if (discovered.artifactBuckets?.length === 1) $("artifact-bucket").value = discovered.artifactBuckets[0];
    $("runner-status").className = "callout"; $("runner-status").innerHTML = `<b>Discovery complete.</b> ${(discovered.aws || []).length} AWS and ${(discovered.oci || []).length} OCI runner(s); ${discovered.artifactBuckets?.length || 0} evidence bucket(s).`; return true;
  } catch (error) { $("runner-status").className = "callout error"; $("runner-status").textContent = error?.message || String(error); return false; }
  finally { $("discover-runners").disabled = false; }
}

function lookupOptions(select, items, { label = item => item.name || item, valueOf = item => item.id || item, placeholder = "Select a discovered value", manual = false, preferred } = {}) {
  if (!select) throw new Error("Destination form is out of date; reload the dashboard page");
  const list = Array.isArray(items) ? items.filter(item => item != null) : [], options = [new Option(placeholder, ""), ...list.map(item => new Option(String(label(item) ?? "Unnamed"), String(valueOf(item) ?? "")))]; if (manual) options.push(new Option("Enter manually...", "__manual__")); select.replaceChildren(...options);
  if (preferred && Array.from(select.options || []).some(option => option.value === preferred)) select.value = preferred; else if (list.length === 1) select.value = String(valueOf(list[0]) ?? "");
}

function syncManual(prefix) { $(`${prefix}-manual-wrap`).hidden = value(prefix) !== "__manual__"; }

async function lookupDestinations() {
  $("lookup-destinations").disabled = true; $("runner-status").className = "callout"; $("runner-status").textContent = "Reading accessible OCI compartments and available tables without modifying them...";
  let stage = "initialization";
  try {
    if (!bootstrap?.csrfToken) throw new Error("Dashboard session is not ready; reload the page");
    stage = "runner discovery";
    if (!discovered && ($("adb-enabled").checked || $("ndcs-enabled").checked)) {
      const ready = await discoverRunners();
      if (!ready) throw new Error("Runner discovery did not complete; see the discovery message and retry");
    }
    stage = "request preparation";
    const adbRunner = selectedRunner("adb-runner"), ndcsRunner = selectedRunner("ndcs-runner");
    const previous = { awsTable: resourceValue("aws-table"), adbTable: resourceValue("adb-table"), ndcsTable: resourceValue("ndcs-table") };
    const request = { awsProfile: value("aws-profile"), awsRegion: value("aws-region"), ociProfile: value("adb-profile") || value("ndcs-profile"), ociRegion: value("adb-region") || value("ndcs-region"), adbCompartmentId: value("adb-compartment") || adbRunner.compartmentId, ndcsCompartmentId: value("ndcs-compartment") || ndcsRunner.compartmentId, adbRunnerHost: adbRunner.publicIp, targets: { aws: $("aws-enabled").checked, adb: $("adb-enabled").checked, ndcs: $("ndcs-enabled").checked } };
    stage = "cloud inventory request";
    const response = await fetch("/api/discover-destinations", { method: "POST", headers: { "content-type": "application/json", "x-kvs-csrf": bootstrap.csrfToken }, body: JSON.stringify(request) });
    const result = await response.json(); if (!response.ok) throw new Error(result?.error || `Destination lookup failed (${response.status})`);
    stage = "response normalization";
    destinations = result && typeof result === "object" ? result : {};
    const previousAdbCompartment = request.adbCompartmentId, previousNdcsCompartment = request.ndcsCompartmentId;
    const compartments = Array.isArray(destinations.compartments) ? destinations.compartments : [], awsTables = Array.isArray(destinations.awsTables) ? destinations.awsTables : [], databases = Array.isArray(destinations.autonomousDatabases) ? destinations.autonomousDatabases : [], adbTables = Array.isArray(destinations.adbTables) ? destinations.adbTables : [], nosqlTables = Array.isArray(destinations.nosqlTables) ? destinations.nosqlTables : [];
    stage = "destination rendering";
    lookupOptions($("adb-compartment"), compartments, { label: item => item.path, preferred: previousAdbCompartment, placeholder: "Select an accessible compartment" });
    lookupOptions($("ndcs-compartment"), compartments, { label: item => item.path, preferred: previousNdcsCompartment, placeholder: "Select an accessible compartment" });
    lookupOptions($("aws-table"), awsTables, { valueOf: item => item, label: item => item, placeholder: "Select an AWS table", manual: true, preferred: previous.awsTable });
    lookupOptions($("adb-database"), databases, { label: item => `${item.name} | ${item.state} | ${item.computeCount ?? item.cpuCoreCount ?? "?"} compute`, preferred: destinations.adbRuntimeDatabaseId, placeholder: "Select an Autonomous Database" });
    lookupOptions($("adb-table"), adbTables, { valueOf: item => item, label: item => item, placeholder: "Select a DynamoDB-API table", manual: true, preferred: previous.adbTable });
    lookupOptions($("ndcs-table"), nosqlTables, { label: item => `${item.name} | ${item.state} | ${item.readUnits ?? "?"} RU / ${item.writeUnits ?? "?"} WU`, valueOf: item => item.name, placeholder: "Select an OCI NoSQL table", manual: true, preferred: previous.ndcsTable });
    for (const prefix of ["aws-table", "adb-table", "ndcs-table"]) syncManual(prefix);
    const mismatch = destinations.adbRuntimeDatabaseId && value("adb-database") !== destinations.adbRuntimeDatabaseId;
    $("runner-status").className = `callout${mismatch ? " warning" : ""}`; $("runner-status").innerHTML = `<b>Lookup complete.</b> ${compartments.length} OCI compartment(s), ${awsTables.length} AWS table(s), ${adbTables.length} ADB DynamoDB-API table(s), and ${nosqlTables.length} OCI NoSQL table(s).${mismatch ? " The selected ADB runner credentials belong to a database outside the selected compartment." : ""}`;
  } catch (error) { console.error("Destination lookup failed", { stage, error }); $("runner-status").className = "callout error"; $("runner-status").textContent = `Destination lookup failed during ${stage}: ${error?.message || String(error)}`; }
  finally { $("lookup-destinations").disabled = false; }
}

function renderReview() {
  const spec = specification(); const targets = Object.entries(spec.targets).filter(([, target]) => target.enabled).map(([name, target]) => `${name.toUpperCase()} (${target.profile || "no profile"}, ${target.region})`);
  const overrideText = Object.keys(spec.overrides).length ? Object.entries(spec.overrides).map(([key, item]) => `${key}: ${item}`).join(", ") : "Profile defaults";
  const repetitions = Object.values(spec.presetRepetitions).reduce((sum, count) => sum + count, 0), cards = [["Targets", targets.join("; ") || "None"], ["Infrastructure", spec.infrastructure.mode], ["Workloads", `${spec.configs.length} preset(s), ${repetitions} session(s)`], ["Execution", `${spec.execution.mode}; immutable parameters`], ["Overrides", overrideText]];
  $("review-summary").innerHTML = cards.map(([label, item]) => `<div class="summary-card"><span>${escapeHtml(label)}</span><b>${escapeHtml(item)}</b></div>`).join("");
}

function showStep(step) {
  currentStep = Math.max(1, Math.min(5, step)); document.querySelectorAll(".wizard-panel").forEach(panel => { panel.hidden = Number(panel.dataset.step) !== currentStep; });
  document.querySelectorAll(".stepper li").forEach((item, index) => { item.classList.toggle("active", index + 1 === currentStep); item.classList.toggle("done", index + 1 < currentStep); });
  $("back").disabled = currentStep === 1; $("next").hidden = currentStep === 5; $("step-label").textContent = `Step ${currentStep} of 5`;
  if (currentStep === 5) { renderReview(); void preview(); }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showPreview(preview) {
  const warnings = preview.warnings?.length ? `<ul>${preview.warnings.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "";
  $("preview-status").className = `callout${preview.warnings?.length ? " warning" : ""}`; $("preview-status").innerHTML = `<b>Valid immutable preview.</b> Infrastructure: ${escapeHtml(preview.infrastructure.mode)}. No cloud mutation was performed.${warnings}`;
  const values = [["Triplet sessions", preview.totals.tripletSessions], ["Target executions", preview.totals.targetExecutions], ["Scheduled operations", preview.totals.totalScheduledOperations], ["Database minutes", preview.totals.totalDatabaseMinutes]];
  $("totals").innerHTML = values.map(([label, metric]) => `<div class="stat"><span>${escapeHtml(label)}</span><b>${number(metric)}</b></div>`).join("");
  $("matrix").innerHTML = preview.rows.map(row => `<tr><td>${escapeHtml(row.id)}</td><td>${escapeHtml(row.configFile)}</td><td>${escapeHtml(row.loadModel)}</td><td>${row.readPercent}/${row.writePercent}</td><td>${escapeHtml(row.consistency)}</td><td>${number(row.durationSeconds)} s</td><td>${number(row.scheduledOperationsPerTarget)}</td><td>${number(row.averageScheduledOperationsPerSecond)}</td><td>${escapeHtml(row.targets.join(", "))}</td><td><code>${escapeHtml(row.configSha256.slice(0, 12))}...</code></td></tr>`).join("");
  $("download").disabled = false;
}

async function preview() {
  if (!bootstrap) return;
  try { lastSpec = specification(); renderReview(); const response = await fetch("/api/preview", { method: "POST", headers: { "content-type": "application/json", "x-kvs-csrf": bootstrap.csrfToken }, body: JSON.stringify(lastSpec) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || `Preview failed (${response.status})`); showPreview(result); }
  catch (error) { $("preview-status").className = "callout error"; $("preview-status").textContent = error.message; $("download").disabled = true; }
}

function downloadSpec() { const blob = new Blob([`${JSON.stringify(lastSpec, null, 2)}\n`], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `kvs-run-spec-${new Date().toISOString().replace(/[:.]/g, "-")}.json`; link.click(); URL.revokeObjectURL(link.href); }

function showSmoke(run) {
  const progress = run.progress || {}; const terminal = ["complete", "failed"].includes(run.status); const latency = run.summary?.successfulServiceLatencyMs || {};
  const accounting = run.kind === "cloud-acceptance" ? ` | shared T0 ${escapeHtml(run.sharedStartAt || "pending")}` : ` | ${number(progress.accounted)} of ${number(progress.scheduled)} operations accounted`;
  $("smoke-status").className = `callout${run.status === "failed" ? " error" : ""}`; $("smoke-status").innerHTML = `<b>${escapeHtml(run.status.toUpperCase())}</b> | run ${escapeHtml(run.id)}${accounting}.${run.error ? ` ${escapeHtml(run.error)}` : ""}`;
  $("pipeline").innerHTML = (run.stages || []).map(stage => `<div class="pipeline-stage ${escapeHtml(stage.status)}"><span>${escapeHtml(stage.status)}</span><b>${escapeHtml(stage.name.replaceAll("-", " "))}</b><small>${escapeHtml(stage.detail || "Waiting")}</small></div>`).join("");
  const cloudCompleted = run.summaries ? Object.values(run.summaries).reduce((sum, item) => sum + item.completed, 0) : null;
  const values = [["Completed", cloudCompleted ?? progress.completed ?? 0], ["Failed", progress.failed ?? (run.summaries ? Object.values(run.summaries).reduce((sum, item) => sum + item.failed, 0) : 0)], ["Current ops/s", progress.achievedOperationsPerSecond ?? run.summary?.achievedOperationsPerSecond], ["In flight", progress.inFlight ?? 0], ["Latest latency ms", progress.latestLatencyMs], ["Final P95 ms", latency.p95]];
  $("live-stats").innerHTML = values.map(([label, metric]) => `<div class="stat"><span>${escapeHtml(label)}</span><b>${number(metric)}</b></div>`).join("");
  $("smoke-detail").textContent = JSON.stringify({ kind: run.kind, mode: run.mode, status: run.status, startedAt: run.startedAt, completedAt: run.completedAt, targetStatus: run.targetStatus, certificates: run.certificates, summaries: run.summaries, evidence: run.output, latestOperation: progress.latestOperation, latestError: progress.latestError }, null, 2);
  $("download-output").classList.toggle("hidden", !run.downloadUrl); if (run.downloadUrl) $("download-output").href = run.downloadUrl;
  $("start-smoke").disabled = !terminal; $("start-benchmark").disabled = !terminal; if (terminal) localStorage.removeItem("kvs-dashboard-run-id");
}

async function monitorRun(id, mode, restoring = false) {
  try { let terminal = false; while (!terminal) { const response = await fetch(`/api/runs/${encodeURIComponent(id)}`, { cache: "no-store" }); const run = await response.json(); if (!response.ok) throw new Error(run.error || `Status failed (${response.status})`); showSmoke(run); terminal = ["complete", "failed"].includes(run.status); if (!terminal) await pause(mode === "live" ? 200 : 1000); } }
  catch (error) { if (!restoring) { $("smoke-status").className = "callout error"; $("smoke-status").textContent = error.message; } localStorage.removeItem("kvs-dashboard-run-id"); $("start-smoke").disabled = false; $("start-benchmark").disabled = false; }
}

async function startSmoke() {
  $("start-smoke").disabled = true; $("start-benchmark").disabled = true; $("download-output").classList.add("hidden"); $("smoke-status").className = "callout"; $("smoke-status").textContent = "Submitting local smoke test...";
  try { const mode = runMode(); const response = await fetch("/api/local-smoke", { method: "POST", headers: { "content-type": "application/json", "x-kvs-csrf": bootstrap.csrfToken }, body: JSON.stringify({ mode }) }); const run = await response.json(); if (!response.ok) throw new Error(run.error || `Start failed (${response.status})`); localStorage.setItem("kvs-dashboard-run-id", run.id); showSmoke(run); await monitorRun(run.id, mode); }
  catch (error) { $("smoke-status").className = "callout error"; $("smoke-status").textContent = error.message; $("start-smoke").disabled = false; $("start-benchmark").disabled = false; }
}

async function startCloud() {
  $("start-smoke").disabled = true; $("start-benchmark").disabled = true; $("download-output").classList.add("hidden"); $("smoke-status").className = "callout"; $("smoke-status").textContent = "Submitting cloud acceptance pipeline...";
  try { const spec = specification(); const response = await fetch("/api/cloud-acceptance", { method: "POST", headers: { "content-type": "application/json", "x-kvs-csrf": bootstrap.csrfToken }, body: JSON.stringify(spec) }); const run = await response.json(); if (!response.ok) throw new Error(run.error || `Start failed (${response.status})`); localStorage.setItem("kvs-dashboard-run-id", run.id); showSmoke(run); await monitorRun(run.id, runMode()); }
  catch (error) { $("smoke-status").className = "callout error"; $("smoke-status").textContent = error.message; $("start-smoke").disabled = false; $("start-benchmark").disabled = false; }
}

document.querySelectorAll('input[name="infra-mode"]').forEach(input => input.addEventListener("change", () => $("managed-fields").classList.toggle("hidden", document.querySelector('input[name="infra-mode"]:checked').value !== "managed")));
document.querySelectorAll("[data-go-step]").forEach(button => button.addEventListener("click", () => showStep(Number(button.dataset.goStep))));
$("back").addEventListener("click", () => showStep(currentStep - 1)); $("next").addEventListener("click", () => showStep(currentStep + 1));
for (const prefix of ["aws-table", "adb-table", "ndcs-table"]) $(prefix).addEventListener("change", () => syncManual(prefix));
for (const id of ["adb-compartment", "ndcs-compartment"]) $(id).addEventListener("change", () => { if (destinations) void lookupDestinations(); });
$("select-recommended").addEventListener("click", () => selectPresets(recommendedPreset)); $("select-all-presets").addEventListener("click", () => selectPresets(() => true)); $("clear-presets").addEventListener("click", () => selectPresets(() => false));
$("preview-button").addEventListener("click", preview); $("download").addEventListener("click", downloadSpec); $("start-smoke").addEventListener("click", startSmoke); $("start-benchmark").addEventListener("click", startCloud); $("discover-runners").addEventListener("click", discoverRunners); $("lookup-destinations").addEventListener("click", lookupDestinations); $("refresh").addEventListener("click", () => load().catch(showLoadError));
function showLoadError(error) { $("connection").textContent = error.message; $("connection").className = "status error"; }
showStep(1); load().catch(showLoadError);
