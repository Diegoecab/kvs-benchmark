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
  assert.equal((html.match(/class="info"/g) || []).length, 8);
  assert.match(html, /Review and run/);
  assert.match(app, /showStep\(currentStep \+ 1\)/);
});

test("dashboard defaults to async and exposes live progress and package download", () => {
  assert.match(html, /name="run-mode" value="async" checked/);
  assert.match(html, /name="run-mode" value="live"/);
  assert.match(html, /Download benchmark output \(\.zip\)/);
  assert.match(app, /mode === "live" \? 200 : 1000/);
  assert.match(app, /localStorage\.setItem\("kvs-dashboard-run-id"/);
});
