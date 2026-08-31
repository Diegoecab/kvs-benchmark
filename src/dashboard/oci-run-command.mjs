import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function executeOciRunCommand({ executeCommand, profile, region, compartmentId, instanceId, script, displayName, controlDirectory, timeoutSeconds = 3600, pollIntervalMs = 2000 }) {
  if (Buffer.byteLength(script) > 4096) throw new Error("OCI Run Command script exceeds the 4 KB inline-source limit");
  fs.mkdirSync(controlDirectory, { recursive: true });
  const suffix = crypto.randomBytes(4).toString("hex"), contentFile = path.join(controlDirectory, `${suffix}-content.json`), targetFile = path.join(controlDirectory, `${suffix}-target.json`);
  fs.writeFileSync(contentFile, `${JSON.stringify({ source: { sourceType: "TEXT", text: script, textSha256: crypto.createHash("sha256").update(script).digest("hex") }, output: { outputType: "TEXT" } })}\n`);
  fs.writeFileSync(targetFile, `${JSON.stringify({ instanceId })}\n`);
  const commandId = (await executeCommand("oci", ["instance-agent", "command", "create", "--profile", profile, "--region", region, "--compartment-id", compartmentId, "--target", `file://${targetFile.replaceAll("\\", "/")}`, "--content", `file://${contentFile.replaceAll("\\", "/")}`, "--timeout-in-seconds", String(timeoutSeconds), "--display-name", displayName, "--query", "data.id", "--raw-output"])).trim();
  const attempts = Math.ceil((timeoutSeconds * 1000) / pollIntervalMs) + 30;
  let lastStatus = "UNKNOWN";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const raw = await executeCommand("oci", ["instance-agent", "command-execution", "get", "--profile", profile, "--region", region, "--instance-id", instanceId, "--command-id", commandId, "--output", "json"]);
    const execution = JSON.parse(raw).data || {}, status = execution["lifecycle-state"]; lastStatus = status || lastStatus;
    if (["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELED"].includes(status)) {
      const content = execution.content || {}, stdout = content.text || "", exitCode = content["exit-code"] ?? content.exitCode ?? 0;
      if (status !== "SUCCEEDED" || exitCode !== 0) throw new Error(`OCI Run Command ${displayName}: ${content.message || stdout || status}`);
      return { commandId, stdout, status, exitCode };
    }
    await sleep(pollIntervalMs);
  }
  const hint = lastStatus === "ACCEPTED" ? "; the command was not picked up by the instance. Verify the runner dynamic-group policy for instance-agent-command-execution-family" : "";
  throw new Error(`OCI Run Command ${displayName} timed out in ${lastStatus}${hint}`);
}
