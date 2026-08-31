import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "src", "dashboard", "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "src", "dashboard", "public", "app.js"), "utf8");
const theme = fs.readFileSync(path.join(root, "src", "dashboard", "public", "theme.css"), "utf8");

test("dashboard exposes a five-step wizard with contextual workload help", () => {
  assert.equal((html.match(/class="wizard-panel"/g) || []).length, 5);
  assert.ok((html.match(/class="info"/g) || []).length >= 7);
  assert.match(html, /Review and run/);
  assert.match(app, /showStep\(currentStep \+ 1\)/);
  assert.match(html, /class="table-wrap preset-table"/);
  assert.match(html, /Custom runtime overrides/);
  assert.match(html, /<th scope="col">Repetitions<\/th>/);
  assert.doesNotMatch(html, /id="repetitions"/);
  assert.match(app, /presetRepetitions/);
  assert.match(html, /id="select-recommended"/);
  assert.match(app, /function selectPresets/);
  assert.ok((html.match(/class="option-search"/g) || []).length >= 8);
  assert.match(app, /function filterOptions/);
  assert.match(app, /select\.size = 1/);
  assert.match(html, /private S3 bucket/);
  assert.match(html, /id="cloud-aws"/); assert.match(html, /id="cloud-oci"/);
  assert.match(html, /No SSH, SCP, private key, or public IP is used/);
  assert.match(html, /Provisional performance timeline/); assert.match(app, /function renderLiveCharts/);
  assert.match(html, /theme\.css/); assert.match(theme, /--bg-header: #1a1a2e/); assert.match(theme, /--accent-teal: #0e7a6e/);
});

test("dashboard defaults to async and exposes live progress and package download", () => {
  assert.match(html, /name="run-mode" value="async" checked/);
  assert.match(html, /name="run-mode" value="live"/);
  assert.match(html, /Download benchmark output \(\.zip\)/);
  assert.match(app, /mode === "live" \? 200 : 1000/);
  assert.match(app, /localStorage\.setItem\("kvs-dashboard-run-id"/);
});

test("dashboard exposes cloud and local test actions with model-aware overrides", () => {
  assert.match(html, /id="start-benchmark"[^>]*>Run selected cloud benchmark/);
  assert.match(html, /id="start-smoke"[^>]*>Run local functional test/);
  assert.match(html, /id="discover-destinations"[^>]*>Discover destinations/);
  assert.doesNotMatch(html, /id="discover-runners"/);
  assert.doesNotMatch(html, /id="lookup-destinations"/);
  assert.match(html, /id="adb-compartment"/);
  assert.match(html, /id="adb-live-table-lookup"/);
  assert.match(html, /id="ndcs-compartment"/);
  assert.match(html, /against any enabled targets/i);
  assert.match(html, /id="pipeline"/);
  assert.doesNotMatch(html, /Cloud execution adapter pending/);
  assert.match(app, /syncOverrideApplicability/);
  assert.match(app, /Runner discovery did not complete/);
  assert.match(app, /async function discoverDestinations/);
  assert.match(app, /Destination lookup failed during \$\{stage\}/);
  assert.match(app, /Array\.isArray\(adbResult\?\.oci\)/);
  assert.match(app, /Array\.isArray\(ndcsResult\?\.oci\)/);
  assert.match(app, /select\.innerHTML = optionHtml/);
  assert.doesNotMatch(app, /function optionElement/);
  assert.match(app, /getValue = item => item\?\.id \|\| item/);
  assert.doesNotMatch(app, /valueOf = item/);
  assert.match(app, /ADB compartment rendering/);
  assert.match(app, /OCI NoSQL table rendering/);
  assert.match(app, /adbOciProfile: value\("adb-profile"\)/);
  assert.match(app, /ndcsOciProfile: value\("ndcs-profile"\)/);
  assert.match(app, /probeAdbTables: \$\("adb-live-table-lookup"\)\.checked/);
  assert.match(app, /kvs-dashboard-adb-table/);
  assert.match(app, /destinations\.adbCompartments/);
  assert.match(app, /destinations\.ndcsCompartments/);
});

test("destination option defaults do not collide with Object prototype methods", () => {
  const options = { label: item => item.path };
  const { getValue = item => item?.id || item } = options;
  assert.equal(getValue({ id: "compartment-1", path: "tenancy root / test" }), "compartment-1");
  assert.equal(Object.hasOwn(options, "getValue"), false);
});
