# Local benchmark control dashboard

## Current planning and local-test milestone

Start the local dashboard from the repository checkout:

```bash
npm run dashboard
```

Then open `http://127.0.0.1:4177`. The service binds only to loopback.

The current implementation:

- detects AWS profile names through `aws configure list-profiles`;
- detects OCI profile names from `OCI_CONFIG_FILE` or `~/.oci/config`;
- provides separate profile listboxes for AWS DynamoDB, ADB DynamoDB API, and OCI NoSQL;
- selects regions and existing database/table references;
- selects one or more checked-in workload profiles and validated overrides;
- previews exact duration, operations per target, target executions, and total database minutes;
- exports the reviewed JSON run specification;
- executes a fixed local-only smoke benchmark through the real open-loop harness;
- displays live accounted/completed/failed operation counts and the final throughput and P95 latency;
- persists local smoke evidence under `.kvs/runs/<run-id>/`.

Only profile names reach the browser. Credential values are never read into the UI. The local smoke action always uses `configs/smoke.json`, target `mock`, table `local-dashboard-smoke`, and never invokes a cloud SDK or CLI. In this milestone, the cloud **Start benchmark** action is disabled and managed infrastructure is plan-intent only: no Terraform, create, update, stop, or delete command can be triggered from the dashboard.

## Repeat the local functional test

1. Install dependencies with `npm ci`.
2. Start the service with `npm run dashboard`.
3. Open `http://127.0.0.1:4177`.
4. Confirm that the header reports the detected AWS and OCI profile counts.
5. Select a checked-in workload and use **Build preview** to validate the matrix. This is read-only and does not check that the named cloud resource exists.
6. Under **Local test**, select **Start local smoke test**.
7. Wait for status `COMPLETE` and verify `20 of 20 operations accounted`, `Completed: 20`, and `Failed: 0`.
8. Inspect the displayed evidence directory. It contains:

   - `operations.ndjson`;
   - `telemetry.ndjson`;
   - `summary.json`;
   - `run-config.json`.

The smoke workload runs for two seconds at 10 operations/s and uses strong reads against the in-memory mock provider. `.kvs/` is excluded from Git.

## Current local API

The browser uses a launch-specific token in the `x-kvs-csrf` header for mutating local actions:

- `GET /api/bootstrap`: detected profile names, valid workload configurations, defaults and capabilities.
- `POST /api/preview`: validates and expands a proposed matrix without contacting a provider.
- `POST /api/local-smoke`: starts the fixed local mock test and returns a run ID.
- `GET /api/runs/<run-id>`: returns current progress and the final summary.

Only one local smoke run can be active at a time. Run state is held in memory while its evidence is persisted. Restarting the dashboard does not resume an interrupted run yet.

## Architecture recommendation

Add an optional local control plane to this repository. A static HTML page alone cannot safely invoke AWS/OCI CLIs, containers, SSH, or Terraform because browsers intentionally cannot execute local processes. The practical design is:

```text
Browser at http://127.0.0.1:<port>
        │ HTTP + Server-Sent Events
        ▼
Local Node.js control service
        ├─ benchmark profiles and matrix expansion
        ├─ doctor/preload/certify/coordinator/metrics/package
        ├─ AWS CLI, OCI CLI, SSH and container adapters
        └─ optional infrastructure adapter → separate Terraform repository
```

The UI and local service belong in `kvs-benchmark`. Infrastructure code remains in a separate repository and is called only when the operator explicitly enables infrastructure management for a run.

## Operator flow

1. Start with `npm run dashboard` on loopback only.
2. Select **existing infrastructure** (default) or **manage infrastructure for this run**.
3. Choose credential profile references such as `dynamodb_poc` and `PITWALL_API`; never enter or persist secret material in the browser.
4. Select target regions, tables, runners, consistency, read/write mix, duration, offered-load steps, retries, execution mode, fixed concurrency, capacity and Phase 1 events.
5. Expand the requested combinations into an immutable run matrix and review the exact operation count, time and estimated database cost.
6. Run non-mutating doctors. Infrastructure mode additionally runs `terraform init` and `terraform plan`, then requires a separate approval before `apply`.
7. Preload and certify the canonical dataset once per target triplet.
8. Launch synchronized triplets, watch progress and errors live, and resume collection after a local interruption.
9. Collect provider metrics, validate acceptance gates, generate the English HTML/package, and present the teardown plan.
10. Require explicit approval for teardown. Record every stopped/deleted resource in evidence.

## Configuration model

The dashboard writes a reviewable YAML or JSON run specification; it does not invent hidden runtime flags. Suggested top-level objects:

- `targets`: AWS DynamoDB, ADB DynamoDB API and OCI NoSQL connection/resource references.
- `infrastructure`: `mode: existing|managed`, optional infra repository path/ref, Terraform workspace and variable-file references.
- `dataset`: key count, payload bytes, partition buckets, distribution and seed.
- `workloads[]`: consistency, read/write percentages, write mode, open/closed loop and repetition count.
- `load`: duration, step schedule, rate multiplier, fixed concurrency, max inflight and client timeouts.
- `capacity`: high/low capacity per provider and transition timestamps.
- `acceptance`: start skew, scheduler drops, raw accounting, certificate equality and rerun policy.
- `reporting`: database-only pricing evidence, labels, references and package destination.
- `teardown`: disabled by default; stop-when-supported/delete-otherwise policy plus an explicit approval token.

Every effective target command, config hash, image digest, Git commit and UTC window is persisted under a run ID.

## Live progress

Use Server-Sent Events for one-way progress; WebSockets are unnecessary initially. Events should include:

- lifecycle state (`planned`, `preflight`, `certifying`, `scheduled`, `running`, `collecting`, `validating`, `reporting`, `complete`, `failed`);
- shared T0 and remaining time;
- current phase/load step and offered rate;
- per-target scheduled/completed/failed operations, success rate, inflight and client health;
- capacity requests and applied timestamps;
- warnings for clock skew, scheduler drops, credential expiry and collection lag;
- links to partial logs and final evidence.

The UI must label provisional live percentiles as provisional. Accepted statistics come from the final immutable evidence files.

## Safety and security

- Bind to `127.0.0.1`, generate a per-launch CSRF/session token and set strict origin checks.
- Store only profile names and resource identifiers. Use the standard AWS/OCI credential chains in the backend process.
- Redact access keys, passwords, authorization headers, wallet contents and signed URLs from logs.
- Keep infrastructure mutation disabled unless the run specification enables it and the operator approves the rendered plan.
- Allowlist executable paths and argument schemas; never execute free-form shell text received from the browser.
- Display an exact resource inventory before stop/delete and retain teardown evidence.
- Keep `.kvs/runs`, raw evidence and local state out of Git; commit only code, schemas and safe example profiles.

## Persistent run state

Persist an append-only event log and a compact state snapshot under `.kvs/runs/<run-id>/`. A restart should reconstruct state from evidence and resume collection/reporting without rerunning completed workloads. Cloud mutations require idempotency keys or current-state checks.

## Delivery milestones

1. **Planning and local-test MVP (implemented):** profile discovery, target/profile selection, matrix preview, run-spec export and fixed local mock execution with progress/evidence; no cloud mutations or cloud execution.
2. **Execution MVP:** doctors, synchronized execution against existing infrastructure, SSE progress and report/package generation.
3. **Operational reliability:** persistent state, resume, provider metrics, evidence browser, pricing preview and teardown inventory/approval.
4. **Optional infrastructure:** typed adapter for a separate Terraform repository, plan review, apply/destroy approvals and output import.
5. **Collaboration:** versioned safe run specifications, pull-request review and portable package publishing; credentials and raw evidence remain local or in approved artifact storage.

This keeps the benchmark engine reusable from both CLI and UI: the dashboard calls the same internal orchestration APIs rather than implementing a second runner.
