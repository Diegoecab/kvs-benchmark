import crypto from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { executeOciRunCommand } from "../src/dashboard/oci-run-command.mjs";

const execFileAsync = promisify(execFile);
const options = Object.fromEntries(process.argv.slice(2).map(value => {
  const index = value.indexOf("=");
  if (index < 1) throw new Error(`Expected --name=value, received ${value}`);
  return [value.slice(2, index), value.slice(index + 1)];
}));
for (const required of ["profile", "region", "compartment-id", "runner-id", "directory", "image"]) {
  if (!options[required]) throw new Error(`Missing --${required}`);
}
if (!options.directory.startsWith("/opt/kvs-dashboard/")) throw new Error("Evidence directory must be under /opt/kvs-dashboard");
const executeCommand = async (file, args, execOptions = {}) => {
  const { stdout } = await execFileAsync(file, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...execOptions });
  return stdout;
};
const reader = `const f=await import("node:fs");const names=f.readdirSync("/evidence");const out={files:names};for(const n of ["dataset-certificate.json","preload-summary.json","summary.json","doctor.json"]){if(names.includes(n)){try{out[n]=JSON.parse(f.readFileSync("/evidence/"+n,"utf8"))}catch{out[n]="UNREADABLE"}}}console.log(JSON.stringify(out));`;
const script = `#!/usr/bin/env bash\nset -euo pipefail\nsudo -n podman run --rm --user 0:0 -v '${options.directory.replaceAll("'", "")}:/evidence:z' --entrypoint node '${options.image.replaceAll("'", "")}' --input-type=module --eval '${reader}'\n`;
const result = await executeOciRunCommand({
  executeCommand,
  profile: options.profile,
  region: options.region,
  compartmentId: options["compartment-id"],
  instanceId: options["runner-id"],
  script,
  displayName: `kvs-read-evidence-${crypto.randomBytes(4).toString("hex")}`,
  controlDirectory: path.resolve(".kvs", "evidence-read-control"),
  timeoutSeconds: 120,
  deliveryTimeoutSeconds: 900
});
console.log(result.stdout.trim());
