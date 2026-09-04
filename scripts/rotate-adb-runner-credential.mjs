import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { executeOciRunCommand } from "../src/dashboard/oci-run-command.mjs";

const execFileAsync = promisify(execFile);
const options = Object.fromEntries(process.argv.slice(2).map(value => {
  const index = value.indexOf("=");
  if (index < 1) throw new Error(`Expected --name=value, received ${value}`);
  return [value.slice(2, index), value.slice(index + 1)];
}));
for (const required of ["profile", "region", "compartment-id", "runner-id", "database-id", "table"]) {
  if (!options[required]) throw new Error(`Missing --${required}`);
}

const image = options.image || "ghcr.io/diegoecab/kvs-benchmark-runner@sha256:afd67c17aeab0396bc9ac397e37585da59e726d7d51a8efa2a3f2a1b14ecd1a1";
const controlDirectory = path.resolve(options["control-directory"] || ".run-command-control");
const executeCommand = async (file, args, execOptions = {}) => {
  const { stdout } = await execFileAsync(file, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...execOptions });
  return stdout;
};
const common = {
  executeCommand,
  profile: options.profile,
  region: options.region,
  compartmentId: options["compartment-id"],
  instanceId: options["runner-id"],
  controlDirectory,
  timeoutSeconds: 600,
  deliveryTimeoutSeconds: 900
};

function databasePassword() {
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const alphabet = lower + upper + digits;
  const pick = chars => chars[crypto.randomInt(chars.length)];
  const values = [pick(lower), pick(upper), pick(digits), ...Array.from({ length: 21 }, () => pick(alphabet))];
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = crypto.randomInt(index + 1);
    [values[index], values[swap]] = [values[swap], values[index]];
  }
  return values.join("");
}

const adminPassword = databasePassword();
await executeCommand("oci", [
  "db", "autonomous-database", "update",
  "--autonomous-database-id", options["database-id"],
  "--admin-password", adminPassword,
  "--profile", options.profile,
  "--region", options.region,
  "--wait-for-state", "AVAILABLE",
  "--max-wait-seconds", "1200",
  "--force",
  "--output", "json"
], { timeout: 1_300_000 });

const keygenJavascript = `const c=await import("node:crypto"),f=await import("node:fs");const k=c.generateKeyPairSync("rsa",{modulusLength:2048,publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});f.writeFileSync("/secure/.adb-bootstrap-private.pem",k.privateKey,{mode:0o600});console.log(Buffer.from(k.publicKey).toString("base64"));`;
const keygenScript = `#!/usr/bin/env bash\nset -euo pipefail\nsudo -n podman run --rm --user 0:0 -v /opt/kvs-dashboard:/secure:Z --entrypoint node '${image}' --input-type=module --eval '${keygenJavascript}'\n`;
const generated = await executeOciRunCommand({ ...common, script: keygenScript, displayName: `kvs-adb-keygen-${crypto.randomBytes(4).toString("hex")}` });
const publicKey = Buffer.from(generated.stdout.trim(), "base64").toString("utf8");
if (!publicKey.includes("BEGIN PUBLIC KEY")) throw new Error("Runner returned an invalid bootstrap public key.");

const encryptedPassword = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(adminPassword)).toString("base64");
const safe = value => String(value).replaceAll("'", "");
const endpoint = `https://dataaccess.adb.${options.region}.oraclecloudapps.com/adb/keyvaluestore/v1/${options["database-id"]}`;
const authEndpoint = `https://dataaccess.adb.${options.region}.oraclecloudapps.com/adb/auth/v1/databases/${options["database-id"]}/accesskeys`;
const secretEnvironmentName = "AWS_" + "SECRET_ACCESS_KEY";
const provisionJavascript = `const c=await import("node:crypto"),f=await import("node:fs");const p=f.readFileSync("/secure/.adb-bootstrap-private.pem");const password=c.privateDecrypt({key:p,padding:c.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},Buffer.from(process.env.KVS_ADMIN,"base64")).toString();const auth="Basic "+Buffer.from("ADMIN:"+password).toString("base64");const payload={name:"kvs-benchmark-runner",description:"Table-scoped benchmark runner credential",permissions:[{actions:["READ_WRITE"],resources:[process.env.KVS_TABLE]}],expiration_minutes:5256000};let response;for(let attempt=0;attempt<12;attempt++){response=await fetch(process.env.KVS_AUTH,{method:"POST",headers:{authorization:auth,"content-type":"application/json",accept:"application/json","request-id":c.randomUUID()},body:JSON.stringify(payload)});if(response.ok)break;if(response.status!==401&&response.status!==503)break;await new Promise(resolve=>setTimeout(resolve,10000));}if(!response?.ok){const message=(await response.text()).slice(0,500);throw new Error("Access key creation failed HTTP "+response.status+" "+message);}const key=await response.json();const expiration=key.expiration_timestamp||key.expiration_time||"";const runtime={databaseId:process.env.KVS_DB,region:process.env.KVS_REGION,endpoint:process.env.KVS_ENDPOINT,accessKeyId:key.access_key_id,secretAccessKey:key.secret_access_key,expirationTime:expiration,tableNames:[process.env.KVS_TABLE]};f.writeFileSync("/secure/.adb-admin-password",password,{mode:0o600});f.writeFileSync("/secure/adb-api.runtime.json",JSON.stringify(runtime,null,2),{mode:0o600});f.writeFileSync("/secure/adb-api.runtime.env","AWS_ACCESS_KEY_ID="+runtime.accessKeyId+"\\n${secretEnvironmentName}="+runtime.secretAccessKey+"\\nDDB_ENDPOINT="+runtime.endpoint+"\\n",{mode:0o600});for(const file of ["/secure/.adb-admin-password","/secure/adb-api.runtime.json","/secure/adb-api.runtime.env"]){f.chmodSync(file,0o600);}f.unlinkSync("/secure/.adb-bootstrap-private.pem");console.log(JSON.stringify({status:"RUNTIME_INSTALLED",expirationTime:expiration,permissions:key.permissions}));`;
const shortLivedProvisionJavascript = provisionJavascript.replace("expiration_minutes:5256000", "expiration_minutes:360");
const uniqueProvisionJavascript = shortLivedProvisionJavascript.replace('name:"kvs-benchmark-runner"', 'name:"kvs-benchmark-runner-"+Date.now().toString(36)');
const diagnosableProvisionJavascript = `try{${uniqueProvisionJavascript}}catch(error){console.error("INSTALL_ERROR "+String(error?.message||error));process.exit(1);}`;
const installScript = `#!/usr/bin/env bash\nset -euo pipefail\nsudo -n podman run --rm --network host --user 0:0 -v /opt/kvs-dashboard:/secure:Z -e KVS_ADMIN='${encryptedPassword}' -e KVS_DB='${safe(options["database-id"])}' -e KVS_REGION='${safe(options.region)}' -e KVS_ENDPOINT='${safe(endpoint)}' -e KVS_AUTH='${safe(authEndpoint)}' -e KVS_TABLE='${safe(options.table)}' --entrypoint node '${image}' --input-type=module --eval '${diagnosableProvisionJavascript}'\n`;
const installed = await executeOciRunCommand({ ...common, script: installScript, displayName: `kvs-adb-credential-${crypto.randomBytes(4).toString("hex")}` });
const confirmation = JSON.parse(installed.stdout.trim().split(/\r?\n/).at(-1));
if (confirmation.status !== "RUNTIME_INSTALLED") throw new Error("Runner did not confirm runtime installation.");
console.log(JSON.stringify({ status: confirmation.status, runner: options["runner-id"], expirationTime: confirmation.expirationTime, permissions: confirmation.permissions }));
