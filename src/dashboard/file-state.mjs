import fs from "node:fs";
import path from "node:path";

export const stateFileName = ".dashboard-state.json";

export function writeStateAtomic(directory, state) {
  fs.mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, stateFileName);
  const temporary = path.join(directory, `${stateFileName}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, destination);
  return destination;
}

export function readRunStates(outputRoot) {
  if (!fs.existsSync(outputRoot)) return [];
  const restored = [];
  for (const entry of fs.readdirSync(outputRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(outputRoot, entry.name), file = path.join(directory, stateFileName);
    if (!fs.existsSync(file)) continue;
    try {
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      if (state?.id === entry.name && state.output === directory) restored.push(state);
    } catch {
      // Ignore an unreadable snapshot; atomic writes keep the previous file intact.
    }
  }
  return restored;
}
