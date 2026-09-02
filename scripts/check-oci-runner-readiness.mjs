#!/usr/bin/env node
import crypto from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { executeOciRunCommand } from "../src/dashboard/oci-run-command.mjs";

const execFileAsync = promisify(execFile);
const options = Object.fromEntries(process.argv.slice(2).map(value => {
  const index = value.indexOf("=");
  if (!value.startsWith("--") || index < 3) throw new Error(`Expected --name=value, received ${value}`);
  return [value.slice(2, index), value.slice(index + 1)];
}));
for (const required of ["profile", "region", "compartment-id", "runner-ids", "image"]) {
  if (!options[required]) throw new Error(`Missing --${required}`);
}
const runners = options["runner-ids"].split(",").map(value => value.trim()).filter(Boolean);
if (!runners.length || runners.some(value => !/^ocid1\.instance\./.test(value))) throw new Error("Invalid runner OCIDs");
const executeCommand = async (file, args, execOptions = {}) => {
  const { stdout } = await execFileAsync(file, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...execOptions });
  return stdout;
};
const image = options.image.replaceAll("'", "");
const script = `#!/usr/bin/env bash
set -euo pipefail
user=$(id -un)
uid=$(id -u)
groups=$(id -Gn)
agent_user=$(getent passwd ocarun | cut -d: -f1 || true)
agent_group=$(getent group ocarun | cut -d: -f1 || true)
marker=false; test -f /var/lib/cloud/instance/kvs-benchmark-ready && marker=true
directory=false; test -d /opt/kvs-dashboard && directory=true
image_ready=false; sudo -n podman image exists '${image}' && image_ready=true
cloud_final=$(systemctl is-active cloud-final.service || true)
agent=$(systemctl is-active oracle-cloud-agent.service || true)
chrony=$(systemctl is-active chronyd.service || true)
jq -c -n --arg user "$user" --argjson uid "$uid" --arg groups "$groups" --arg agentUser "$agent_user" --arg agentGroup "$agent_group" --argjson marker "$marker" --argjson directory "$directory" --argjson imageReady "$image_ready" --arg cloudFinal "$cloud_final" --arg agent "$agent" --arg chrony "$chrony" '{user:$user,uid:$uid,groups:$groups,agentUser:$agentUser,agentGroup:$agentGroup,marker:$marker,directory:$directory,imageReady:$imageReady,cloudFinal:$cloudFinal,agent:$agent,chrony:$chrony}'
`;
const results = await Promise.all(runners.map(async (instanceId, index) => {
  const result = await executeOciRunCommand({
    executeCommand,
    profile: options.profile,
    region: options.region,
    compartmentId: options["compartment-id"],
    instanceId,
    script,
    displayName: `kvs-readiness-audit-${index + 1}-${crypto.randomBytes(3).toString("hex")}`,
    controlDirectory: path.resolve(".kvs", "readiness-audit-control"),
    timeoutSeconds: 120,
    deliveryTimeoutSeconds: 900
  });
  return { instanceId, ...JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)) };
}));
console.log(JSON.stringify(results, null, 2));
