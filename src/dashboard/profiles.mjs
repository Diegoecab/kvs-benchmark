import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function parseOciProfiles(text) {
  const profiles = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*\[([^\]]+)]\s*$/);
    if (match && !profiles.includes(match[1].trim())) profiles.push(match[1].trim());
  }
  return profiles.sort((a, b) => a.localeCompare(b));
}

export async function discoverAwsProfiles({ run = execFileAsync } = {}) {
  try {
    const { stdout } = await run("aws", ["configure", "list-profiles"], { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 });
    return { profiles: [...new Set(stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)), warning: null };
  } catch (error) {
    return { profiles: [], warning: `AWS profile discovery failed: ${error.code || error.message}` };
  }
}

export function ociConfigPath(environment = process.env) {
  return path.resolve(environment.OCI_CONFIG_FILE || path.join(os.homedir(), ".oci", "config"));
}

export async function discoverOciProfiles({ file = ociConfigPath(), read = fs.promises.readFile } = {}) {
  try {
    return { profiles: parseOciProfiles(await read(file, "utf8")), warning: null, source: "OCI_CONFIG_FILE or ~/.oci/config" };
  } catch (error) {
    return { profiles: [], warning: `OCI profile discovery failed: ${error.code || error.message}`, source: "OCI_CONFIG_FILE or ~/.oci/config" };
  }
}

export async function discoverProfiles(options = {}) {
  const [aws, oci] = await Promise.all([discoverAwsProfiles(options.aws), discoverOciProfiles(options.oci)]);
  return { aws: aws.profiles, oci: oci.profiles, warnings: [aws.warning, oci.warning].filter(Boolean), sources: { aws: "aws configure list-profiles", oci: oci.source } };
}
