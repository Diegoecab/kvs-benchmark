import fs from "node:fs";
import path from "node:path";

const excluded = new Set([".git", ".kvs", "node_modules", "results", "benchmark-package"]);
const patterns = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /ocid1\.[a-z]+\.oc1/i,
  /aws_secret_access_key\s*=\s*["'](?!\$)[^"']+/i,
  /(?:password|secretAccessKey)\s*[=:]\s*["'][^"']+/i
];
const findings = [];
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(full);
    else if (entry.isFile() && fs.statSync(full).size < 2_000_000) {
      const text = fs.readFileSync(full, "utf8");
      for (const pattern of patterns) if (pattern.test(text)) findings.push(`${full}: ${pattern}`);
    }
  }
}
visit(process.cwd());
if (findings.length) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exitCode = 1;
} else process.stdout.write("No high-confidence credential or OCID patterns found.\n");
