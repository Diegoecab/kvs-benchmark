# Local benchmark control dashboard

## Recommendation

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

1. Start with `kvs-benchmark dashboard` on loopback only.
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

1. **Read-only MVP:** profile editor, matrix preview, doctor, synchronized execution against existing infrastructure, SSE progress and report/package generation.
2. **Operational reliability:** persistent state, resume, provider metrics, evidence browser, pricing preview and teardown inventory/approval.
3. **Optional infrastructure:** typed adapter for a separate Terraform repository, plan review, apply/destroy approvals and output import.
4. **Collaboration:** versioned safe run specifications, pull-request review and portable package publishing; credentials and raw evidence remain local or in approved artifact storage.

This keeps the benchmark engine reusable from both CLI and UI: the dashboard calls the same internal orchestration APIs rather than implementing a second runner.
