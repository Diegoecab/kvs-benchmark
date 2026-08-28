import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { generateReport } from "./html.mjs";
import { TARGETS } from "./analyze.mjs";

const json = file => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const slash = value => value.replaceAll("\\", "/");

function assertEmpty(directory) {
  if (fs.existsSync(directory) && fs.readdirSync(directory).length) throw new Error(`Package output must be empty: ${directory}`);
  fs.mkdirSync(directory, { recursive: true });
}

function collect(directory, current = directory, result = []) {
  for (const name of fs.readdirSync(current).sort()) {
    const file = path.join(current, name); const stat = fs.statSync(file);
    if (stat.isDirectory()) collect(directory, file, result);
    else if (name !== "manifest-sha256.json") result.push({ path: slash(path.relative(directory, file)), bytes: stat.size, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") });
  }
  return result;
}

export function generatePackage({ suite: suiteFile, output }) {
  const sourceSuitePath = path.resolve(suiteFile); const sourceRoot = path.dirname(sourceSuitePath); const packageRoot = path.resolve(output);
  assertEmpty(packageRoot);
  const source = json(sourceSuitePath); const localized = structuredClone(source);
  for (const session of localized.sessions) {
    for (const target of TARGETS) {
      const original = session.targets[target]; const input = typeof original === "string" ? { run: original } : original;
      const relative = slash(path.join("evidence", session.phase, session.consistency, session.repetition || session.id, target));
      const destination = path.join(packageRoot, relative); fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(path.resolve(sourceRoot, input.run), destination, { recursive: true, errorOnExist: true });
      const localizedInput = { run: relative };
      if (input.capacityEvents) {
        const capacityRelative = slash(path.join(relative, "capacity-events.json"));
        fs.copyFileSync(path.resolve(sourceRoot, input.capacityEvents), path.join(packageRoot, capacityRelative));
        localizedInput.capacityEvents = capacityRelative;
      }
      session.targets[target] = localizedInput;
    }
  }
  localized.datasetCertificates = (source.datasetCertificates || []).map((certificate, index) => {
    if (typeof certificate !== "string") return certificate;
    const relative = slash(path.join("evidence", "dataset", `${index + 1}-${path.basename(certificate)}`));
    fs.mkdirSync(path.dirname(path.join(packageRoot, relative)), { recursive: true });
    fs.copyFileSync(path.resolve(sourceRoot, certificate), path.join(packageRoot, relative));
    return relative;
  });
  localized.additionalEvidence = (source.additionalEvidence || []).map((item, index) => {
    const input = typeof item === "string" ? { label: path.basename(item), path: item } : item;
    const sourcePath = path.resolve(sourceRoot, input.path);
    const relative = slash(path.join("evidence", "supporting", `${index + 1}-${path.basename(sourcePath)}`));
    const destination = path.join(packageRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(sourcePath, destination, { recursive: true, errorOnExist: true });
    return { ...input, path: relative };
  });
  const localizedSuite = path.join(packageRoot, "suite.json"); fs.writeFileSync(localizedSuite, `${JSON.stringify(localized, null, 2)}\n`);
  generateReport({ suite: localizedSuite, output: path.join(packageRoot, "index.html") });
  fs.writeFileSync(path.join(packageRoot, "README.md"), `# ${source.title}\n\nOpen \`index.html\` in a modern browser. Chart data is embedded; evidence links are relative to this directory.\n\nVerify the packaged files with \`manifest-sha256.json\` before review. Raw evidence may contain cloud identifiers and must be reviewed before external distribution.\n`);
  const entries = collect(packageRoot); const manifest = { schemaVersion: 1, benchmarkId: source.benchmarkId || null, generatedAt: new Date().toISOString(), fileCount: entries.length, entries };
  fs.writeFileSync(path.join(packageRoot, "manifest-sha256.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
