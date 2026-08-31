import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverProfiles } from "./profiles.mjs";
import { listBenchmarkConfigs, previewMatrix } from "./preview.mjs";
import { LocalSmokeRuns } from "./local-smoke.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(moduleDirectory, "public");
const configDirectory = path.resolve(moduleDirectory, "..", "..", "configs");
const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };

function json(response, status, value) {
  response.writeHead(status, { "content-type": contentTypes[".json"], "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

async function body(request, limit = 1024 * 1024) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > limit) throw new Error("Request body exceeds 1 MB"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function safeAsset(urlPath) {
  const requested = urlPath === "/" ? "index.html" : urlPath.slice(1);
  if (!/^[a-z0-9.-]+$/i.test(requested)) return null;
  const file = path.resolve(publicDirectory, requested);
  return file.startsWith(publicDirectory + path.sep) ? file : null;
}

export function createDashboardServer({ token = crypto.randomBytes(24).toString("base64url"), profileDiscovery = discoverProfiles, localSmokeRuns = new LocalSmokeRuns() } = {}) {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/api/bootstrap") {
        const profiles = await profileDiscovery();
        return json(response, 200, { schemaVersion: 1, csrfToken: token, profiles, configs: listBenchmarkConfigs(configDirectory), capabilities: { existingInfrastructure: true, managedInfrastructure: false, cloudExecution: false, localMockExecution: true, liveProgress: true }, defaults: { awsRegion: "us-east-1", ociRegion: "us-ashburn-1" } });
      }
      if (request.method === "POST" && url.pathname === "/api/preview") {
        if (request.headers["x-kvs-csrf"] !== token) return json(response, 403, { error: "Invalid dashboard token" });
        return json(response, 200, previewMatrix(await body(request), { configDirectory }));
      }
      if (request.method === "POST" && url.pathname === "/api/local-smoke") {
        if (request.headers["x-kvs-csrf"] !== token) return json(response, 403, { error: "Invalid dashboard token" });
        await body(request);
        return json(response, 202, localSmokeRuns.start());
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/runs/")) {
        return json(response, 200, localSmokeRuns.get(decodeURIComponent(url.pathname.slice("/api/runs/".length))));
      }
      if (url.pathname.startsWith("/api/")) return json(response, 404, { error: "Unknown API route" });
      if (request.method !== "GET") return json(response, 405, { error: "Method not allowed" });
      const file = safeAsset(url.pathname);
      if (!file || !fs.existsSync(file)) return json(response, 404, { error: "Asset not found" });
      response.writeHead(200, { "content-type": contentTypes[path.extname(file)] || "application/octet-stream", "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
      fs.createReadStream(file).pipe(response);
    } catch (error) {
      json(response, 400, { error: error.message });
    }
  });
  return { server, token };
}

export async function startDashboard({ host = "127.0.0.1", port = 4177 } = {}) {
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("Dashboard must bind to loopback");
  const { server } = createDashboardServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(Number(port), host, resolve); });
  const address = server.address();
  process.stdout.write(`KVS dashboard: http://${host}:${address.port}\n`);
  return server;
}
