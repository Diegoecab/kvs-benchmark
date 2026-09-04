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
for (const required of ["profile", "region", "compartment-id", "runner-ids", "image"]) {
  if (!options[required]) throw new Error(`Missing --${required}`);
}
const runners = options["runner-ids"].split(",").filter(Boolean);
const executeCommand = async (file, args, execOptions = {}) => {
  const { stdout } = await execFileAsync(file, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...execOptions });
  return stdout;
};
const safeImage = options.image.replaceAll("'", "");
const script = `#!/usr/bin/env bash\nset -euo pipefail\nfor attempt in $(seq 1 90); do\n  if [ -f /var/lib/cloud/instance/kvs-benchmark-ready ]; then break; fi\n  sleep 10\ndone\ntest -f /var/lib/cloud/instance/kvs-benchmark-ready\ntimeout 900 sudo -n podman pull '${safeImage}'\nsudo -n podman image exists '${safeImage}'\nsudo -n install -d -o root -g oracle-cloud-agent -m 0750 /opt/kvs-dashboard\ntest -d /opt/kvs-dashboard\necho IMAGE_READY\n`;
const results = await Promise.all(runners.map((instanceId, index) => executeOciRunCommand({
  executeCommand,
  profile: options.profile,
  region: options.region,
  compartmentId: options["compartment-id"],
  instanceId,
  script,
  displayName: `kvs-image-pull-${index}-${crypto.randomBytes(4).toString("hex")}`,
  controlDirectory: path.resolve(".kvs", "image-pull-control"),
  timeoutSeconds: 900,
  deliveryTimeoutSeconds: 420
})));
if (results.some(result => result.status !== "SUCCEEDED" || result.exitCode !== 0)) throw new Error("One or more runners did not confirm the image.");
console.log(`OCI_IMAGES_READY runners=${runners.length} image=${safeImage}`);
