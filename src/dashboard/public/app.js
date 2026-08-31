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

function selected(select, preferred) { if (!select.options.length) return; ([...select.options].find(option => option.value === preferred) || select.options[0]).selected = true; }
function profiles(select, values, preferred) { select.replaceChildren(...values.map(item => new Option(item, item))); selected(select, preferred); }

function renderConfigs(configs) {
  $("configs").replaceChildren(...configs.map(config => {
    const label = document.createElement("label"); label.className = "config-option";
    const input = document.createElement("input"); input.type = "checkbox"; input.value = config.file; input.checked = config.file.includes("5m") || config.file.includes("mixed-70-30"); input.name = "config";
    const text = document.createElement("span"); text.textContent = config.name;
    const detail = document.createElement("small"); detail.textContent = `${config.model} | ${config.consistency} | ${config.readPercent}/${config.writePercent} | ${config.durationSeconds ?? "variable"} s`;
    const info = document.createElement("button"); info.type = "button"; info.className = "info"; info.textContent = "i"; info.dataset.help = `Checked-in workload: ${config.model} scheduling, ${config.consistency} consistency, ${config.readPercent}% reads and ${config.writePercent}% writes.`; info.setAttribute("aria-label", `About ${config.name}`); info.addEventListener("click", event => event.preventDefault());
    input.addEventListener("change", syncOverrideApplicability);
    text.append(detail, info); label.append(input, text); return label;
  }));
}

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
function specification() {
  const mode = document.querySelector('input[name="infra-mode"]:checked').value;
  const overrides = { durationSeconds: optionalNumber("duration"), readPercent: optionalNumber("read-percent"), writePercent: optionalNumber("write-percent"), rateMultiplier: optionalNumber("rate-multiplier"), fixedConcurrency: optionalNumber("fixed-concurrency"), consistency: value("consistency") || undefined, executionMode: value("execution-mode") || undefined };
  Object.keys(overrides).forEach(key => overrides[key] === undefined && delete overrides[key]);
  const adbRunner = selectedRunner("adb-runner"), ndcsRunner = selectedRunner("ndcs-runner");
  return { schemaVersion: 1, infrastructure: mode === "managed" ? { mode, repositoryPath: value("infra-repo"), gitRef: value("infra-ref"), terraformWorkspace: value("infra-workspace"), apply: false } : { mode }, targets: { aws: { enabled: $("aws-enabled").checked, profile: value("aws-profile"), region: value("aws-region"), resource: value("aws-table"), runnerId: value("aws-runner") }, adb: { enabled: $("adb-enabled").checked, profile: value("adb-profile"), region: value("adb-region"), resource: value("adb-table"), runnerId: value("adb-runner"), runnerHost: adbRunner.publicIp, compartmentId: adbRunner.compartmentId }, ndcs: { enabled: $("ndcs-enabled").checked, profile: value("ndcs-profile"), region: value("ndcs-region"), resource: value("ndcs-table"), runnerId: value("ndcs-runner"), runnerHost: ndcsRunner.publicIp, compartmentId: ndcsRunner.compartmentId } }, configs: [...document.querySelectorAll('input[name="config"]:checked')].map(input => input.value), repetitions: Number(value("repetitions")), overrides, execution: { mode: runMode(), mutableParameters: false }, artifactBucket: value("artifact-bucket"), imageDigest: value("image-digest"), writeAuthorization: $("write-authorization").checked };
}

function runnerOptions(select, values, preferredPattern) {
  select.replaceChildren(new Option("Select a discovered runner", ""), ...values.map(item => new Option(`${item.name} | ${item.placement || "unknown"} | ${item.remoteControl}`, item.id)));
  const preferred = values.find(item => preferredPattern.test(item.name)); if (preferred) select.value = preferred.id;
}

async function discoverRunners() {
  $("discover-runners").disabled = true; $("runner-status").className = "callout"; $("runner-status").textContent = "Checking cloud identities, running instances, remote-control health, placement, and evidence buckets...";
  try {
    const response = await fetch("/api/discover-runners", { method: "POST", headers: { "content-type": "application/json", "x-kvs-csrf": bootstrap.csrfToken }, body: JSON.stringify({ awsProfile: value("aws-profile"), awsRegion: value("aws-region"), ociProfile: value("adb-profile"), ociRegion: value("adb-region") }) });
    discovered = await response.json(); if (!response.ok) throw new Error(discovered.error || `Discovery failed (${response.status})`);
    runnerOptions($("aws-runner"), discovered.aws, /aws.*runner|runner.*aws/i); runnerOptions($("adb-runner"), discovered.oci, /adb.*runner/i); runnerOptions($("ndcs-runner"), discovered.oci, /ndcs|nosql/i);
    $("artifact-bucket").replaceChildren(new Option("Select an evidence bucket", ""), ...(discovered.artifactBuckets || []).map(name => new Option(name, name))); if (discovered.artifactBuckets?.length === 1) $("artifact-bucket").value = discovered.artifactBuckets[0];
    $("runner-status").className = "callout"; $("runner-status").innerHTML = `<b>Discovery complete.</b> ${discovered.aws.length} AWS and ${discovered.oci.length} OCI runner(s); ${discovered.artifactBuckets?.length || 0} evidence bucket(s).`;
  } catch (error) { $("runner-status").className = "callout error"; $("runner-status").textContent = error.message; }
  finally { $("discover-runners").disabled = false; }
}

function renderReview() {
  const spec = specification(); const targets = Object.entries(spec.targets).filter(([, target]) => target.enabled).map(([name, target]) => `${name.toUpperCase()} (${target.profile || "no profile"}, ${target.region})`);
  const overrideText = Object.keys(spec.overrides).length ? Object.entries(spec.overrides).map(([key, item]) => `${key}: ${item}`).join(", ") : "Profile defaults";
  const cards = [["Targets", targets.join("; ") || "None"], ["Infrastructure", spec.infrastructure.mode], ["Workloads", `${spec.configs.length} profile(s) x ${spec.repetitions} repetition(s)`], ["Execution", `${spec.execution.mode}; immutable parameters`], ["Overrides", overrideText]];
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
$("preview-button").addEventListener("click", preview); $("download").addEventListener("click", downloadSpec); $("start-smoke").addEventListener("click", startSmoke); $("start-benchmark").addEventListener("click", startCloud); $("discover-runners").addEventListener("click", discoverRunners); $("refresh").addEventListener("click", () => load().catch(showLoadError));
function showLoadError(error) { $("connection").textContent = error.message; $("connection").className = "status error"; }
showStep(1); load().catch(showLoadError);
