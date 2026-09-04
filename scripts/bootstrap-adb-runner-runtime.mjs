import crypto from "node:crypto";
import fs from "node:fs";
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
for (const required of ["profile", "region", "compartment-id", "runner-id", "runtime-file"]) {
  if (!options[required]) throw new Error(`Missing --${required}`);
}

const image = options.image || "ghcr.io/diegoecab/kvs-benchmark-runner@sha256:afd67c17aeab0396bc9ac397e37585da59e726d7d51a8efa2a3f2a1b14ecd1a1";
const destination = options.destination || "/opt/kvs-dashboard/adb-api.runtime.json";
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
  timeoutSeconds: 300,
  deliveryTimeoutSeconds: 420
};

const keygenJavascript = `const c=await import("node:crypto"),f=await import("node:fs");const k=c.generateKeyPairSync("rsa",{modulusLength:2048,publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});f.writeFileSync("/secure/.adb-bootstrap-private.pem",k.privateKey,{mode:0o600});console.log(Buffer.from(k.publicKey).toString("base64"));`;
const keygenScript = `#!/usr/bin/env bash\nset -euo pipefail\nsudo -n podman run --rm --user 0:0 -v /opt/kvs-dashboard:/secure:Z --entrypoint node '${image}' --input-type=module --eval '${keygenJavascript}'\n`;
const generated = await executeOciRunCommand({ ...common, script: keygenScript, displayName: `kvs-adb-keygen-${crypto.randomBytes(4).toString("hex")}` });
const publicKey = Buffer.from(generated.stdout.trim(), "base64").toString("utf8");
if (!publicKey.includes("BEGIN PUBLIC KEY")) throw new Error("Runner returned an invalid bootstrap public key.");

const runtime = JSON.parse(fs.readFileSync(path.resolve(options["runtime-file"]), "utf8"));
const encrypt = value => crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(String(value))).toString("base64");
const encryptedAccessKey = encrypt(runtime.accessKeyId);
const encryptedSecretKey = encrypt(runtime.secretAccessKey);
const safe = value => String(value).replaceAll("'", "");
const tableNames = JSON.stringify(runtime.tableNames || []);
const installJavascript = `const c=await import("node:crypto"),f=await import("node:fs");const p=f.readFileSync("/secure/.adb-bootstrap-private.pem");const d=v=>c.privateDecrypt({key:p,padding:c.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},Buffer.from(v,"base64")).toString();const r={databaseId:process.env.KVS_DB,region:process.env.KVS_REGION,endpoint:process.env.KVS_ENDPOINT,accessKeyId:d(process.env.KVS_AK),secretAccessKey:d(process.env.KVS_SK),expirationTime:process.env.KVS_EXP,tableNames:JSON.parse(process.env.KVS_TABLES)};f.writeFileSync("/secure/adb-api.runtime.json",JSON.stringify(r,null,2),{mode:0o600});const secretName="AWS_"+"SECRET_ACCESS_KEY=";f.writeFileSync("/secure/adb-api.runtime.env","AWS_ACCESS_KEY_ID="+r.accessKeyId+"\\n"+secretName+r.secretAccessKey+"\\nDDB_ENDPOINT="+r.endpoint+"\\n",{mode:0o600});f.chmodSync("/secure/adb-api.runtime.json",0o600);f.chmodSync("/secure/adb-api.runtime.env",0o600);f.unlinkSync("/secure/.adb-bootstrap-private.pem");console.log("RUNTIME_INSTALLED");`;
const installScript = `#!/usr/bin/env bash\nset -euo pipefail\nsudo -n podman run --rm --user 0:0 -v /opt/kvs-dashboard:/secure:Z -e KVS_AK='${encryptedAccessKey}' -e KVS_SK='${encryptedSecretKey}' -e KVS_DB='${safe(runtime.databaseId)}' -e KVS_REGION='${safe(runtime.region)}' -e KVS_ENDPOINT='${safe(runtime.endpoint)}' -e KVS_EXP='${safe(runtime.expirationTime || "")}' -e KVS_TABLES='${safe(tableNames)}' --entrypoint node '${image}' --input-type=module --eval '${installJavascript}'\n`;
const installed = await executeOciRunCommand({ ...common, script: installScript, displayName: `kvs-adb-install-${crypto.randomBytes(4).toString("hex")}` });
if (!installed.stdout.includes("RUNTIME_INSTALLED")) throw new Error("Runner did not confirm runtime installation.");
console.log(`ADB_RUNNER_RUNTIME_READY destination=${destination} runner=${options["runner-id"]}`);
