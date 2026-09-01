# Local benchmark control dashboard

## Quick start

```bash
npm ci
npm run dashboard
```

Open `http://127.0.0.1:4177`. The service binds only to loopback.

The commands are portable across Windows, macOS, and Linux. Cloud execution additionally requires `aws` and `oci` in `PATH` plus configured AWS/OCI profiles. AWS runners use Systems Manager and S3. OCI runners use Compute Run Command and Object Storage through instance principals. SSH, SCP, private keys, and public runner IPs are not prerequisites.

Before the first cloud run, complete the [cloud execution prerequisites](cloud-prerequisites.md). In particular, OCI uses separate operator and runner identities: an administrator profile may create a Run Command while the VM still cannot retrieve it unless its dynamic group has `instance-agent-command-execution-family` access.

The five-step wizard covers:

1. Existing-infrastructure or separate-repository managed-infrastructure intent. Managed deployment is not enabled in the current milestone.
2. Cloud providers, products, profiles, regions, OCI compartments, regional runners, evidence buckets, and lookup-backed existing KVS resources.
3. A comparison table of checked-in workload presets, with repetitions configured independently per preset, followed by optional validated custom runtime overrides.
4. Async or live execution behavior.
5. A final configuration summary, immutable matrix preview, functional test, and output download.

Every workload override has contextual help in the UI. Only profile names reach the browser; credentials remain in standard AWS and OCI provider chains.

ADB and OCI NoSQL have independent OCI profile and region contexts. Each compartment selector and resource inventory is resolved from its own selected profile/tenancy; changing either profile invalidates the prior runner and destination lookup so stale cross-tenancy selections cannot be reused.

The workload selector is model-aware. `executionMode` and `rateMultiplier` apply only to open-loop profiles, while `fixedConcurrency` applies only to fixed closed-loop profiles. In a mixed matrix, incompatible overrides are ignored for those rows and shown as preview warnings instead of rejecting the entire matrix. Selecting sequential open-loop scheduling automatically enforces one in-flight request.

## Async and live modes

**Async** is the default. Starting a run immediately returns its ID and the server continues processing if the browser tab is closed. The browser remembers the latest run ID and reconnects when reopened. Completed runs survive dashboard restarts through atomic file snapshots; an active run interrupted by a process restart is recovered as interrupted and requires provider-side command inspection before retrying.

## Persistence and recovery

The wizard saves a versioned draft in browser `localStorage`. A page refresh restores profiles by name, regions, selected destinations, workload values, execution mode, and the current wizard step after validating them against newly discovered resources. Search text, credentials, and the dataset-write authorization checkbox are never persisted. **Reset configuration** removes the saved draft without deleting run evidence.

Each local or cloud execution also writes an atomic `.dashboard-state.json` snapshot inside `.kvs/runs/<run-id>/` or `.kvs/cloud-runs/<run-id>/`. Completed runs and downloadable packages are restored after a dashboard restart without SQLite or another service. If the process stopped during an active run, the recovered state is marked failed/interrupted rather than silently resuming mutable orchestration; provider-side command status must be inspected before retrying. The original evidence and command control files remain available for that reconciliation.

**Live** uses the same immutable run configuration but refreshes more frequently. It displays per-target accounting, throughput, in-flight requests, latest latency, rolling P95, and a selectable timeline for AWS, ADB, OCI NoSQL, and offered load. Live metrics are provisional until the evidence is finalized.

Changing parameters during an accepted benchmark would invalidate direct comparison between providers. A future **exploratory live** mode may change offered rate, concurrency, or read/write mix, but each control change must be timestamped in the event log and the resulting report must be marked non-comparable. Consistency, dataset, payload, retries, and operation semantics should remain immutable for a session.

## Local functional test

The local smoke test runs for two seconds at 10 reads/s against an in-memory mock target. It uses the production scheduler, metrics, evidence, reporting, and packaging path without invoking a cloud SDK or changing infrastructure.

To execute it, finish the wizard and select **Run local functional test** in the review step. The identically wired **Start local smoke test** button below the results area can be used to run it again. Both buttons are disabled only while a test is active.

On completion, **Download benchmark output (.zip)** provides:

- `index.html`: standalone English report;
- `operations.ndjson`: per-operation evidence;
- `telemetry.ndjson`: harness telemetry;
- `summary.json`: accepted final metrics;
- `run-config.json`: immutable effective configuration;
- `manifest-sha256.json`: integrity hashes for the packaged files.

The same files remain under `.kvs/runs/<run-id>/`, which is excluded from Git.

## Cloud benchmark

The cloud action runs the selected preset/repetition matrix against any one, two, or three enabled products, uses only selected existing infrastructure, and performs these visible stages:

1. Runner readiness and immutable container-image presence.
2. Existing table, key-schema, capacity, endpoint, and credential validation.
3. Canonical 100-key dataset preload after explicit write authorization.
4. Strong-read certification on AWS DynamoDB, ADB DynamoDB API, and OCI NoSQL.
5. SHA-256 validation and, when multiple products are enabled, cross-target comparison.
6. Shared UTC T0 assignment with at least 120 seconds of lead time.
7. Each selected workload session on the enabled regional VMs, with one shared UTC T0 per session.
8. Evidence collection and accounting/configuration/T0 acceptance checks.
9. Standalone HTML report, evidence index, integrity manifest, and ZIP generation.

The local process is a control plane only. Database calls and latency measurement execute on the selected regional VMs. Cloud acceptance does not create, resize, stop, or delete infrastructure. Preload is the only database mutation and requires the explicit UI checkbox.

Destination lookup is read-only. AWS tables are listed from the selected AWS profile and region. OCI compartments are listed at `ACCESSIBLE` scope and displayed with their complete hierarchy, then Autonomous Databases, OCI NoSQL tables, and Object Storage buckets are filtered by the selected compartment. DynamoDB-API tables are listed through OCI Compute Run Command so ADB credentials remain on that VM. A manual table-name option remains available for advanced cases.

## Current local API

- `GET /api/bootstrap`: safe profile names, workload configurations, defaults, and capabilities.
- `POST /api/preview`: validates and expands a matrix without contacting providers.
- `POST /api/local-smoke` with `{"mode":"async"}` or `{"mode":"live"}`: starts the local test.
- `POST /api/discover-runners`: discovers running regional runners and benchmark evidence buckets using selected profile names.
- `POST /api/discover-destinations`: lists accessible OCI compartments, Autonomous Databases, and AWS/ADB/OCI NoSQL tables without mutation.
- `POST /api/cloud-acceptance`: starts the guarded three-target cloud acceptance pipeline.
- `GET /api/runs/<run-id>`: current progress and final summary.
- `GET /api/runs/<run-id>/download`: final HTML-plus-evidence ZIP.

Mutating calls require the per-launch `x-kvs-csrf` token. Only one local smoke run can be active. Run state is currently held in memory; completed evidence persists on disk.

## Current scope and safety

- The selected checked-in workload matrix is connected to AWS SSM and OCI Compute Run Command.
- Managed infrastructure is plan-intent only; the dashboard cannot run Terraform.
- No create, update, stop, delete, or teardown operation is available from the UI.
- The service binds to loopback, applies a restrictive content security policy, and never returns credential values.
- The backend accepts typed fields only and does not execute free-form shell commands from the browser.

## Target architecture

```text
Browser wizard at 127.0.0.1
        |
Local Node.js control service
        |-- run specification and immutable matrix
        |-- doctor, preload, certification, coordinator
        |-- async job state and live event stream
        |-- provider metrics, report, evidence package
        `-- optional typed adapter to a separate Terraform repository
```

The UI and service stay in `kvs-benchmark`. Optional infrastructure code belongs in a separate repository and can run only after explicit plan review and approval.

## Next milestones

1. Replace status polling with Server-Sent Events and persist an append-only state/event log for restart recovery.
2. Add provider metrics, evidence browser, pricing preview, richer report/package generation, and a teardown inventory that requires explicit approval.
3. Add an isolated exploratory-live controller with timestamped parameter setpoints and a non-comparable report label.
4. Connect the separate `kvs-benchmark-infra` repository with separate plan/apply/destroy approvals.

The dashboard must continue calling the same benchmark engine used by the CLI; it must not implement a second workload generator.
