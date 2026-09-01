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
let terminalRunId = null;
let terminalLogs = [];
let terminalClearedCount = 0;
let terminalPaused = false;
const selectedTargets = new Set();
let automaticDiscovery = null;
let automaticDiscoveryPending = false;
const draftKey = "kvs-dashboard-draft-v1";
const incompatibleRunnerKey = "kvs-dashboard-incompatible-runners-v1";
const incompatibleRunners = new Set((() => { try { const values = JSON.parse(localStorage.getItem(incompatibleRunnerKey)); return Array.isArray(values) ? values : []; } catch { return []; } })());
const draftFieldIds = ["infra-repo", "infra-ref", "infra-workspace", "destination-cloud", "destination-product", "aws-profile", "aws-region", "aws-runner", "aws-table", "aws-table-manual", "artifact-bucket", "adb-profile", "adb-region", "adb-compartment", "adb-database", "adb-runner", "adb-table", "adb-table-manual", "adb-artifact-bucket", "ndcs-profile", "ndcs-region", "ndcs-compartment", "ndcs-runner", "ndcs-table", "ndcs-table-manual", "ndcs-artifact-bucket", "image-digest"];
let draftSaveTimer = null;
let restoringDraft = false;

function readDraft() { try { const draft = JSON.parse(localStorage.getItem(draftKey)); return draft?.schemaVersion === 1 ? draft : null; } catch { return null; } }
function draftSnapshot() {
  const fields = Object.fromEntries(draftFieldIds.map(id => [id, $(id)?.value ?? ""]));
  const presets = Object.fromEntries([...document.querySelectorAll("#configs tr")].map(row => [row.dataset.config, { selected: row.querySelector('input[name="config"]').checked, repetitions: row.querySelector(".preset-repetitions").value, readPercent: row.querySelector(".preset-read-percent").value, consistency: row.querySelector(".preset-consistency").value, duration: row.querySelector(".preset-duration").value, load: row.querySelector(".preset-load")?.value, concurrency: row.querySelector(".preset-concurrency")?.value }]));
  return { schemaVersion: 1, savedAt: new Date().toISOString(), step: currentStep, infrastructureMode: document.querySelector('input[name="infra-mode"]:checked')?.value, runMode: runMode(), selectedTargets: [...selectedTargets], fields, presets };
}
function saveDraft() { if (restoringDraft || !bootstrap) return; const draft = draftSnapshot(); localStorage.setItem(draftKey, JSON.stringify(draft)); $("draft-status").textContent = `Saved locally at ${new Date(draft.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`; }
function scheduleDraftSave() { if (restoringDraft) return; clearTimeout(draftSaveTimer); draftSaveTimer = setTimeout(saveDraft, 250); }
function setDraftField(id, item) { const element = $(id); if (!element || item == null) return; if (element.tagName === "SELECT" && ![...element.options].some(option => option.value === String(item))) return; element.value = String(item); }
function applyPresetDraft(presets = {}) { for (const row of document.querySelectorAll("#configs tr")) { const item = presets[row.dataset.config]; if (!item) continue; row.querySelector('input[name="config"]').checked = Boolean(item.selected); for (const [selector, key] of [[".preset-repetitions", "repetitions"], [".preset-read-percent", "readPercent"], [".preset-consistency", "consistency"], [".preset-duration", "duration"], [".preset-load", "load"], [".preset-concurrency", "concurrency"]]) { const control = row.querySelector(selector); if (control && item[key] != null) control.value = item[key]; } row.querySelector(".preset-read-percent").dispatchEvent(new Event("input")); } updatePresetCount(); }
async function restoreDraft(draft) {
  if (!draft) { void autoDiscoverActiveTarget(); return; }
  restoringDraft = true;
  for (const id of draftFieldIds) setDraftField(id, draft.fields?.[id]);
  const infra = document.querySelector(`input[name="infra-mode"][value="${CSS.escape(draft.infrastructureMode || "existing")}"]`); if (infra) infra.checked = true;
  const mode = document.querySelector(`input[name="run-mode"][value="${CSS.escape(draft.runMode || "async")}"]`); if (mode) mode.checked = true;
  selectedTargets.clear(); for (const target of draft.selectedTargets || []) if (["aws", "adb", "ndcs"].includes(target)) selectedTargets.add(target);
  syncDestinationProducts(); setDraftField("destination-product", draft.fields?.["destination-product"]); syncCloudCatalog(); applyPresetDraft(draft.presets);
  restoringDraft = false;
  await discoverDestinations({ automatic: true });
  restoringDraft = true; for (const id of draftFieldIds) setDraftField(id, draft.fields?.[id]); restoringDraft = false;
  for (const target of ["aws", "adb", "ndcs"]) $(`${target}-enabled`).checked = selectedTargets.has(target);
  for (const prefix of ["aws-table", "adb-table", "ndcs-table"]) syncManual(prefix);
  renderDestinationSummary(); renderDestinationDetails(); syncLiveChartVisibility(); showStep(draft.step || 1);
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
  const draft = readDraft();
  profiles($("aws-profile"), bootstrap.profiles.aws, draft?.fields?.["aws-profile"] || "dynamodb_poc"); profiles($("adb-profile"), bootstrap.profiles.oci, draft?.fields?.["adb-profile"] || "PITWALL_API"); profiles($("ndcs-profile"), bootstrap.profiles.oci, draft?.fields?.["ndcs-profile"] || "PITWALL_API");
  $("image-digest").value = bootstrap.defaults.imageDigest || ""; renderRunnerImage();
  $("adb-table-manual").value = localStorage.getItem("kvs-dashboard-adb-table") || "";
  renderConfigs(bootstrap.configs); syncOverrideApplicability();
  $("warnings").innerHTML = bootstrap.profiles.warnings.map(item => `<div class="callout warning">${escapeHtml(item)}</div>`).join("");
  $("connection").textContent = `${bootstrap.profiles.aws.length} AWS | ${bootstrap.profiles.oci.length} OCI profiles`; $("connection").className = "status ok";
  await restoreDraft(draft);
  const savedRun = localStorage.getItem("kvs-dashboard-run-id"); if (savedRun) void monitorRun(savedRun, "async", true);
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
function addDestination() {
  const name = activeTarget(), resource = resourceValue(`${name}-table`), runner = value(`${name}-runner`);
  if (!resource || resource === "__manual__") throw new Error("Select a table before adding the destination");
  if (!runner) throw new Error("Select a regional runner before adding the destination");
  selectedTargets.add(name); $("aws-enabled").checked = selectedTargets.has("aws"); $("adb-enabled").checked = selectedTargets.has("adb"); $("ndcs-enabled").checked = selectedTargets.has("ndcs");
  renderDestinationSummary(); renderDestinationDetails();
  $("runner-status").className = "callout"; $("runner-status").textContent = `${name.toUpperCase()} destination added. Choose another provider/product to add more.`;
  scheduleDraftSave();
}
function selectedRunner(id) { return discovered?.oci?.find(item => item.id === value(id)) || discovered?.aws?.find(item => item.id === value(id)) || {}; }
function resourceValue(prefix) { return value(prefix) === "__manual__" ? value(`${prefix}-manual`) : value(prefix); }
function specification() {
  const mode = document.querySelector('input[name="infra-mode"]:checked').value;
  const adbRunner = selectedRunner("adb-runner"), ndcsRunner = selectedRunner("ndcs-runner");
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
  return { schemaVersion: 1, infrastructure: mode === "managed" ? { mode, repositoryPath: value("infra-repo"), gitRef: value("infra-ref"), terraformWorkspace: value("infra-workspace"), apply: false } : { mode }, targets: { aws: { enabled: selectedTargets.has("aws"), profile: value("aws-profile"), region: value("aws-region"), resource: resourceValue("aws-table"), runnerId: value("aws-runner") }, adb: { enabled: selectedTargets.has("adb"), profile: value("adb-profile"), region: value("adb-region"), resource: resourceValue("adb-table"), databaseId: value("adb-database"), runnerId: value("adb-runner"), runnerCompartmentId: adbRunner.compartmentId, compartmentId: value("adb-compartment"), evidenceBucket: value("adb-artifact-bucket") }, ndcs: { enabled: selectedTargets.has("ndcs"), profile: value("ndcs-profile"), region: value("ndcs-region"), resource: resourceValue("ndcs-table"), runnerId: value("ndcs-runner"), runnerCompartmentId: ndcsRunner.compartmentId, compartmentId: value("ndcs-compartment"), evidenceBucket: value("ndcs-artifact-bucket") } }, configs, presetRepetitions, presetOverrides, overrides: {}, execution: { mode: runMode(), mutableParameters: false }, artifactBucket: value("artifact-bucket"), imageDigest: value("image-digest"), writeAuthorization: $("write-authorization").checked };
}

function runnerOptions(select, values, preferredPattern) {
  const list = Array.isArray(values) ? values.filter(item => item && typeof item === "object") : [];
  select.replaceChildren(new Option("Select a discovered runner", ""), ...list.map(item => { const blocked = incompatibleRunners.has(item.id), option = new Option(`${item.name || "Unnamed"} | ${item.placement || "unknown"} | ${item.remoteControl || "unknown"}${blocked ? " | INCOMPATIBLE: replace or repair" : ""}`, item.id || ""); option.disabled = blocked; return option; }));
  const preferred = list.find(item => !incompatibleRunners.has(item.id) && preferredPattern.test(item.name || "")); if (preferred) select.value = preferred.id;
}
function flagIncompatibleRunner(run) {
  if (run.status !== "failed" || !/ocarun user requires passwordless access to Podman/i.test(run.error || "")) return;
  const target = /-adb-preflight/i.test(run.error) ? "adb" : /-ndcs-preflight/i.test(run.error) ? "ndcs" : null; if (!target) return;
  const runner = value(`${target}-runner`); if (!runner || incompatibleRunners.has(runner)) return;
  incompatibleRunners.add(runner); localStorage.setItem(incompatibleRunnerKey, JSON.stringify([...incompatibleRunners]));
  const option = [...$(`${target}-runner`).options].find(item => item.value === runner); if (option) { option.disabled = true; option.textContent += " | INCOMPATIBLE: replace or repair"; }
  selectedTargets.delete(target); $(`${target}-enabled`).checked = false; $(`${target}-runner`).value = ""; renderDestinationSummary(); scheduleDraftSave();
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
function filterOptions(input) { const select = $(input.dataset.filterFor), query = input.value.trim().toLowerCase(); if (!select) return; for (const option of select.options) option.hidden = Boolean(query) && option.value !== select.value && !option.textContent.toLowerCase().includes(query); }
function bytes(value, fallback = "Not exposed by provider inventory") { if (value == null) return fallback; const units = ["B", "KB", "MB", "GB", "TB"]; let amount = Number(value), unit = 0; while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; } return `${number(amount)} ${units[unit]}`; }
function autoscalingLabel(table) {
  if (table?.billingMode === "PAY_PER_REQUEST") return "On-demand / service managed";
  if (table?.autoscaling?.mode === "SERVICE_MANAGED") return "Service managed";
  const read = table?.autoscaling?.read, write = table?.autoscaling?.write;
  if (read || write) return [read && `Read ${read.min}-${read.max}`, write && `Write ${write.min}-${write.max}`].filter(Boolean).join("; ");
  return table?.autoscaling?.mode === "NOT_DETECTED" ? "Not configured / not exposed" : "Not configured";
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
  return `<article class="resource-detail"><div class="resource-detail-heading"><h3>${escapeHtml(provider)} · ${escapeHtml(table.name)}</h3><button type="button" data-remove-destination="${target}" aria-label="Remove ${escapeHtml(provider)}">×</button></div><p>${verified ? "Live provider metadata" : "Selected destination · not live-verified"}</p><dl>${rows.map(([key, item]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(item)}</dd>`).join("")}</dl>${verification}</article>`;
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
    lookupOptions($("adb-database"), databases, { label: item => `${item.name} | ${item.state} | ${item.computeCount ?? item.cpuCoreCount ?? "?"} compute`, preferred: destinations.adbRuntimeDatabaseId, placeholder: "Select an Autonomous Database" });
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
    if (ready) await lookupDestinations({ manageButton: false, probeAdbTables: !automatic });
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
  const spec = specification(); const targets = Object.entries(spec.targets).filter(([, target]) => target.enabled).map(([name, target]) => `${name.toUpperCase()} (${target.profile || "no profile"}, ${target.region})`);
  const repetitions = Object.values(spec.presetRepetitions).reduce((sum, count) => sum + count, 0), cards = [["Targets", targets.join("; ") || "None"], ["Infrastructure", spec.infrastructure.mode], ["Workloads", `${spec.configs.length} preset(s), ${repetitions} session(s)`], ["Execution", `${spec.execution.mode}; immutable parameters`], ["Preset values", "Configured independently in the workload matrix"]];
  $("review-summary").innerHTML = cards.map(([label, item]) => `<div class="summary-card"><span>${escapeHtml(label)}</span><b>${escapeHtml(item)}</b></div>`).join("");
}

function showStep(step) {
  currentStep = Math.max(1, Math.min(5, step)); document.querySelectorAll(".wizard-panel").forEach(panel => { panel.hidden = Number(panel.dataset.step) !== currentStep; });
  document.querySelectorAll(".stepper li").forEach((item, index) => { item.classList.toggle("active", index + 1 === currentStep); item.classList.toggle("done", index + 1 < currentStep); });
  $("back").disabled = currentStep === 1; $("next").hidden = currentStep === 5; $("step-label").textContent = `Step ${currentStep} of 5`;
  if (currentStep === 5) { renderReview(); void preview(); }
  window.scrollTo({ top: 0, behavior: "smooth" });
  scheduleDraftSave();
}

function showPreview(preview) {
  const warnings = preview.warnings?.length ? `<ul>${preview.warnings.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "";
  $("preview-status").className = `callout${preview.warnings?.length ? " warning" : ""}`; $("preview-status").innerHTML = `<b>Valid immutable preview.</b> Infrastructure: ${escapeHtml(preview.infrastructure.mode)}. No cloud mutation was performed.${warnings}`;
  const values = [["Synchronized workload sessions", preview.totals.tripletSessions], ["Target executions", preview.totals.targetExecutions], ["Scheduled operations", preview.totals.totalScheduledOperations], ["Database minutes", preview.totals.totalDatabaseMinutes]];
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
  liveChartSamples.push({ at: sampleAt, offered: run.currentSession.offeredOperationsPerSecond, ...metrics });
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
  if (!logs.length) view.innerHTML = '<div class="terminal-empty"><span>$</span> Waiting for the next pipeline event...</div>';
  else view.innerHTML = logs.map(item => { const timestamp = item.at ? new Date(item.at).toISOString().slice(11, 23) : "--:--:--.---"; return `<div class="terminal-row ${escapeHtml(item.level || "info")}"><span class="terminal-time">${escapeHtml(timestamp)}</span><span class="terminal-level">${escapeHtml(item.level || "info")}</span><span class="terminal-stage">${escapeHtml(item.stage || "pipeline")}</span><span class="terminal-target">${escapeHtml(item.target || "control")}</span><span class="terminal-message">${escapeHtml(item.message || "")}</span></div>`; }).join("");
  if ($("log-autoscroll").checked) view.scrollTop = view.scrollHeight;
}

function showSmoke(run) {
  const progress = run.progress || {}; const terminal = ["complete", "failed"].includes(run.status); const latency = run.summary?.successfulServiceLatencyMs || {};
  const cloud = run.kind === "cloud-benchmark" || run.kind === "cloud-acceptance", session = run.currentSession;
  const accounting = cloud ? ` | ${session ? `session ${escapeHtml(session.id)} (${session.index}/${session.total}) | ` : ""}shared T0 ${escapeHtml(run.sharedStartAt || "pending")}` : ` | ${number(progress.accounted)} of ${number(progress.scheduled)} operations accounted`;
  const running = ["queued", "running"].includes(run.status), statusIndicator = running ? '<span class="run-light" aria-hidden="true"></span>' : "";
  $("smoke-status").className = `callout run-status ${run.status}${run.status === "failed" ? " error" : ""}`; $("smoke-status").innerHTML = `${statusIndicator}<b>${escapeHtml(run.status.toUpperCase())}</b> | run ${escapeHtml(run.id)}${accounting}.${run.error ? ` ${escapeHtml(run.error)}` : ""}`;
  const stages = run.stages || [], processed = stages.filter(stage => ["complete", "failed"].includes(stage.status)).length, percentage = stages.length ? Math.round(processed * 100 / stages.length) : 0, activeStage = stages.find(stage => stage.status === "running"), failedStage = stages.find(stage => stage.status === "failed"), progressLabel = failedStage ? `Stopped at ${failedStage.name.replaceAll("-", " ")}` : activeStage ? `Running ${activeStage.name.replaceAll("-", " ")}` : percentage === 100 ? "All pipeline stages completed" : "Waiting to start";
  $("pipeline").innerHTML = stages.length ? `<div class="pipeline-summary"><div class="pipeline-progress-heading"><div><b>${percentage}%</b><span>${escapeHtml(progressLabel)}</span></div><small>${processed} of ${stages.length} steps processed</small></div><div class="pipeline-track" role="progressbar" aria-label="Benchmark pipeline" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percentage}"><span style="width:${percentage}%"></span></div><ol class="pipeline-steps">${stages.map((stage, index) => { const symbol = stage.status === "complete" ? "✓" : stage.status === "failed" ? "!" : stage.status === "running" ? "●" : String(index + 1); return `<li class="${escapeHtml(stage.status)}" title="${escapeHtml(stage.detail || stage.status)}"><span>${symbol}</span><b>${escapeHtml(stage.name.replaceAll("-", " "))}</b></li>`; }).join("")}</ol></div>` : "";
  const targetMetrics = run.targetMetrics || {};
  const showLiveChart = cloud && run.mode === "live"; $("live-chart-panel").classList.toggle("hidden", !showLiveChart); if (showLiveChart) { captureLiveSample(run); if (!session) $("live-chart-caption").textContent = `Waiting for workload · current run status: ${run.status}`; renderLiveCharts(); }
  if (cloud && Object.keys(targetMetrics).length) $("live-stats").innerHTML = Object.entries(targetMetrics).map(([target, metric]) => `<div class="target-live provider-${escapeHtml(target)}"><h4>${escapeHtml(target.toUpperCase())}${metric.provisional ? " · LIVE PREVIEW" : " · FINAL"}</h4><div class="stats"><div class="stat"><span>Completed</span><b>${number(metric.completed)}</b></div><div class="stat"><span>Failed</span><b>${number(metric.failed)}</b></div><div class="stat"><span>Ops/s</span><b>${number(metric.operationsPerSecond)}</b></div><div class="stat"><span>In flight</span><b>${number(metric.inFlight)}</b></div><div class="stat"><span>Latest latency ms</span><b>${number(metric.latestLatencyMs)}</b></div><div class="stat"><span>${metric.provisional ? "Rolling P95 ms" : "Final P95 ms"}</span><b>${number(metric.rollingP95Ms ?? metric.p95)}</b></div><div class="stat"><span>Final P99 ms</span><b>${number(metric.p99)}</b></div><div class="stat"><span>Final max ms</span><b>${number(metric.max)}</b></div></div></div>`).join("");
  else { const cloudCompleted = run.summaries ? Object.values(run.summaries).reduce((sum, item) => sum + item.completed, 0) : null; const values = [["Completed", cloudCompleted ?? progress.completed ?? 0], ["Failed", progress.failed ?? (run.summaries ? Object.values(run.summaries).reduce((sum, item) => sum + item.failed, 0) : 0)], ["Current ops/s", progress.achievedOperationsPerSecond ?? run.summary?.achievedOperationsPerSecond], ["In flight", progress.inFlight ?? 0], ["Latest latency ms", progress.latestLatencyMs], ["Final P95 ms", latency.p95]]; $("live-stats").innerHTML = values.map(([label, metric]) => `<div class="stat"><span>${escapeHtml(label)}</span><b>${number(metric)}</b></div>`).join(""); }
  renderExecutionLog(run);
  flagIncompatibleRunner(run);
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
$("destination-cloud").addEventListener("change", () => { syncDestinationProducts(); discovered = null; destinations = null; void autoDiscoverActiveTarget(); });
$("destination-product").addEventListener("change", () => { syncCloudCatalog(); discovered = null; destinations = null; void autoDiscoverActiveTarget(); });
$("add-destination").addEventListener("click", () => { try { addDestination(); } catch (error) { $("runner-status").className = "callout error"; $("runner-status").textContent = error.message; } });
$("destination-summary").addEventListener("click", event => { const button = event.target.closest("[data-remove-destination]"); if (!button) return; selectedTargets.delete(button.dataset.removeDestination); $(`${button.dataset.removeDestination}-enabled`).checked = false; renderDestinationSummary(); renderDestinationDetails(); scheduleDraftSave(); });
document.querySelectorAll("[data-go-step]").forEach(button => button.addEventListener("click", () => showStep(Number(button.dataset.goStep))));
$("back").addEventListener("click", () => showStep(currentStep - 1)); $("next").addEventListener("click", () => showStep(currentStep + 1));
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
$("clear-log").addEventListener("click", () => { terminalClearedCount = terminalLogs.length; $("execution-log").innerHTML = '<div class="terminal-empty"><span>$</span> View cleared. New events will continue to appear.</div>'; });
$("copy-log").addEventListener("click", async () => { const button = $("copy-log"); try { await navigator.clipboard.writeText(terminalText(terminalLogs.slice(terminalClearedCount))); button.textContent = "Copied"; } catch { button.textContent = "Copy failed"; } setTimeout(() => { button.textContent = "Copy"; }, 1500); });
$("reset-draft").addEventListener("click", () => { localStorage.removeItem(draftKey); localStorage.removeItem("kvs-dashboard-adb-table"); location.reload(); });
document.querySelector("main").addEventListener("input", event => { if (!event.target.matches(".option-search") && event.target.id !== "write-authorization") scheduleDraftSave(); });
document.querySelector("main").addEventListener("change", event => { if (event.target.id !== "write-authorization") scheduleDraftSave(); });
$("preview-button").addEventListener("click", preview); $("download").addEventListener("click", downloadSpec); $("start-smoke").addEventListener("click", startSmoke); $("start-benchmark").addEventListener("click", startCloud); $("discover-destinations").addEventListener("click", discoverDestinations);
function showLoadError(error) { $("connection").textContent = error.message; $("connection").className = "status error"; }
syncDestinationProducts(); renderDestinationSummary(); syncLiveChartVisibility(); showStep(1); load().catch(showLoadError);
