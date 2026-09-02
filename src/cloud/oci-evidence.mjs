import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import common from "oci-common";
import objectstorage from "oci-objectstorage";

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function options(argv) {
  return Object.fromEntries(argv.map(value => {
    const match = /^--([a-z-]+)=(.*)$/.exec(value);
    if (!match) throw new Error(`Invalid evidence-sync argument: ${value}`);
    return [match[1], match[2]];
  }));
}

function files(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(item => item.isFile() && !item.name.endsWith(".tmp") && item.name !== ".benchmark-complete")
    .map(item => path.join(item.parentPath || item.path, item.name));
}

export async function createObjectStorageClient({ region = process.env.OCI_REGION } = {}) {
  const authenticationDetailsProvider = await new common.InstancePrincipalsAuthenticationDetailsProviderBuilder().build();
  const client = new objectstorage.ObjectStorageClient({ authenticationDetailsProvider });
  if (region) client.regionId = region;
  const namespace = (await client.getNamespace({})).value;
  return { client, namespace };
}

export async function uploadFile({ client, namespace, bucket, objectName, file }) {
  const stat = fs.statSync(file);
  await client.putObject({
    namespaceName: namespace,
    bucketName: bucket,
    objectName,
    contentLength: stat.size,
    putObjectBody: fs.createReadStream(file),
    contentType: file.endsWith(".json") || file.endsWith(".ndjson") ? "application/json" : "application/octet-stream",
  });
}

export async function syncEvidence({ directory, bucket, prefix, marker, intervalMs = 2000, createClient = createObjectStorageClient }) {
  if (!directory || !bucket || !prefix) throw new Error("directory, bucket, and prefix are required");
  const progress = path.join(directory, "progress.json");
  let progressMtime = -1;
  let connection = await createClient();
  if (marker) {
    try {
      while (!fs.existsSync(marker)) {
        if (fs.existsSync(progress)) {
          const mtime = fs.statSync(progress).mtimeMs;
          if (mtime !== progressMtime) {
            try {
              await uploadFile({ client: connection.client, namespace: connection.namespace, bucket, objectName: `${prefix}/progress.json`, file: progress });
              progressMtime = mtime;
            } catch {
              // Live visibility is best-effort. Final evidence uses a fresh client below.
            }
          }
        }
        await sleep(intervalMs);
      }
    } finally {
      connection.client.close();
    }
    connection = await createClient();
  }
  try {
    for (const file of files(directory)) {
      const relative = path.relative(directory, file).replaceAll("\\", "/");
      await uploadFile({ client: connection.client, namespace: connection.namespace, bucket, objectName: `${prefix}/${relative}`, file });
    }
  } finally {
    connection.client.close();
  }
}

async function main() {
  const values = options(process.argv.slice(2));
  await syncEvidence({
    directory: values.directory,
    bucket: values.bucket,
    prefix: values.prefix.replace(/^\/+|\/+$/g, ""),
    marker: values.marker || null,
    intervalMs: values["interval-ms"] ? Number(values["interval-ms"]) : 2000,
  });
  process.stdout.write(`${JSON.stringify({ uploaded: true, bucket: values.bucket, prefix: values.prefix })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
