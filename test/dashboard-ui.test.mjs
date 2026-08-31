import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "src", "dashboard", "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "src", "dashboard", "public", "app.js"), "utf8");

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
});

test("dashboard defaults to async and exposes live progress and package download", () => {
  assert.match(html, /name="run-mode" value="async" checked/);
  assert.match(html, /name="run-mode" value="live"/);
  assert.match(html, /Download benchmark output \(\.zip\)/);
  assert.match(app, /mode === "live" \? 200 : 1000/);
  assert.match(app, /localStorage\.setItem\("kvs-dashboard-run-id"/);
});

test("dashboard exposes cloud and local test actions with model-aware overrides", () => {
  assert.match(html, /id="start-benchmark"[^>]*>Run cloud acceptance test/);
  assert.match(html, /id="start-smoke"[^>]*>Run local functional test/);
  assert.match(html, /id="discover-runners"/);
  assert.match(html, /id="lookup-destinations"/);
  assert.match(html, /id="adb-compartment"/);
  assert.match(html, /id="ndcs-compartment"/);
  assert.match(html, /one, two, or three enabled targets/);
  assert.match(html, /id="pipeline"/);
  assert.doesNotMatch(html, /Cloud execution adapter pending/);
  assert.match(app, /syncOverrideApplicability/);
  assert.match(app, /Runner discovery did not complete/);
  assert.match(app, /Destination lookup failed during \$\{stage\}/);
  assert.match(app, /Array\.isArray\(result\?\.oci\)/);
  assert.match(app, /function optionElement/);
  assert.match(app, /ADB compartment rendering/);
  assert.match(app, /OCI NoSQL table rendering/);
});
