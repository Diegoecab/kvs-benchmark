# Local benchmark control dashboard

## Quick start

```bash
npm ci
npm run dashboard
```

Open `http://127.0.0.1:4177`. The service binds only to loopback.

The commands are portable across Windows, macOS, and Linux. Cloud acceptance additionally requires `aws`, `oci`, `ssh`, and `scp` in `PATH`, configured AWS/OCI profiles, and the existing OCI runner key exposed only to the local server:

```powershell
# Windows PowerShell
$env:KVS_OCI_SSH_KEY = 'C:\path\to\oci-runner-key'
npm run dashboard
```

```bash
# macOS or Linux
export KVS_OCI_SSH_KEY="$HOME/.ssh/oci-runner-key"
npm run dashboard
```

The key path and key contents are never returned to the browser or stored in a run specification.

The five-step wizard covers:

1. AWS and OCI profiles, regions, OCI compartments, regional runners, and lookup-backed existing KVS resources.
2. Existing-infrastructure or plan-only managed-infrastructure intent.
3. Checked-in workload combinations and validated runtime overrides.
4. Async or live execution behavior.
5. A final configuration summary, immutable matrix preview, functional test, and output download.

Every workload override has contextual help in the UI. Only profile names reach the browser; credentials remain in standard AWS and OCI provider chains.

The workload selector is model-aware. `executionMode` and `rateMultiplier` apply only to open-loop profiles, while `fixedConcurrency` applies only to fixed closed-loop profiles. In a mixed matrix, incompatible overrides are ignored for those rows and shown as preview warnings instead of rejecting the entire matrix. Selecting sequential open-loop scheduling automatically enforces one in-flight request.

## Async and live modes

**Async** is the default. Starting a run immediately returns its ID and the server continues processing if the browser tab is closed. The browser remembers the latest run ID and reconnects when reopened. The dashboard process must remain running; restart recovery is a later milestone.

**Live** uses the same immutable run configuration but refreshes more frequently. It displays accounted, successful and failed operations, current achieved throughput, in-flight requests, latest operation latency, and the final P95. Live metrics are provisional until the evidence is finalized.

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

## Cloud acceptance test

The cloud acceptance action is a short, fixed safety gate before larger benchmark matrices. It can run against any one, two, or three enabled products, uses only selected existing infrastructure, and performs these visible stages:

1. Runner readiness and immutable container-image presence.
2. Existing table, key-schema, capacity, endpoint, and credential validation.
3. Canonical 100-key dataset preload after explicit write authorization.
4. Strong-read certification on AWS DynamoDB, ADB DynamoDB API, and OCI NoSQL.
5. SHA-256 validation and, when multiple products are enabled, cross-target comparison.
6. Shared UTC T0 assignment with at least 120 seconds of lead time.
7. Synchronized two-second, 10 reads/s workload on all three regional VMs.
8. Evidence collection and accounting/configuration/T0 acceptance checks.
9. Standalone HTML report, evidence index, integrity manifest, and ZIP generation.

The local process is a control plane only. Database calls and latency measurement execute on the selected regional VMs. Cloud acceptance does not create, resize, stop, or delete infrastructure. Preload is the only database mutation and requires the explicit UI checkbox.

Destination lookup is read-only. AWS tables are listed from the selected AWS profile and region. OCI compartments are listed at `ACCESSIBLE` scope and displayed with their complete hierarchy, then Autonomous Databases and OCI NoSQL tables are filtered by the selected compartment. DynamoDB-API tables are listed from the selected ADB runner so ADB credentials remain on that VM. A manual table-name option remains available for advanced cases.

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

- The short cloud acceptance pipeline is connected; arbitrary checked-in workload matrices remain a later milestone.
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

1. Generalize the validated cloud adapter from fixed acceptance smoke to arbitrary immutable matrix rows and repetitions.
2. Replace status polling with Server-Sent Events and persist an append-only state/event log for restart recovery.
3. Add provider metrics, evidence browser, pricing preview, report/package generation, and a teardown inventory that requires explicit approval.
4. Add an isolated exploratory-live controller with timestamped parameter setpoints and a non-comparable report label.
5. Add the optional typed Terraform adapter with separate plan/apply/destroy approvals.

The dashboard must continue calling the same benchmark engine used by the CLI; it must not implement a second workload generator.
