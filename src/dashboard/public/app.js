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
let liveChartSession = null;
let liveChartSamples = [];

function selected(select, preferred) { if (!select.options.length) return; ([...select.options].find(option => option.value === preferred) || select.options[0]).selected = true; }
function profiles(select, values, preferred) { select.size = 1; select.replaceChildren(...values.map(item => new Option(item, item))); selected(select, preferred); }
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
  $("adb-table-manual").value = localStorage.getItem("kvs-dashboard-adb-table") || "";
  renderConfigs(bootstrap.configs); syncOverrideApplicability();
  $("warnings").innerHTML = bootstrap.profiles.warnings.map(item => `<div class="callout warning">${escapeHtml(item)}</div>`).join("");
  $("connection").textContent = `${bootstrap.profiles.aws.length} AWS | ${bootstrap.profiles.oci.length} OCI profiles`; $("connection").className = "status ok";
  const savedRun = localStorage.getItem("kvs-dashboard-run-id"); if (savedRun) void monitorRun(savedRun, "async", true);
}

function runMode() { return document.querySelector('input[name="run-mode"]:checked').value; }
const cloudEnabled = name => $(`cloud-${name}`).checked;
function syncCloudCatalog() {
  document.querySelector("article.provider.aws").classList.toggle("cloud-hidden", !cloudEnabled("aws"));
  for (const selector of ["article.provider.adb", "article.provider.ndcs"]) document.querySelector(selector).classList.toggle("cloud-hidden", !cloudEnabled("oci"));
  $("aws-enabled").disabled = !cloudEnabled("aws"); $("adb-enabled").disabled = !cloudEnabled("oci"); $("ndcs-enabled").disabled = !cloudEnabled("oci");
  $("adb-probe-wrap").classList.toggle("cloud-hidden", !cloudEnabled("oci") || !$("adb-enabled").checked);
}
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
  return { schemaVersion: 1, infrastructure: mode === "managed" ? { mode, repositoryPath: value("infra-repo"), gitRef: value("infra-ref"), terraformWorkspace: value("infra-workspace"), apply: false } : { mode }, targets: { aws: { enabled: cloudEnabled("aws") && $("aws-enabled").checked, profile: value("aws-profile"), region: value("aws-region"), resource: resourceValue("aws-table"), runnerId: value("aws-runner") }, adb: { enabled: cloudEnabled("oci") && $("adb-enabled").checked, profile: value("adb-profile"), region: value("adb-region"), resource: resourceValue("adb-table"), databaseId: value("adb-database"), runnerId: value("adb-runner"), runnerCompartmentId: adbRunner.compartmentId, compartmentId: value("adb-compartment"), evidenceBucket: value("adb-artifact-bucket") }, ndcs: { enabled: cloudEnabled("oci") && $("ndcs-enabled").checked, profile: value("ndcs-profile"), region: value("ndcs-region"), resource: resourceValue("ndcs-table"), runnerId: value("ndcs-runner"), runnerCompartmentId: ndcsRunner.compartmentId, compartmentId: value("ndcs-compartment"), evidenceBucket: value("ndcs-artifact-bucket") } }, configs, presetRepetitions, overrides, execution: { mode: runMode(), mutableParameters: false }, artifactBucket: value("artifact-bucket"), imageDigest: value("image-digest"), writeAuthorization: $("write-authorization").checked };
}

function runnerOptions(select, values, preferredPattern) {
  const list = Array.isArray(values) ? values.filter(item => item && typeof item === "object") : [];
  select.replaceChildren(new Option("Select a discovered runner", ""), ...list.map(item => new Option(`${item.name || "Unnamed"} | ${item.placement || "unknown"} | ${item.remoteControl || "unknown"}`, item.id || "")));
  const preferred = list.find(item => preferredPattern.test(item.name || "")); if (preferred) select.value = preferred.id;
}

async function discoverRunners({ manageButton = true } = {}) {
  if (manageButton) $("discover-destinations").disabled = true; $("runner-status").className = "callout"; $("runner-status").textContent = "Step 1/2: checking cloud identities, runners, remote-control health, placement, and evidence buckets...";
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
  finally { if (manageButton) $("discover-destinations").disabled = false; }
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
function filterOptions(input) { const select = $(input.dataset.filterFor), query = input.value.trim().toLowerCase(); if (!select) return; for (const option of select.options) option.hidden = Boolean(query) && option.value !== select.value && !option.textContent.toLowerCase().includes(query); }

async function lookupDestinations({ manageButton = true } = {}) {
  if (manageButton) $("discover-destinations").disabled = true; $("runner-status").className = "callout"; $("runner-status").textContent = "Step 2/2: reading accessible compartments, databases, tables, and evidence stores without modifying them...";
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
    const request = { awsProfile: value("aws-profile"), awsRegion: value("aws-region"), adbOciProfile: value("adb-profile"), adbOciRegion: value("adb-region"), ndcsOciProfile: value("ndcs-profile"), ndcsOciRegion: value("ndcs-region"), adbCompartmentId: value("adb-compartment") || adbRunner.compartmentId, ndcsCompartmentId: value("ndcs-compartment") || ndcsRunner.compartmentId, adbRunnerId: adbRunner.id, adbRunnerCompartmentId: adbRunner.compartmentId, probeAdbTables: $("adb-live-table-lookup").checked, targets: { aws: cloudEnabled("aws") && $("aws-enabled").checked, adb: cloudEnabled("oci") && $("adb-enabled").checked, ndcs: cloudEnabled("oci") && $("ndcs-enabled").checked } };
    stage = "cloud inventory request";
    const response = await fetch("/api/discover-destinations", { method: "POST", headers: { "content-type": "application/json", "x-kvs-csrf": bootstrap.csrfToken }, body: JSON.stringify(request) });
    const result = await response.json(); if (!response.ok) throw new Error(result?.error || `Destination lookup failed (${response.status})`);
    stage = "response normalization";
    destinations = result && typeof result === "object" ? result : {};
    const previousAdbCompartment = request.adbCompartmentId, previousNdcsCompartment = request.ndcsCompartmentId;
    const adbCompartments = Array.isArray(destinations.adbCompartments) ? destinations.adbCompartments : [], ndcsCompartments = Array.isArray(destinations.ndcsCompartments) ? destinations.ndcsCompartments : [], awsTables = Array.isArray(destinations.awsTables) ? destinations.awsTables : [], databases = Array.isArray(destinations.autonomousDatabases) ? destinations.autonomousDatabases : [], adbTables = Array.isArray(destinations.adbTables) ? destinations.adbTables : [], nosqlTables = Array.isArray(destinations.nosqlTables) ? destinations.nosqlTables : [];
    stage = "ADB compartment rendering";
    lookupOptions($("adb-compartment"), adbCompartments, { label: item => item.path, preferred: previousAdbCompartment, placeholder: "Select an ADB-profile compartment" });
    stage = "OCI NoSQL compartment rendering";
    lookupOptions($("ndcs-compartment"), ndcsCompartments, { label: item => item.path, preferred: previousNdcsCompartment, placeholder: "Select a NoSQL-profile compartment" });
    stage = "AWS table rendering";
    lookupOptions($("aws-table"), awsTables, { getValue: item => item, label: item => item, placeholder: "Select an AWS table", manual: true, preferred: previous.awsTable });
    stage = "Autonomous Database rendering";
    lookupOptions($("adb-database"), databases, { label: item => `${item.name} | ${item.state} | ${item.computeCount ?? item.cpuCoreCount ?? "?"} compute`, preferred: destinations.adbRuntimeDatabaseId, placeholder: "Select an Autonomous Database" });
    stage = "ADB DynamoDB-API table rendering";
    lookupOptions($("adb-table"), adbTables, { getValue: item => item, label: item => item, placeholder: "Select a DynamoDB-API table", manual: true, preferred: previous.adbTable });
    if (adbTables.length === 0) $("adb-table").value = "__manual__";
    stage = "OCI NoSQL table rendering";
    lookupOptions($("ndcs-table"), nosqlTables, { label: item => `${item.name} | ${item.state} | ${item.readUnits ?? "?"} RU / ${item.writeUnits ?? "?"} WU`, getValue: item => item.name, placeholder: "Select an OCI NoSQL table", manual: true, preferred: previous.ndcsTable });
    stage = "evidence bucket rendering";
    lookupOptions($("adb-artifact-bucket"), destinations.adbEvidenceBuckets, { getValue: item => item, label: item => item, placeholder: "Select an ADB evidence bucket", preferred: value("adb-artifact-bucket") });
    lookupOptions($("ndcs-artifact-bucket"), destinations.ndcsEvidenceBuckets, { getValue: item => item, label: item => item, placeholder: "Select a NoSQL evidence bucket", preferred: value("ndcs-artifact-bucket") });
    stage = "manual destination synchronization";
    for (const prefix of ["aws-table", "adb-table", "ndcs-table"]) syncManual(prefix);
    const mismatch = destinations.adbRuntimeDatabaseId && value("adb-database") !== destinations.adbRuntimeDatabaseId, partialErrors = Object.entries(destinations.discoveryErrors || {});
    const errorList = partialErrors.length ? `<ul>${partialErrors.map(([key, message]) => `<li><b>${escapeHtml(key)}:</b> ${escapeHtml(message)}</li>`).join("")}</ul>` : "";
    const manualNote = !request.probeAdbTables && request.targets.adb ? " ADB table probing was not requested; enter the exact DynamoDB-API table name manually." : "";
    $("runner-status").className = `callout${mismatch || partialErrors.length ? " warning" : ""}`; $("runner-status").innerHTML = `<b>${partialErrors.length ? "Partial lookup complete." : "Lookup complete."}</b> ${adbCompartments.length} ADB-profile compartment(s), ${ndcsCompartments.length} NoSQL-profile compartment(s), ${awsTables.length} AWS table(s), ${adbTables.length} ADB DynamoDB-API table(s), and ${nosqlTables.length} OCI NoSQL table(s).${manualNote}${mismatch ? " The selected ADB runner credentials belong to a database outside the selected compartment." : ""}${errorList}`;
  } catch (error) { console.error("Destination lookup failed", { stage, error }); $("runner-status").className = "callout error"; $("runner-status").textContent = `Destination lookup failed during ${stage}: ${error?.message || String(error)}`; }
  finally { if (manageButton) $("discover-destinations").disabled = false; }
}

async function discoverDestinations() {
  $("discover-destinations").disabled = true;
  try {
    const ready = await discoverRunners({ manageButton: false });
    if (ready) await lookupDestinations({ manageButton: false });
  } finally { $("discover-destinations").disabled = false; }
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

const chartColors = { aws: "#ef7d00", adb: "#7b3fc6", ndcs: "#008c95", offered: "#3f4b5f" };
function enabledSeries() { return new Set([...document.querySelectorAll('#live-series-controls input:checked')].map(input => input.value)); }
function drawChart(canvas, series, emptyText) {
  const context = canvas.getContext("2d"), width = canvas.width, height = canvas.height, margin = { left: 54, right: 18, top: 16, bottom: 34 };
  context.clearRect(0, 0, width, height); context.fillStyle = "#fff"; context.fillRect(0, 0, width, height);
  const active = series.filter(item => enabledSeries().has(item.name) && item.values.some(value => Number.isFinite(value)));
  if (!active.length) { context.fillStyle = "#68758a"; context.font = "14px system-ui"; context.fillText(emptyText, 24, 42); return; }
  const maximum = Math.max(1, ...active.flatMap(item => item.values.filter(Number.isFinite))) * 1.1, points = Math.max(2, ...active.map(item => item.values.length));
  context.strokeStyle = "#dfe5ed"; context.fillStyle = "#68758a"; context.font = "12px system-ui"; context.textAlign = "right";
  for (let tick = 0; tick <= 4; tick += 1) { const y = margin.top + (height - margin.top - margin.bottom) * tick / 4; context.beginPath(); context.moveTo(margin.left, y); context.lineTo(width - margin.right, y); context.stroke(); context.fillText(number(maximum * (4 - tick) / 4), margin.left - 8, y + 4); }
  for (const item of active) { context.strokeStyle = chartColors[item.name]; context.lineWidth = item.name === "offered" ? 2 : 3; context.setLineDash(item.name === "offered" ? [8, 5] : []); context.beginPath(); item.values.forEach((value, index) => { if (!Number.isFinite(value)) return; const x = margin.left + (width - margin.left - margin.right) * index / (points - 1), y = height - margin.bottom - (height - margin.top - margin.bottom) * value / maximum; if (index === 0) context.moveTo(x, y); else context.lineTo(x, y); }); context.stroke(); }
  context.setLineDash([]); context.fillStyle = "#68758a"; context.textAlign = "center"; context.fillText(`0 s`, margin.left, height - 10); context.fillText(`${Math.max(0, liveChartSamples.length - 1)} samples`, width - margin.right, height - 10);
}
function renderLiveCharts() {
  const targets = ["aws", "adb", "ndcs"];
  drawChart($("throughput-chart"), [...targets.map(name => ({ name, values: liveChartSamples.map(sample => sample[name]?.operationsPerSecond) })), { name: "offered", values: liveChartSamples.map(sample => sample.offered) }], "Waiting for throughput samples...");
  drawChart($("latency-chart"), targets.map(name => ({ name, values: liveChartSamples.map(sample => sample[name]?.rollingP95Ms) })), "Waiting for latency samples...");
}
function captureLiveSample(run) {
  const sessionId = run.currentSession?.id; if (!sessionId) return;
  if (liveChartSession !== sessionId) { liveChartSession = sessionId; liveChartSamples = []; }
  const metrics = run.targetMetrics || {}, sampleAt = Object.values(metrics).map(item => item.at).filter(Boolean).sort().at(-1);
  if (!sampleAt || liveChartSamples.at(-1)?.at === sampleAt) return;
  liveChartSamples.push({ at: sampleAt, offered: run.currentSession.offeredOperationsPerSecond, ...metrics });
  if (liveChartSamples.length > 600) liveChartSamples.shift();
  $("live-chart-caption").textContent = `${sessionId} | ${run.currentSession.durationSeconds} s | ${number(run.currentSession.offeredOperationsPerSecond)} offered ops/s | ${liveChartSamples.length} sample(s)`;
  renderLiveCharts();
}

function showSmoke(run) {
  const progress = run.progress || {}; const terminal = ["complete", "failed"].includes(run.status); const latency = run.summary?.successfulServiceLatencyMs || {};
  const cloud = run.kind === "cloud-benchmark" || run.kind === "cloud-acceptance", session = run.currentSession;
  const accounting = cloud ? ` | ${session ? `session ${escapeHtml(session.id)} (${session.index}/${session.total}) | ` : ""}shared T0 ${escapeHtml(run.sharedStartAt || "pending")}` : ` | ${number(progress.accounted)} of ${number(progress.scheduled)} operations accounted`;
  $("smoke-status").className = `callout${run.status === "failed" ? " error" : ""}`; $("smoke-status").innerHTML = `<b>${escapeHtml(run.status.toUpperCase())}</b> | run ${escapeHtml(run.id)}${accounting}.${run.error ? ` ${escapeHtml(run.error)}` : ""}`;
  $("pipeline").innerHTML = (run.stages || []).map(stage => `<div class="pipeline-stage ${escapeHtml(stage.status)}"><span>${escapeHtml(stage.status)}</span><b>${escapeHtml(stage.name.replaceAll("-", " "))}</b><small>${escapeHtml(stage.detail || "Waiting")}</small></div>`).join("");
  const targetMetrics = run.targetMetrics || {};
  const showLiveChart = cloud && run.mode === "live" && ["running", "complete"].includes(run.status); $("live-chart-panel").classList.toggle("hidden", !showLiveChart); if (showLiveChart) captureLiveSample(run);
  if (cloud && Object.keys(targetMetrics).length) $("live-stats").innerHTML = Object.entries(targetMetrics).map(([target, metric]) => `<div class="target-live provider-${escapeHtml(target)}"><h4>${escapeHtml(target.toUpperCase())}${metric.provisional ? " · LIVE PREVIEW" : " · FINAL"}</h4><div class="stats"><div class="stat"><span>Completed</span><b>${number(metric.completed)}</b></div><div class="stat"><span>Failed</span><b>${number(metric.failed)}</b></div><div class="stat"><span>Ops/s</span><b>${number(metric.operationsPerSecond)}</b></div><div class="stat"><span>In flight</span><b>${number(metric.inFlight)}</b></div><div class="stat"><span>Latest latency ms</span><b>${number(metric.latestLatencyMs)}</b></div><div class="stat"><span>${metric.provisional ? "Rolling P95 ms" : "Final P95 ms"}</span><b>${number(metric.rollingP95Ms ?? metric.p95)}</b></div><div class="stat"><span>Final P99 ms</span><b>${number(metric.p99)}</b></div><div class="stat"><span>Final max ms</span><b>${number(metric.max)}</b></div></div></div>`).join("");
  else { const cloudCompleted = run.summaries ? Object.values(run.summaries).reduce((sum, item) => sum + item.completed, 0) : null; const values = [["Completed", cloudCompleted ?? progress.completed ?? 0], ["Failed", progress.failed ?? (run.summaries ? Object.values(run.summaries).reduce((sum, item) => sum + item.failed, 0) : 0)], ["Current ops/s", progress.achievedOperationsPerSecond ?? run.summary?.achievedOperationsPerSecond], ["In flight", progress.inFlight ?? 0], ["Latest latency ms", progress.latestLatencyMs], ["Final P95 ms", latency.p95]]; $("live-stats").innerHTML = values.map(([label, metric]) => `<div class="stat"><span>${escapeHtml(label)}</span><b>${number(metric)}</b></div>`).join(""); }
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
for (const id of ["cloud-aws", "cloud-oci"]) $(id).addEventListener("change", () => { syncCloudCatalog(); discovered = null; destinations = null; });
$("adb-enabled").addEventListener("change", syncCloudCatalog);
document.querySelectorAll("[data-go-step]").forEach(button => button.addEventListener("click", () => showStep(Number(button.dataset.goStep))));
$("back").addEventListener("click", () => showStep(currentStep - 1)); $("next").addEventListener("click", () => showStep(currentStep + 1));
for (const prefix of ["aws-table", "adb-table", "ndcs-table"]) $(prefix).addEventListener("change", () => syncManual(prefix));
$("adb-table-manual").addEventListener("input", () => localStorage.setItem("kvs-dashboard-adb-table", value("adb-table-manual")));
document.querySelectorAll(".option-search").forEach(input => input.addEventListener("input", () => filterOptions(input)));
document.querySelectorAll('#live-series-controls input').forEach(input => input.addEventListener("change", renderLiveCharts));
for (const id of ["adb-compartment", "ndcs-compartment"]) $(id).addEventListener("change", () => { if (destinations) void lookupDestinations(); });
for (const context of ["adb", "ndcs"]) for (const suffix of ["profile", "region"]) $(`${context}-${suffix}`).addEventListener("change", () => {
  discovered = null; destinations = null;
  $("adb-runner").innerHTML = '<option value="">Discover runners again</option>'; $("ndcs-runner").innerHTML = '<option value="">Discover runners again</option>';
  if (context === "adb") { $("adb-compartment").innerHTML = '<option value="">Lookup using selected ADB profile</option>'; $("adb-database").innerHTML = '<option value="">Lookup Autonomous Databases</option>'; $("adb-table").innerHTML = '<option value="">Lookup DynamoDB-API tables</option>'; }
  else { $("ndcs-compartment").innerHTML = '<option value="">Lookup using selected NoSQL profile</option>'; $("ndcs-table").innerHTML = '<option value="">Lookup OCI NoSQL tables</option>'; }
});
$("select-recommended").addEventListener("click", () => selectPresets(recommendedPreset)); $("select-all-presets").addEventListener("click", () => selectPresets(() => true)); $("clear-presets").addEventListener("click", () => selectPresets(() => false));
$("preview-button").addEventListener("click", preview); $("download").addEventListener("click", downloadSpec); $("start-smoke").addEventListener("click", startSmoke); $("start-benchmark").addEventListener("click", startCloud); $("discover-destinations").addEventListener("click", discoverDestinations); $("refresh").addEventListener("click", () => load().catch(showLoadError));
function showLoadError(error) { $("connection").textContent = error.message; $("connection").className = "status error"; }
syncCloudCatalog(); showStep(1); load().catch(showLoadError);
