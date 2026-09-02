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
for (const required of ["profile", "region", "compartment-id", "destination-runner-ids", "database-id", "table", "image"]) {
  if (!options[required]) throw new Error(`Missing --${required}`);
}
const adminPassword = process.env.KVS_ADB_ADMIN_PASSWORD;
if (!adminPassword || adminPassword.length < 12 || adminPassword.length > 30 || /admin|"/i.test(adminPassword)) throw new Error("KVS_ADB_ADMIN_PASSWORD is missing or invalid");
if (!/^ocid1\.autonomousdatabase\./.test(options["database-id"])) throw new Error("Invalid Autonomous Database OCID");
if (!/^[A-Za-z0-9_.-]+$/.test(options.table)) throw new Error("Invalid table name");
if (!/^[A-Za-z0-9_.-]+$/.test(options.profile) || !/^[a-z]{2}-[a-z]+-\d$/.test(options.region)) throw new Error("Invalid OCI profile or region");
if (!/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/i.test(options.image)) throw new Error("Runner image must be pinned by digest");
const destinations = options["destination-runner-ids"].split(",").map(value => value.trim()).filter(Boolean);
if (!destinations.length || destinations.some(value => !/^ocid1\.instance\./.test(value)) || new Set(destinations).size !== destinations.length) throw new Error("Destination runner OCIDs must be distinct");
const expectedRunnerCount = Number(options["expected-runner-count"] || 3);
if (!Number.isInteger(expectedRunnerCount) || expectedRunnerCount < 1 || destinations.length !== expectedRunnerCount) throw new Error(`Expected exactly ${expectedRunnerCount} destination runners; received ${destinations.length}`);

const executeCommand = async (file, args, execOptions = {}) => {
  const { stdout } = await execFileAsync(file, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...execOptions });
  return stdout;
};
const database = JSON.parse(await executeCommand("oci", ["db", "autonomous-database", "get", "--profile", options.profile, "--region", options.region, "--autonomous-database-id", options["database-id"], "--output", "json"])).data;
if (database["lifecycle-state"] !== "AVAILABLE") throw new Error(`ADB must be AVAILABLE; found ${database["lifecycle-state"]}`);
if (database["db-version"] !== "26ai") throw new Error(`ADB must use 26ai; found ${database["db-version"]}`);
if (database["license-model"] !== "BRING_YOUR_OWN_LICENSE") throw new Error("ADB must remain BYOL");
if (database["db-workload"] !== "OLTP" || database["compute-model"] !== "ECPU" || Number(database["compute-count"]) !== 8 || database["is-auto-scaling-enabled"] === true) throw new Error("ADB must be OLTP, 8 ECPU, with base compute autoscaling disabled");

const controlDirectory = path.resolve(options["control-directory"] || ".run-command-control", `adb-bootstrap-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`);
const common = instanceId => ({ executeCommand, profile: options.profile, region: options.region, compartmentId: options["compartment-id"], instanceId, controlDirectory, timeoutSeconds: 900, deliveryTimeoutSeconds: 900 });
const image = options.image.replaceAll("'", "");
const endpoint = `https://dataaccess.adb.${options.region}.oraclecloudapps.com/adb/keyvaluestore/v1/${options["database-id"]}`;
const authEndpoint = `https://dataaccess.adb.${options.region}.oraclecloudapps.com/adb/auth/v1/databases/${options["database-id"]}/accesskeys`;
const secretEnvironmentName = "AWS_" + "SECRET_ACCESS_KEY";

await Promise.all(destinations.map(async (destination, index) => {
  const keygenJavascript = `const c=await import("node:crypto"),f=await import("node:fs");f.mkdirSync("/secure",{recursive:true});const k=c.generateKeyPairSync("rsa",{modulusLength:3072,publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});f.writeFileSync("/secure/.adb-bootstrap-private.pem",k.privateKey,{mode:0o600});console.log(Buffer.from(k.publicKey).toString("base64"));`;
  const generated = await executeOciRunCommand({ ...common(destination), script: `#!/usr/bin/env bash\nset -euo pipefail\nfor attempt in $(seq 1 90); do\n  if [ -f /var/lib/cloud/instance/kvs-benchmark-ready ] && sudo -n podman image exists '${image}' >/dev/null 2>&1; then break; fi\n  sleep 10\ndone\ntest -f /var/lib/cloud/instance/kvs-benchmark-ready\nsudo -n podman image exists '${image}'\nsudo -n install -d -o root -g oracle-cloud-agent -m 0750 /opt/kvs-dashboard\ntest -d /opt/kvs-dashboard\nsudo -n podman run --rm --user 0:0 -v /opt/kvs-dashboard:/secure:Z --entrypoint node '${image}' --input-type=module --eval '${keygenJavascript}'\n`, displayName: `kvs-adb-keygen-${index + 1}-${crypto.randomBytes(3).toString("hex")}` });
  const publicKeyBase64 = generated.stdout.trim().split(/\r?\n/).at(-1);
  const publicKey = Buffer.from(publicKeyBase64, "base64").toString("utf8");
  if (!publicKey.includes("BEGIN PUBLIC KEY")) throw new Error(`Destination runner ${index + 1} returned an invalid bootstrap public key`);
  const encryptedPassword = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(adminPassword)).toString("base64");
  const installJavascript = `const c=await import("node:crypto"),f=await import("node:fs");const privateKey=f.readFileSync("/secure/.adb-bootstrap-private.pem"),password=c.privateDecrypt({key:privateKey,padding:c.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},Buffer.from(process.env.KVS_ADMIN,"base64")).toString();f.writeFileSync("/secure/.adb-admin-password",password,{mode:0o600});f.chmodSync("/secure/.adb-admin-password",0o600);f.unlinkSync("/secure/.adb-bootstrap-private.pem");console.log("ADMIN_CREDENTIAL_INSTALLED");`;
  const installed = await executeOciRunCommand({ ...common(destination), script: `#!/usr/bin/env bash\nset -euo pipefail\nsudo -n podman run --rm --user 0:0 -v /opt/kvs-dashboard:/secure:Z -e KVS_ADMIN='${encryptedPassword}' --entrypoint node '${image}' --input-type=module --eval '${installJavascript}'\n`, displayName: `kvs-adb-admin-install-${index + 1}-${crypto.randomBytes(3).toString("hex")}` });
  if (!installed.stdout.includes("ADMIN_CREDENTIAL_INSTALLED")) throw new Error(`Destination runner ${index + 1} did not confirm protected ADMIN installation`);
}));

const createJavascript = `const c=await import("node:crypto"),f=await import("node:fs");const {DynamoDBClient,ListTablesCommand,CreateTableCommand,DescribeTableCommand}=await import("@aws-sdk/client-dynamodb"),password=f.readFileSync("/secure/.adb-admin-password","utf8").trim(),auth="Basic "+Buffer.from("ADMIN:"+password).toString("base64"),payload={name:"kvs-bootstrap-"+Date.now(),description:"Ephemeral table creation credential",permissions:[{actions:["ADMIN_ANY"]}],expiration_minutes:60};let response;for(let attempt=0;attempt<60;attempt++){response=await fetch(process.env.KVS_AUTH,{method:"POST",headers:{authorization:auth,"content-type":"application/json",accept:"application/json","request-id":c.randomUUID()},body:JSON.stringify(payload)});if(response.ok)break;if(![401,429,503].includes(response.status))break;await new Promise(resolve=>setTimeout(resolve,15000));}if(!response?.ok)throw new Error("ADB access-key creation failed HTTP "+response.status+" "+(await response.text()).slice(0,300));const key=await response.json(),client=new DynamoDBClient({region:process.env.KVS_REGION,endpoint:process.env.KVS_ENDPOINT,credentials:{accessKeyId:key.access_key_id,secretAccessKey:key.secret_access_key},maxAttempts:1});const listed=await client.send(new ListTablesCommand({}));if((listed.TableNames||[]).includes(process.env.KVS_TABLE))throw new Error("Fresh ADB unexpectedly already contains the benchmark table");await client.send(new CreateTableCommand({TableName:process.env.KVS_TABLE,AttributeDefinitions:[{AttributeName:"pk",AttributeType:"S"},{AttributeName:"sk",AttributeType:"S"}],KeySchema:[{AttributeName:"pk",KeyType:"HASH"},{AttributeName:"sk",KeyType:"RANGE"}],ProvisionedThroughput:{ReadCapacityUnits:500,WriteCapacityUnits:500}}));let table;for(let attempt=0;attempt<120;attempt++){table=(await client.send(new DescribeTableCommand({TableName:process.env.KVS_TABLE}))).Table;if(table?.TableStatus==="ACTIVE")break;await new Promise(resolve=>setTimeout(resolve,5000));}client.destroy();if(table?.TableStatus!=="ACTIVE")throw new Error("ADB table did not become ACTIVE");console.log(JSON.stringify({status:table.TableStatus,table:table.TableName,readCapacityUnits:table.ProvisionedThroughput?.ReadCapacityUnits,writeCapacityUnits:table.ProvisionedThroughput?.WriteCapacityUnits}));`;
const created = await executeOciRunCommand({ ...common(destinations[0]), script: `#!/usr/bin/env bash\nset -euo pipefail\nsudo -n podman run --rm --network host --user 0:0 -v /opt/kvs-dashboard:/secure:Z -e KVS_AUTH='${authEndpoint}' -e KVS_ENDPOINT='${endpoint}' -e KVS_REGION='${options.region}' -e KVS_TABLE='${options.table}' --entrypoint node '${image}' --input-type=module --eval '${createJavascript}'\n`, displayName: `kvs-adb-create-table-${crypto.randomBytes(3).toString("hex")}` });
const table = JSON.parse(created.stdout.trim().split(/\r?\n/).at(-1));
if (table.status !== "ACTIVE" || table.readCapacityUnits !== 500 || table.writeCapacityUnits !== 500) throw new Error("ADB table did not confirm the exact provisioned capacity");

await Promise.all(destinations.map(async (destination, index) => {
  const runtimeJavascript = `const c=await import("node:crypto"),f=await import("node:fs"),password=f.readFileSync("/secure/.adb-admin-password","utf8").trim(),auth="Basic "+Buffer.from("ADMIN:"+password).toString("base64"),payload={name:process.env.KVS_NAME,description:"Table-scoped distributed benchmark runner credential",permissions:[{actions:["READ_WRITE"],resources:[process.env.KVS_TABLE]}],expiration_minutes:5256000};let response;for(let attempt=0;attempt<60;attempt++){response=await fetch(process.env.KVS_AUTH,{method:"POST",headers:{authorization:auth,"content-type":"application/json",accept:"application/json","request-id":c.randomUUID()},body:JSON.stringify(payload)});if(response.ok)break;if(![401,429,503].includes(response.status))break;await new Promise(resolve=>setTimeout(resolve,15000));}if(!response?.ok)throw new Error("ADB table credential creation failed HTTP "+response.status+" "+(await response.text()).slice(0,300));const key=await response.json(),runtime={databaseId:process.env.KVS_DB,region:process.env.KVS_REGION,endpoint:process.env.KVS_ENDPOINT,accessKeyId:key.access_key_id,secretAccessKey:key.secret_access_key,expirationTime:key.expiration_timestamp||key.expiration_time||"",tableNames:[process.env.KVS_TABLE]},runtimeFile="/secure/adb-api.runtime.json",envFile="/secure/adb-api.runtime.env";f.writeFileSync(runtimeFile,JSON.stringify(runtime,null,2),{mode:0o600});f.writeFileSync(envFile,"AWS_ACCESS_KEY_ID="+runtime.accessKeyId+"\\n${secretEnvironmentName}="+runtime.secretAccessKey+"\\nDDB_ENDPOINT="+runtime.endpoint+"\\n",{mode:0o600});f.chmodSync(runtimeFile,0o600);f.chmodSync(envFile,0o600);console.log(JSON.stringify({status:"RUNTIME_INSTALLED",table:process.env.KVS_TABLE}));`;
  const name = `kvs-benchmark-source-${String(index + 1).padStart(2, "0")}`;
  const installed = await executeOciRunCommand({ ...common(destination), script: `#!/usr/bin/env bash\nset -euo pipefail\nsudo -n podman run --rm --network host --user 0:0 -v /opt/kvs-dashboard:/secure:Z -e KVS_DB='${options["database-id"]}' -e KVS_REGION='${options.region}' -e KVS_ENDPOINT='${endpoint}' -e KVS_AUTH='${authEndpoint}' -e KVS_TABLE='${options.table}' -e KVS_NAME='${name}' --entrypoint node '${image}' --input-type=module --eval '${runtimeJavascript}'\n`, displayName: `kvs-adb-runtime-${index + 1}-${crypto.randomBytes(3).toString("hex")}` });
  const confirmation = JSON.parse(installed.stdout.trim().split(/\r?\n/).at(-1));
  if (confirmation.status !== "RUNTIME_INSTALLED" || confirmation.table !== options.table) throw new Error(`Destination runner ${index + 1} did not confirm runtime installation`);
}));
console.log(JSON.stringify({ status: "ADB_DISTRIBUTED_READY", databaseId: options["database-id"], databaseVersion: database["db-version"], licenseModel: database["license-model"], table: options.table, readCapacityUnits: 500, writeCapacityUnits: 500, runners: destinations.length }));
