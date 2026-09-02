import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { executeOciRunCommand } from "../src/dashboard/oci-run-command.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const values = Object.fromEntries(process.argv.slice(2).map(value => {
  const match = /^--([a-z-]+)=(.+)$/.exec(value); if (!match) throw new Error(`Invalid argument: ${value}`); return [match[1], match[2]];
}));
const runId = values["run-id"], sessionId = values["session-id"], target = values.target;
if (!/^cloud-[A-Za-z0-9-]+$/.test(runId || "")) throw new Error("--run-id=<cloud-run-id> is required");
if (!/^[A-Za-z0-9_.-]+-r\d+$/.test(sessionId || "")) throw new Error("--session-id=<matrix-session-id> is required");
if (!new Set(["adb", "ndcs"]).has(target)) throw new Error("--target must be adb or ndcs");
const runDirectory = path.join(repositoryRoot, ".kvs", "cloud-runs", runId), stateFile = path.join(runDirectory, ".dashboard-state.json");
if (!fs.existsSync(stateFile)) throw new Error(`Run state not found: ${runId}`);
const state = JSON.parse(fs.readFileSync(stateFile, "utf8")), spec = state.spec;
if (!spec.enabled.includes(target) || !spec.matrix.some(item => item.id === sessionId)) throw new Error("Target or session is not part of the immutable run specification");
const profile = target === "adb" ? spec.adbOciProfile : spec.ndcsOciProfile;
const region = target === "adb" ? spec.adbOciRegion : spec.ndcsOciRegion;
const compartmentId = target === "adb" ? spec.adbRunnerCompartment : spec.ndcsRunnerCompartment;
const instanceId = target === "adb" ? spec.adbRunner : spec.ndcsRunner;
const bucket = target === "adb" ? spec.adbBucket : spec.ndcsBucket;
const root = `/opt/kvs-dashboard/${runId}/run/${sessionId}/${target}`, prefix = `results/${runId}/run/${sessionId}/${target}`;
const executeCommand = (file, args, options = {}) => new Promise((resolve, reject) => execFile(file, args, { ...options, cwd: repositoryRoot, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error((stderr || stdout || error.message).trim())) : resolve(stdout)));
const shellQuote = value => `'${String(value).replaceAll("'", `'"'"'`)}'`;
const result = await executeOciRunCommand({
  executeCommand,
  profile,
  region,
  compartmentId,
  instanceId,
  displayName: `${runId}-${target}-republish-${sessionId}`,
  controlDirectory: path.join(runDirectory, "control"),
  timeoutSeconds: 1800,
  script: `#!/usr/bin/env bash
set -euo pipefail
root=${shellQuote(root)}
image=${shellQuote(spec.image)}
test -s "$root/summary.json"
test -s "$root/operations.ndjson"
sudo -n podman run --rm --network host -e OCI_REGION=${shellQuote(region)} -v "$root:/app/results:z" --entrypoint node "$image" src/cloud/oci-evidence.mjs --directory=/app/results --bucket=${shellQuote(bucket)} --prefix=${shellQuote(prefix)}
echo EVIDENCE_REPUBLISHED
`,
});
process.stdout.write(`${JSON.stringify({ runId, sessionId, target, bucket, prefix, commandId: result.commandId, status: result.status }, null, 2)}\n`);
