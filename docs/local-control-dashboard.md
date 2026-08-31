# Local benchmark control dashboard

## Quick start

```bash
npm ci
npm run dashboard
```

Open `http://127.0.0.1:4177`. The service binds only to loopback.

The five-step wizard covers:

1. AWS and OCI profiles, regions, and existing KVS resources.
2. Existing-infrastructure or plan-only managed-infrastructure intent.
3. Checked-in workload combinations and validated runtime overrides.
4. Async or live execution behavior.
5. A final configuration summary, immutable matrix preview, functional test, and output download.

Every workload override has contextual help in the UI. Only profile names reach the browser; credentials remain in standard AWS and OCI provider chains.

## Async and live modes

**Async** is the default. Starting a run immediately returns its ID and the server continues processing if the browser tab is closed. The browser remembers the latest run ID and reconnects when reopened. The dashboard process must remain running; restart recovery is a later milestone.

**Live** uses the same immutable run configuration but refreshes more frequently. It displays accounted, successful and failed operations, current achieved throughput, in-flight requests, latest operation latency, and the final P95. Live metrics are provisional until the evidence is finalized.

Changing parameters during an accepted benchmark would invalidate direct comparison between providers. A future **exploratory live** mode may change offered rate, concurrency, or read/write mix, but each control change must be timestamped in the event log and the resulting report must be marked non-comparable. Consistency, dataset, payload, retries, and operation semantics should remain immutable for a session.

## Current safe functional test

The local smoke test runs for two seconds at 10 reads/s against an in-memory mock target. It uses the production scheduler, metrics, evidence, reporting, and packaging path without invoking a cloud SDK or changing infrastructure.

On completion, **Download benchmark output (.zip)** provides:

- `index.html`: standalone English report;
- `operations.ndjson`: per-operation evidence;
- `telemetry.ndjson`: harness telemetry;
- `summary.json`: accepted final metrics;
- `run-config.json`: immutable effective configuration;
- `manifest-sha256.json`: integrity hashes for the packaged files.

The same files remain under `.kvs/runs/<run-id>/`, which is excluded from Git.

## Current local API

- `GET /api/bootstrap`: safe profile names, workload configurations, defaults, and capabilities.
- `POST /api/preview`: validates and expands a matrix without contacting providers.
- `POST /api/local-smoke` with `{"mode":"async"}` or `{"mode":"live"}`: starts the local test.
- `GET /api/runs/<run-id>`: current progress and final summary.
- `GET /api/runs/<run-id>/download`: final HTML-plus-evidence ZIP.

Mutating calls require the per-launch `x-kvs-csrf` token. Only one local smoke run can be active. Run state is currently held in memory; completed evidence persists on disk.

## Current scope and safety

- Cloud benchmark execution is not connected to the dashboard yet.
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

1. Connect doctors and synchronized execution against existing AWS/OCI resources.
2. Replace status polling with Server-Sent Events and persist an append-only state/event log for restart recovery.
3. Add provider metrics, evidence browser, pricing preview, report/package generation, and a teardown inventory that requires explicit approval.
4. Add an isolated exploratory-live controller with timestamped parameter setpoints and a non-comparable report label.
5. Add the optional typed Terraform adapter with separate plan/apply/destroy approvals.

The dashboard must continue calling the same benchmark engine used by the CLI; it must not implement a second workload generator.
