import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, scheduledOperationCount } from "../core/config.mjs";
import { runOpenLoop } from "../core/open-loop.mjs";
import { createMockProvider } from "../providers/mock.mjs";
import { finalizeLocalArtifact } from "./artifact.mjs";
import { readRunStates, writeStateAtomic } from "./file-state.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultConfig = path.join(repositoryRoot, "configs", "smoke.json");
const defaultOutput = path.join(repositoryRoot, ".kvs", "runs");

function visible(state) {
  return {
    schemaVersion: 1,
    id: state.id,
    kind: "local-mock-smoke",
    mode: state.mode,
    status: state.status,
    createdAt: state.createdAt,
    startedAt: state.startedAt || null,
    completedAt: state.completedAt || null,
    output: state.outputRelative,
    progress: state.progress,
    logs: state.logs || [],
    summary: state.summary || null,
    error: state.error || null,
    downloadUrl: state.archiveFile ? `/api/runs/${encodeURIComponent(state.id)}/download` : null,
  };
}

export class LocalSmokeRuns {
  constructor({ configFile = defaultConfig, outputRoot = defaultOutput, startDelayMs = 300 } = {}) {
    this.configFile = configFile;
    this.outputRoot = outputRoot;
    this.startDelayMs = startDelayMs;
    this.runs = new Map();
    for (const state of readRunStates(outputRoot)) {
      if (["queued", "running"].includes(state.status)) { state.status = "failed"; state.completedAt = new Date().toISOString(); state.error = "Dashboard restarted while the local functional test was active."; state.logs ||= []; state.logs.push({ at: state.completedAt, level: "error", stage: "local-smoke", target: "mock", message: state.error }); }
      if (state.archiveFile && !fs.existsSync(state.archiveFile)) state.archiveFile = null;
      this.runs.set(state.id, state); this.persist(state);
    }
  }
  persist(state) { writeStateAtomic(state.output, state); }

  start({ mode = "async" } = {}) {
    if (!["async", "live"].includes(mode)) throw new Error("mode must be async or live");
    if ([...this.runs.values()].some(run => ["queued", "running"].includes(run.status))) throw new Error("A local smoke test is already running");
    const loaded = readConfig(this.configFile);
    const id = `smoke-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
    const output = path.join(this.outputRoot, id);
    const state = {
      id,
      mode,
      status: "queued",
      createdAt: new Date().toISOString(),
      output,
      outputRelative: path.relative(repositoryRoot, output).replaceAll("\\", "/"),
      progress: { scheduled: scheduledOperationCount(loaded.config), accounted: 0, completed: 0, failed: 0, schedulerDrops: 0 },
      logs: [{ at: new Date().toISOString(), level: "info", stage: "local-smoke", target: "mock", message: "Local functional test queued" }],
    };
    this.runs.set(id, state); this.persist(state);
    void this.execute(state, loaded);
    return visible(state);
  }

  get(id) {
    const state = this.runs.get(id);
    if (!state) throw new Error("Local smoke run not found");
    return visible(state);
  }

  async execute(state, loaded) {
    let provider;
    try {
      fs.mkdirSync(state.output, { recursive: true });
      state.status = "running";
      state.startedAt = new Date().toISOString();
      state.logs.push({ at: state.startedAt, level: "info", stage: "local-smoke", target: "mock", message: "Mock-provider workload started" });
      this.persist(state);
      provider = await createMockProvider({ config: loaded.config });
      const summary = await runOpenLoop({
        config: loaded.config,
        configSha256: loaded.sha256,
        provider,
        target: "mock",
        table: "local-dashboard-smoke",
        output: state.output,
        startAt: new Date(Date.now() + this.startDelayMs).toISOString(),
        onProgress: progress => { state.progress = progress; this.persist(state); },
      });
      state.summary = summary;
      state.status = summary.harnessPassed ? "complete" : "failed";
      state.completedAt = new Date().toISOString();
      state.logs.push({ at: state.completedAt, level: state.status === "complete" ? "success" : "error", stage: "local-smoke", target: "mock", message: `${summary.completed}/${summary.scheduled} operations completed; ${summary.failed} failed` });
      if (state.status === "complete") Object.assign(state, finalizeLocalArtifact(state));
    } catch (error) {
      state.status = "failed";
      state.error = error.message;
      state.completedAt = new Date().toISOString();
      state.logs.push({ at: state.completedAt, level: "error", stage: "local-smoke", target: "mock", message: error.message });
    } finally {
      this.persist(state);
      await provider?.close();
    }
  }

  download(id) {
    const state = this.runs.get(id);
    if (!state?.archiveFile || !fs.existsSync(state.archiveFile)) throw new Error("Benchmark output is not ready");
    return state.archiveFile;
  }
}
