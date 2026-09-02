# KVS Benchmark

Reproducible, client-observed KV benchmarking for:

- AWS DynamoDB
- Oracle Autonomous AI Database DynamoDB API
- OCI NoSQL Database Cloud Service

The harness defines its own versioned methodology for deterministic open-loop scheduling, synchronized UTC starts, capacity-transition timelines, complete error metadata, client-concurrency telemetry, and evidence packaging.

## Status

`v0.1` provides validated workload specifications, deterministic operation generation, AWS/ADB and OCI NoSQL adapters, open-loop and fixed-concurrency closed-loop execution, synchronized starts and Phase 1 capacity transitions, preload performance measurement, concurrency/client-health telemetry, live dashboard progress, HTML evidence packaging, and offline tests. Cloud provisioning remains outside this repository.

The optional local control dashboard is documented in [docs/local-control-dashboard.md](docs/local-control-dashboard.md). It discovers local AWS/OCI profile names, builds a validated run matrix, exports a reviewable run specification, executes local functional tests, and remotely runs benchmarks on pre-existing regional AWS/OCI runners. Infrastructure provisioning remains outside this repository.

The harness also loads and certifies the canonical dataset in pre-existing, dedicated benchmark tables. It does not provision cloud infrastructure or create tables.

## Quick start

For the complete cloud sequence, use the [one-page quick start](docs/quickstart.md).

```bash
npm ci
npm test
node src/cli.mjs validate --config=configs/x1-read-open-loop.json
node src/cli.mjs run --config=configs/smoke.json --target=mock --table=local --output=results/mock
npm run dashboard
```

Dataset workflow:

```bash
node src/cli.mjs preload --config=configs/x1-read-open-loop.json --target=mock --table=local --output=results/preload
node src/cli.mjs certify --config=configs/x1-read-open-loop.json --target=mock --table=local --output=results/audit
```

Cloud credentials are never accepted in configuration files. Use the standard SDK environment/profile mechanisms described in [docs/running.md](docs/running.md).

## Dashboard quick start

From the repository root:

```bash
npm ci
npm run dashboard
```

Then open `http://127.0.0.1:4177` and follow the five-step wizard. The dashboard and cloud controller run on Node.js on macOS, Linux, and Windows.

1. Keep **Use existing infrastructure** selected; the separate `kvs-benchmark-infra` adapter is not enabled yet.
2. Choose AWS and/or OCI, then select products, profiles, regions, regional runners, compartments, tables, and provider-native evidence buckets.
3. Select workload profiles and optional overrides. Model-specific overrides are applied only where compatible.
4. Select **Async** (default) or **Live**. Live mode displays provisional throughput, completed and failed operations, in-flight requests, and rolling P95 latency by target during workload sessions.
5. Review the immutable matrix and select either **Run local functional test** or **Run selected cloud benchmark**. Cloud execution supports any one, two, or all three enabled products.

The local functional test is safe and does not contact AWS or OCI. It runs a two-second in-memory workload through the real scheduler, metrics, report, and packaging path. When it reaches `COMPLETE`, select **Download benchmark output (.zip)**. The ZIP contains the standalone HTML report, operation and telemetry evidence, final summary, effective configuration, and SHA-256 manifest. Evidence is also written under `.kvs/runs/<run-id>/`.

For cloud execution against existing runners, install the AWS CLI and OCI CLI before starting the dashboard. AWS uses Systems Manager plus S3; OCI uses Compute Run Command plus Object Storage. No SSH client, SCP, private key, or public runner IP is required. Complete the [cloud execution prerequisites](docs/cloud-prerequisites.md), then follow the behavior documented in [docs/local-control-dashboard.md](docs/local-control-dashboard.md).

## Cloud acceptance pipeline

The cloud benchmark uses existing dedicated tables and runners. A run advances only after each gate succeeds:

1. runner readiness and immutable image validation;
2. existing resource, endpoint, schema, and capacity validation;
3. canonical dataset preload;
4. strong-read certification and identical dataset hash across targets;
5. one shared UTC T0 for each workload session;
6. evidence collection, operation accounting, acceptance validation, and package generation.

The optional **Measure and compare preload performance** control schedules the canonical preload at one shared UTC T0. Configure the offered writes/s and maximum in-flight writes in step 4. Its evidence includes actual start and skew, elapsed time, requested/completed/failed writes, attempted and successful throughput, P50/P90/P95/P99/P99.9/max latency, attempts, retries, provider-reported write units, and operation-level NDJSON. A requested rate is an offered load, not an achieved-throughput result. Missing consumed-capacity data is reported as unavailable.

Live values are provisional and intended for operational visibility. The active-run overview uses one provider-logo card per target to show the human-readable phase, region, table, runner, and target state instead of making the raw state JSON the primary view. The status card identifies the active workload and its effective read/write mix, consistency, load model, execution mode, schedule or concurrency, duration, retry policy, timeout, dataset shape, repetition, and shared T0. Per-target progress shows absolute accounting and percentage. The target-comparison charts plot the current observed throughput against offered load and rolling P95 latency; AWS DynamoDB, ADB DynamoDB API, OCI NoSQL, and offered-load series can be shown or hidden independently. Live throughput uses deltas inside the active workload window, excluding control-plane delivery time before T0. Persisted workload logs reconstruct the chart after a browser refresh. The run-timeline browser preserves every pipeline gate and every workload session as a selectable view: completed preload/certification results remain available while a later gate runs, and each six-level workload schedule shows completed, active, and pending levels. The execution history keeps the active run pinned and exposes previous local and cloud runs as read-only records with status, configuration, per-target session results, elapsed time, and package download. Raw JSON remains available only inside the collapsed technical-details disclosure. Accepted comparisons use the complete operation evidence and final summaries in the downloadable ZIP.

Provider commands run independently from browser polling. Transient AWS and OCI CLI/control-plane read failures are retried with backoff and recorded in `control/command-journal.ndjson`; they do not turn a remote workload into a service failure. If orchestration is interrupted after the immutable dataset gates pass, **Resume verified checkpoint** first reconciles the interrupted session's final evidence, reuses completed gates and sessions, and then advances the remaining matrix. A provider command's nonzero exit also triggers final-evidence collection: fully accounted service errors remain benchmark results instead of prematurely stopping later sessions.

While a benchmark is queued, running, or stopping, the dashboard is monitor-only: configuration steps and both launch actions are disabled. **Stop run** cancels active provider commands while preserving tables, infrastructure, and collected evidence. Cleanup is deliberately separate and requires explicit authorization plus an exact resource list. The Dallas 1,000 RU/WU profiles use six 60-second levels per session, preserving ramp-up, peak, and recovery while keeping the three-repetition matrix operationally practical.

Use [the reusable cloud runbook](docs/cloud-dashboard-runbook.md) for the three-target topology, portable ADB API bootstrap, T0 guidance, and troubleshooting. Resource cleanup is not part of automatic acceptance: keep OCI tables unless an independently authorized operation says otherwise, and remove a temporary resource only after its final package has passed validation.

## Embedded benchmark operator

The repository includes the `kvs-benchmark-operator` skill for Codex and Claude Code. It launches authorized runs, follows an active run, summarizes preload/workload evidence, diagnoses failed gates, and reports final package status from the same dashboard state without implementing a separate benchmark path.

Example requests:

```text
Use $kvs-benchmark-operator to show the live benchmark status.
Use $kvs-benchmark-operator to summarize the latest completed run.
```

For a portable read-only snapshot from the repository root:

```bash
node .codex/skills/kvs-benchmark-operator/scripts/snapshot.mjs
node .codex/skills/kvs-benchmark-operator/scripts/snapshot.mjs --run-id=<run-id>
```

The snapshot reports the active stage, targets, current session, shared T0, completed matrix sessions, final preload metrics, provisional workload metrics, last event, error state, and package readiness. See [the skill instructions](.codex/skills/kvs-benchmark-operator/SKILL.md).

## Reproducibility contract

Every accepted comparison must use the same:

- workload configuration and commit SHA;
- logical dataset, seed, payload and key distribution;
- scheduled operation stream and UTC start;
- consistency, retries, timeout and connection policy;
- client VM class and telemetry requirements;
- acceptance rules and evidence schema.

See [methodology](docs/methodology.md), [fairness rules](docs/fairness.md), and [contributing](CONTRIBUTING.md).

Strong and eventual consistency are separate checked-in profiles. They use the same deterministic operation schedule but are reported independently.

## Portable runner

AWS and OCI runners use the same `linux/amd64` container image and immutable digest. See the [container contract](docs/container.md). The image includes the harness and runtime dependencies, but never credentials or cloud-specific resource identifiers.

```bash
docker run --rm ghcr.io/diegoecab/kvs-benchmark-runner:main doctor --config=configs/smoke.json --target=mock --skip-network=true
```

## Phase 1 and deliverable

The explicit `phase1` command runs the workload and T+3/T+8 capacity controller against an existing dedicated table. It validates the active baseline first, and the final event must restore it. See [Phase 1](docs/phase1.md).

After accepted sessions are collected, generate the portable English HTML report and checksummed evidence package:

```bash
node src/cli.mjs package --suite=results/suite.json --output=benchmark-package
```

See [reporting](docs/reporting.md) and `configs/report-suite.example.json`.

## Security

Do not commit cloud credentials, wallets, private keys, raw customer evidence, account identifiers, OCIDs, IP addresses, or Terraform state. See [SECURITY.md](SECURITY.md).
