const $ = id => document.getElementById(id);
let bootstrap = null;
let lastSpec = null;

function selected(select, preferred) {
  if (!select.options.length) return;
  const option = [...select.options].find(value => value.value === preferred) || select.options[0];
  option.selected = true;
}

function profiles(select, values, preferred) {
  select.replaceChildren(...values.map(value => new Option(value, value)));
  selected(select, preferred);
}

function renderConfigs(configs) {
  $("configs").replaceChildren(...configs.map((config, index) => {
    const label = document.createElement("label"); label.className = "config-option";
    const input = document.createElement("input"); input.type = "checkbox"; input.value = config.file; input.checked = config.file.includes("5m") || config.file.includes("mixed-70-30"); input.name = "config";
    const text = document.createElement("span"); text.textContent = config.name;
    const detail = document.createElement("small"); detail.textContent = `${config.model} · ${config.consistency} · ${config.readPercent}/${config.writePercent} · ${config.durationSeconds ?? "variable"} s`;
    text.append(detail); label.append(input, text); return label;
  }));
}

async function load() {
  $("connection").textContent = "Discovering profiles…"; $("connection").className = "status";
  const response = await fetch("/api/bootstrap", { cache: "no-store" });
  if (!response.ok) throw new Error(`Bootstrap failed (${response.status})`);
  bootstrap = await response.json();
  profiles($("aws-profile"), bootstrap.profiles.aws, "dynamodb_poc");
  profiles($("adb-profile"), bootstrap.profiles.oci, "PITWALL_API");
  profiles($("ndcs-profile"), bootstrap.profiles.oci, "PITWALL_API");
  renderConfigs(bootstrap.configs);
  $("warnings").innerHTML = bootstrap.profiles.warnings.map(value => `<div class="callout warning">${escapeHtml(value)}</div>`).join("");
  $("connection").textContent = `${bootstrap.profiles.aws.length} AWS · ${bootstrap.profiles.oci.length} OCI profiles`;
  $("connection").className = "status ok";
}

const value = id => $(id).value.trim();
const optionalNumber = id => value(id) === "" ? undefined : Number(value(id));

function specification() {
  const mode = document.querySelector('input[name="infra-mode"]:checked').value;
  const overrides = { durationSeconds: optionalNumber("duration"), readPercent: optionalNumber("read-percent"), writePercent: optionalNumber("write-percent"), rateMultiplier: optionalNumber("rate-multiplier"), fixedConcurrency: optionalNumber("fixed-concurrency"), consistency: value("consistency") || undefined, executionMode: value("execution-mode") || undefined };
  Object.keys(overrides).forEach(key => overrides[key] === undefined && delete overrides[key]);
  return {
    schemaVersion: 1,
    infrastructure: mode === "managed" ? { mode, repositoryPath: value("infra-repo"), gitRef: value("infra-ref"), terraformWorkspace: value("infra-workspace"), apply: false } : { mode },
    targets: {
      aws: { enabled: $("aws-enabled").checked, profile: value("aws-profile"), region: value("aws-region"), resource: value("aws-table") },
      adb: { enabled: $("adb-enabled").checked, profile: value("adb-profile"), region: value("adb-region"), resource: value("adb-table") },
      ndcs: { enabled: $("ndcs-enabled").checked, profile: value("ndcs-profile"), region: value("ndcs-region"), resource: value("ndcs-table") }
    },
    configs: [...document.querySelectorAll('input[name="config"]:checked')].map(input => input.value),
    repetitions: Number(value("repetitions")), overrides
  };
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
const number = value => value == null ? "—" : Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 });

function showPreview(preview) {
  $("preview-status").className = "callout";
  $("preview-status").innerHTML = `<b>Valid preview.</b> Infrastructure intent: ${escapeHtml(preview.infrastructure.mode)}. No cloud mutation has been performed.`;
  const values = [["Triplet sessions", preview.totals.tripletSessions], ["Target executions", preview.totals.targetExecutions], ["Scheduled operations", number(preview.totals.totalScheduledOperations)], ["Database minutes", number(preview.totals.totalDatabaseMinutes)]];
  $("totals").innerHTML = values.map(([label, metric]) => `<div class="stat"><span>${escapeHtml(label)}</span><b>${escapeHtml(metric)}</b></div>`).join("");
  $("matrix").innerHTML = preview.rows.map(row => `<tr><td>${escapeHtml(row.id)}</td><td>${escapeHtml(row.configFile)}</td><td>${escapeHtml(row.loadModel)}</td><td>${row.readPercent}/${row.writePercent}</td><td>${escapeHtml(row.consistency)}</td><td>${number(row.durationSeconds)} s</td><td>${number(row.scheduledOperationsPerTarget)}</td><td>${number(row.averageScheduledOperationsPerSecond)}</td><td>${number(row.averageScheduledOperationsPerMinute)}</td><td>${escapeHtml(row.targets.join(", "))}</td><td><code>${escapeHtml(row.configSha256.slice(0, 12))}…</code></td></tr>`).join("");
  $("download").disabled = false;
}

async function preview() {
  try {
    lastSpec = specification();
    const response = await fetch("/api/preview", { method: "POST", headers: { "content-type": "application/json", "x-kvs-csrf": bootstrap.csrfToken }, body: JSON.stringify(lastSpec) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Preview failed (${response.status})`);
    showPreview(result);
  } catch (error) {
    $("preview-status").className = "callout error"; $("preview-status").textContent = error.message; $("download").disabled = true;
  }
}

function download() {
  const blob = new Blob([`${JSON.stringify(lastSpec, null, 2)}\n`], { type: "application/json" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `kvs-run-spec-${new Date().toISOString().replace(/[:.]/g, "-")}.json`; link.click(); URL.revokeObjectURL(link.href);
}

function showSmoke(run) {
  const progress = run.progress || {};
  $("smoke-progress").max = progress.scheduled || 20;
  $("smoke-progress").value = progress.accounted || 0;
  const terminal = ["complete", "failed"].includes(run.status);
  $("smoke-status").className = `callout${run.status === "failed" ? " error" : ""}`;
  $("smoke-status").innerHTML = `<b>${escapeHtml(run.status.toUpperCase())}</b> — ${number(progress.accounted)} of ${number(progress.scheduled)} operations accounted.${run.error ? ` ${escapeHtml(run.error)}` : ""}`;
  const latency = run.summary?.successfulServiceLatencyMs || {};
  const values = [["Completed", progress.completed ?? 0], ["Failed", progress.failed ?? 0], ["Achieved ops/s", run.summary?.achievedOperationsPerSecond], ["P95 latency ms", latency.p95]];
  $("smoke-results").innerHTML = values.map(([label, metric]) => `<div class="stat"><span>${escapeHtml(label)}</span><b>${number(metric)}</b></div>`).join("");
  $("smoke-output").textContent = run.output ? `Evidence: ${run.output}` : "";
  $("start-smoke").disabled = !terminal;
}

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function startSmoke() {
  $("start-smoke").disabled = true;
  $("smoke-status").className = "callout";
  $("smoke-status").textContent = "Starting local smoke test...";
  try {
    const response = await fetch("/api/local-smoke", { method: "POST", headers: { "content-type": "application/json", "x-kvs-csrf": bootstrap.csrfToken }, body: "{}" });
    let run = await response.json();
    if (!response.ok) throw new Error(run.error || `Local smoke start failed (${response.status})`);
    showSmoke(run);
    while (!["complete", "failed"].includes(run.status)) {
      await pause(200);
      const statusResponse = await fetch(`/api/runs/${encodeURIComponent(run.id)}`, { cache: "no-store" });
      run = await statusResponse.json();
      if (!statusResponse.ok) throw new Error(run.error || `Local smoke status failed (${statusResponse.status})`);
      showSmoke(run);
    }
  } catch (error) {
    $("smoke-status").className = "callout error";
    $("smoke-status").textContent = error.message;
    $("start-smoke").disabled = false;
  }
}

document.querySelectorAll('input[name="infra-mode"]').forEach(input => input.addEventListener("change", () => $("managed-fields").classList.toggle("hidden", input.value !== "managed" || !input.checked)));
$("preview-button").addEventListener("click", preview);
$("download").addEventListener("click", download);
$("start-smoke").addEventListener("click", startSmoke);
$("refresh").addEventListener("click", () => load().catch(error => { $("connection").textContent = error.message; }));
load().catch(error => { $("connection").textContent = error.message; $("connection").className = "status"; });
