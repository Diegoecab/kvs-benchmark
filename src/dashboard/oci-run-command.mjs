import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function executeOciRunCommand({ executeCommand, profile, region, compartmentId, instanceId, script, displayName, controlDirectory, timeoutSeconds = 3600, deliveryTimeoutSeconds = 300, pollIntervalMs = 2000, cliTimeoutMs = 60_000 }) {
  if (Buffer.byteLength(script) > 4096) throw new Error("OCI Run Command script exceeds the 4 KB inline-source limit");
  fs.mkdirSync(controlDirectory, { recursive: true });
  const suffix = crypto.randomBytes(4).toString("hex"), contentFile = path.join(controlDirectory, `${suffix}-content.json`), targetFile = path.join(controlDirectory, `${suffix}-target.json`);
  fs.writeFileSync(contentFile, `${JSON.stringify({ source: { sourceType: "TEXT", text: script, textSha256: crypto.createHash("sha256").update(script).digest("hex") }, output: { outputType: "TEXT" } })}\n`);
  fs.writeFileSync(targetFile, `${JSON.stringify({ instanceId })}\n`);
  let commandId;
  try {
    commandId = (await executeCommand("oci", ["instance-agent", "command", "create", "--profile", profile, "--region", region, "--compartment-id", compartmentId, "--target", `file://${targetFile.replaceAll("\\", "/")}`, "--content", `file://${contentFile.replaceAll("\\", "/")}`, "--timeout-in-seconds", String(timeoutSeconds), "--display-name", displayName, "--query", "data.id", "--raw-output"], { timeout: cliTimeoutMs })).trim();
  } catch (createError) {
    const raw = await executeCommand("oci", ["instance-agent", "command", "list", "--profile", profile, "--region", region, "--compartment-id", compartmentId, "--all", "--output", "json"], { timeout: cliTimeoutMs });
    const recovered = (JSON.parse(raw).data || []).find(item => item["display-name"] === displayName);
    commandId = recovered?.["instance-agent-command-id"] || recovered?.id;
    if (!commandId) throw createError;
  }
  const deliveryDeadline = Date.now() + deliveryTimeoutSeconds * 1000;
  let executionDeadline = null;
  let lastStatus = "UNKNOWN";
  while (true) {
    const raw = await executeCommand("oci", ["instance-agent", "command-execution", "get", "--profile", profile, "--region", region, "--instance-id", instanceId, "--command-id", commandId, "--output", "json"], { timeout: cliTimeoutMs });
    const execution = JSON.parse(raw).data || {}, status = execution["lifecycle-state"]; lastStatus = status || lastStatus;
    if (["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELED"].includes(status)) {
      const content = execution.content || {}, stdout = content.text || "", exitCode = content["exit-code"] ?? content.exitCode ?? 0;
      if (status !== "SUCCEEDED" || exitCode !== 0) throw new Error(`OCI Run Command ${displayName}: ${stdout || content.message || status}`);
      return { commandId, stdout, status, exitCode };
    }
    if (status && status !== "ACCEPTED" && !executionDeadline) executionDeadline = Date.now() + timeoutSeconds * 1000;
    const deadline = executionDeadline || deliveryDeadline;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
  let cancellationRequested = false;
  try {
    await executeCommand("oci", ["instance-agent", "command", "cancel", "--profile", profile, "--region", region, "--command-id", commandId, "--force"], { timeout: cliTimeoutMs });
    cancellationRequested = true;
  } catch {}
  const hint = lastStatus === "ACCEPTED" ? `; it was not delivered within ${deliveryTimeoutSeconds}s. Check the Compute Instance Run Command plugin, dynamic-group policy, TCP/443 egress, and pending-command backlog` : "";
  throw new Error(`OCI Run Command ${displayName} timed out in ${lastStatus}${hint}${cancellationRequested ? "; cancellation requested to prevent queue buildup" : ""}`);
}
