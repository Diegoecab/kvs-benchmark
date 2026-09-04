#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const options = Object.fromEntries(process.argv.slice(2).map(value => {
  const index = value.indexOf("=");
  if (!value.startsWith("--") || index < 3) throw new Error(`Expected --name=value, received ${value}`);
  return [value.slice(2, index), value.slice(index + 1)];
}));
for (const required of ["profile", "region", "runner-ids", "image", "table", "bucket"]) {
  if (!options[required]) throw new Error(`Missing --${required}`);
}

const runners = options["runner-ids"].split(",").map(value => value.trim()).filter(Boolean);
if (!runners.length || runners.some(value => !/^i-[a-f0-9]+$/.test(value))) throw new Error("Invalid EC2 runner IDs");
if (!/^[A-Za-z0-9_.-]+$/.test(options.profile) || !/^[a-z]{2}-[a-z]+-\d$/.test(options.region)) throw new Error("Invalid AWS profile or region");
if (!/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/i.test(options.image)) throw new Error("Runner image must be pinned by digest");
if (!/^[A-Za-z0-9_.-]+$/.test(options.table)) throw new Error("Invalid DynamoDB table name");
if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) throw new Error("Invalid S3 bucket name");

const execute = async args => {
  const { stdout } = await execFileAsync("aws", args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
};
const controlDirectory = path.resolve(options["control-directory"] || ".kvs/readiness-audit-control");
fs.mkdirSync(controlDirectory, { recursive: true });
const deadlineMs = Number(options["timeout-seconds"] || 600) * 1000;
if (!Number.isFinite(deadlineMs) || deadlineMs < 10_000) throw new Error("--timeout-seconds must be at least 10");

const results = await Promise.all(runners.map(async (instanceId, index) => {
  const auditId = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`;
  const prefix = `results/readiness-audit/${auditId}/${instanceId}`;
  const commands = [
    "marker=false; test -f /var/lib/cloud/instance/kvs-benchmark-ready && marker=true",
    "directory=false; test -d /opt/kvs-dashboard && directory=true",
    `image_ready=false; podman image exists '${options.image}' && image_ready=true`,
    `table_access=false; aws dynamodb describe-table --region '${options.region}' --table-name '${options.table}' >/dev/null 2>&1 && table_access=true`,
    `evidence_access=false; printf '%s\\n' ready | aws s3 cp - 's3://${options.bucket}/${prefix}/ready.txt' --region '${options.region}' --only-show-errors >/dev/null 2>&1 && evidence_access=true`,
    "chrony=false; chronyc tracking >/dev/null 2>&1 && chrony=true",
    "printf '{\"marker\":%s,\"directory\":%s,\"imageReady\":%s,\"tableAccess\":%s,\"evidenceAccess\":%s,\"chrony\":%s}\\n' \"$marker\" \"$directory\" \"$image_ready\" \"$table_access\" \"$evidence_access\" \"$chrony\"",
    "test \"$marker\" = true && test \"$directory\" = true && test \"$image_ready\" = true && test \"$table_access\" = true && test \"$evidence_access\" = true && test \"$chrony\" = true"
  ];
  const file = path.join(controlDirectory, `aws-${index + 1}-${auditId}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ commands })}\n`);
  const commandId = (await execute([
    "ssm", "send-command", "--profile", options.profile, "--region", options.region,
    "--instance-ids", instanceId, "--document-name", "AWS-RunShellScript",
    "--comment", `kvs-readiness-audit-${auditId}`, "--parameters", `file://${file.replaceAll("\\", "/")}`,
    "--query", "Command.CommandId", "--output", "text"
  ])).trim();
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const invocation = JSON.parse(await execute([
      "ssm", "get-command-invocation", "--profile", options.profile, "--region", options.region,
      "--command-id", commandId, "--instance-id", instanceId, "--output", "json"
    ]));
    if (["Success", "Failed", "Cancelled", "TimedOut"].includes(invocation.Status)) {
      const line = String(invocation.StandardOutputContent || "").trim().split(/\r?\n/).at(-1);
      let readiness;
      try { readiness = JSON.parse(line); } catch { readiness = null; }
      if (invocation.Status !== "Success" || !readiness) {
        throw new Error(`AWS runner ${instanceId} readiness failed: ${invocation.StandardErrorContent || invocation.Status}`);
      }
      return { instanceId, commandId, evidencePrefix: prefix, ...readiness };
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`AWS runner ${instanceId} readiness timed out after ${deadlineMs / 1000}s`);
}));

console.log(JSON.stringify(results, null, 2));
