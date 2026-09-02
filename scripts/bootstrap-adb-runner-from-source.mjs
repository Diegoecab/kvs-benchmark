#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
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
for (const required of ["profile", "region", "compartment-id", "source-runner-id", "destination-runner-ids", "database-id", "table", "image"]) {
  if (!options[required]) throw new Error(`Missing --${required}`);
}
if (!/^ocid1\.instance\./.test(options["source-runner-id"])) throw new Error("Invalid source runner OCID");
if (!/^ocid1\.autonomousdatabase\./.test(options["database-id"])) throw new Error("Invalid Autonomous Database OCID");
if (!/^[A-Za-z0-9_.-]+$/.test(options.table)) throw new Error("Invalid table name");
if (!/^[A-Za-z0-9_.-]+$/.test(options.profile) || !/^[a-z]{2}-[a-z]+-\d$/.test(options.region)) throw new Error("Invalid OCI profile or region");
if (!/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/i.test(options.image)) throw new Error("Runner image must be pinned by digest");
const destinations = options["destination-runner-ids"].split(",").map(value => value.trim()).filter(Boolean);
if (!destinations.length || destinations.some(value => !/^ocid1\.instance\./.test(value)) || new Set(destinations).size !== destinations.length) throw new Error("Destination runner OCIDs must be distinct");
if (destinations.includes(options["source-runner-id"])) throw new Error("Source and destination runners must differ");

const executeCommand = async (file, args, execOptions = {}) => {
  const { stdout } = await execFileAsync(file, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...execOptions });
  return stdout;
};
const database = JSON.parse(await executeCommand("oci", ["db", "autonomous-database", "get", "--profile", options.profile, "--region", options.region, "--autonomous-database-id", options["database-id"], "--output", "json"])).data;
if (database["lifecycle-state"] !== "AVAILABLE") throw new Error(`ADB must be AVAILABLE; found ${database["lifecycle-state"]}`);
if (database["license-model"] !== "BRING_YOUR_OWN_LICENSE") throw new Error("ADB must remain BYOL");

const controlDirectory = path.resolve(options["control-directory"] || ".run-command-control", `adb-bootstrap-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`);
fs.mkdirSync(controlDirectory, { recursive: true });
const common = instanceId => ({ executeCommand, profile: options.profile, region: options.region, compartmentId: options["compartment-id"], instanceId, controlDirectory, timeoutSeconds: 600, deliveryTimeoutSeconds: 900 });
const image = options.image.replaceAll("'", "");
const endpoint = `https://dataaccess.adb.${options.region}.oraclecloudapps.com/adb/keyvaluestore/v1/${options["database-id"]}`;
const authEndpoint = `https://dataaccess.adb.${options.region}.oraclecloudapps.com/adb/auth/v1/databases/${options["database-id"]}/accesskeys`;
const secretEnvironmentName = "AWS_" + "SECRET_ACCESS_KEY";

for (const [index, destination] of destinations.entries()) {
  const keygenJavascript = `const c=await import("node:crypto"),f=await import("node:fs");f.mkdirSync("/secure",{recursive:true});const k=c.generateKeyPairSync("rsa",{modulusLength:2048,publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});f.writeFileSync("/secure/.adb-bootstrap-private.pem",k.privateKey,{mode:0o600});console.log(Buffer.from(k.publicKey).toString("base64"));`;
  const generated = await executeOciRunCommand({ ...common(destination), script: `#!/usr/bin/env bash\nset -euo pipefail\nsudo -n podman run --rm --user 0:0 -v /opt/kvs-dashboard:/secure:Z --entrypoint node '${image}' --input-type=module --eval '${keygenJavascript}'\n`, displayName: `kvs-adb-keygen-${index + 1}-${crypto.randomBytes(3).toString("hex")}` });
  const publicKeyBase64 = generated.stdout.trim().split(/\r?\n/).at(-1);
  const publicKey = Buffer.from(publicKeyBase64, "base64").toString("utf8");
  if (!publicKey.includes("BEGIN PUBLIC KEY")) throw new Error(`Destination runner ${index + 1} returned an invalid bootstrap public key`);

  const exportJavascript = `const c=await import("node:crypto"),f=await import("node:fs");const password=f.readFileSync("/secure/.adb-admin-password","utf8").trim();if(!password)throw new Error("Protected ADB renewal credential is empty");const publicKey=Buffer.from(process.env.KVS_PUBLIC,"base64").toString("utf8");console.log(c.publicEncrypt({key:publicKey,padding:c.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},Buffer.from(password)).toString("base64"));`;
  const exported = await executeOciRunCommand({ ...common(options["source-runner-id"]), script: `#!/usr/bin/env bash\nset -euo pipefail\nsudo -n podman run --rm --user 0:0 -v /opt/kvs-dashboard:/secure:Z -e KVS_PUBLIC='${publicKeyBase64}' --entrypoint node '${image}' --input-type=module --eval '${exportJavascript}'\n`, displayName: `kvs-adb-export-${index + 1}-${crypto.randomBytes(3).toString("hex")}` });
  const encryptedPassword = exported.stdout.trim().split(/\r?\n/).at(-1);
  if (!/^[A-Za-z0-9+/=]+$/.test(encryptedPassword)) throw new Error(`Source runner returned an invalid encrypted credential for destination ${index + 1}`);

  const installJavascript = `const c=await import("node:crypto"),f=await import("node:fs");const privateKey=f.readFileSync("/secure/.adb-bootstrap-private.pem"),password=c.privateDecrypt({key:privateKey,padding:c.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},Buffer.from(process.env.KVS_ADMIN,"base64")).toString(),auth="Basic "+Buffer.from("ADMIN:"+password).toString("base64"),payload={name:process.env.KVS_NAME,description:"Table-scoped distributed benchmark runner credential",permissions:[{actions:["READ_WRITE"],resources:[process.env.KVS_TABLE]}],expiration_minutes:5256000};let response;for(let attempt=0;attempt<12;attempt++){response=await fetch(process.env.KVS_AUTH,{method:"POST",headers:{authorization:auth,"content-type":"application/json",accept:"application/json","request-id":c.randomUUID()},body:JSON.stringify(payload)});if(response.ok)break;if(![401,503].includes(response.status))break;await new Promise(resolve=>setTimeout(resolve,10000));}if(!response?.ok)throw new Error("ADB access-key creation failed HTTP "+response.status+" "+(await response.text()).slice(0,300));const key=await response.json(),runtime={databaseId:process.env.KVS_DB,region:process.env.KVS_REGION,endpoint:process.env.KVS_ENDPOINT,accessKeyId:key.access_key_id,secretAccessKey:key.secret_access_key,expirationTime:key.expiration_timestamp||key.expiration_time||"",tableNames:[process.env.KVS_TABLE]};f.writeFileSync("/secure/.adb-admin-password",password,{mode:0o600});f.writeFileSync("/secure/adb-api.runtime.json",JSON.stringify(runtime,null,2),{mode:0o600});f.writeFileSync("/secure/adb-api.runtime.env","AWS_ACCESS_KEY_ID="+runtime.accessKeyId+"\\n${secretEnvironmentName}="+runtime.secretAccessKey+"\\nDDB_ENDPOINT="+runtime.endpoint+"\\n",{mode:0o600});for(const file of ["/secure/.adb-admin-password","/secure/adb-api.runtime.json","/secure/adb-api.runtime.env"]){f.chmodSync(file,0o600);}f.unlinkSync("/secure/.adb-bootstrap-private.pem");console.log(JSON.stringify({status:"RUNTIME_INSTALLED",expirationTime:runtime.expirationTime,table:process.env.KVS_TABLE}));`;
  const runnerName = `kvs-benchmark-source-${String(index + 1).padStart(2, "0")}`;
  const installed = await executeOciRunCommand({ ...common(destination), script: `#!/usr/bin/env bash\nset -euo pipefail\nsudo -n podman run --rm --user 0:0 -v /opt/kvs-dashboard:/secure:Z -e KVS_ADMIN='${encryptedPassword}' -e KVS_DB='${options["database-id"]}' -e KVS_REGION='${options.region}' -e KVS_ENDPOINT='${endpoint}' -e KVS_AUTH='${authEndpoint}' -e KVS_TABLE='${options.table}' -e KVS_NAME='${runnerName}' --entrypoint node '${image}' --input-type=module --eval '${installJavascript}'\n`, displayName: `kvs-adb-install-${index + 1}-${crypto.randomBytes(3).toString("hex")}` });
  const confirmation = JSON.parse(installed.stdout.trim().split(/\r?\n/).at(-1));
  if (confirmation.status !== "RUNTIME_INSTALLED" || confirmation.table !== options.table) throw new Error(`Destination runner ${index + 1} did not confirm installation`);
  console.log(JSON.stringify({ status: confirmation.status, destination, table: confirmation.table, expirationTime: confirmation.expirationTime }));
}
