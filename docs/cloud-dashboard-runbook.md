# Cloud benchmark web-dashboard runbook

This runbook prepares the existing-infrastructure dashboard path for AWS DynamoDB, Autonomous Database API for DynamoDB, and OCI NoSQL. It does not create or delete database tables.

## Reference three-target topology

- AWS DynamoDB and its runner use `us-east-1`; place the runner in the same Availability Zone used by the prior benchmark (`us-east-1a`).
- Select an OCI CLI profile and region that can access both reviewed OCI targets; the profile name is environment-specific and must never be hardcoded.
- Autonomous Database must be `AVAILABLE` and use `BRING_YOUR_OWN_LICENSE`. Record both the ADB `compute-count`/general autoscaling flag and the DynamoDB-compatible table's provisioned RCU/WCU; do not treat either as an undocumented substitute for the other. Oracle's current billing documentation maps table capacity internally at 250 RCU/ECPU and 200 WCU/ECPU, rounds up, enforces a two-ECPU minimum per table, and always enables autoscaling for that table mapping. Confirm with the service team whether changing base `compute-count` affects the compatible API before using it as a benchmark variable.
- The dedicated ADB API table uses 500 RCU / 500 WCU. The dedicated OCI NoSQL table uses 1,000 RU / 1,000 WU. The temporary AWS table uses 500 RCU / 500 WCU.
- Keep all OCI tables after the run. Delete the temporary AWS table only after the final package and acceptance validation pass.

## One-time runner prerequisites

1. Put both OCI runners in a Dynamic Group scoped to the benchmark compartment.
2. Grant that Dynamic Group Run Command execution, `manage object-family`, and `manage nosql-family` in the benchmark compartment.
3. Enable the Compute Instance Run Command plugin and TCP/443 egress on both private runners.
4. For a first-time database bootstrap only, use the reviewed infrastructure procedure to create the dedicated API table and install the protected renewal credential on one cloud runner. Do not rotate an existing database password merely to add another load generator.
5. For a distributed ADB target, provision an independently scoped runtime on every selected destination runner without moving a plaintext secret through the local control plane:

   ```bash
   node scripts/bootstrap-adb-runner-from-source.mjs --profile=<oci-profile> --region=<region> --compartment-id=<runner-compartment-ocid> --source-runner-id=<existing-secured-runner-ocid> --destination-runner-ids=<runner-1-ocid>,<runner-2-ocid>,<runner-3-ocid> --database-id=<adb-ocid> --table=<benchmark-table> --image=<registry/image@sha256:digest>
   ```

   Each destination creates its own private RSA bootstrap key. Only ciphertext crosses Run Command; the destination requests and stores its own table-scoped `READ_WRITE` access key. The database password is not changed, and plaintext passwords or API keys never enter local files, command output, dashboard state, or benchmark evidence.

The promoted VM image must already contain the pinned container digest. Dashboard preflight validates it locally and never downloads from a registry; a missing digest blocks the run and requires a new image release.

Before opening a multi-target run, audit each AWS runner from its own execution identity. This verifies the readiness marker, local image digest, clock, table path (including any DynamoDB Gateway endpoint policy), and evidence prefix:

```text
node scripts/check-aws-runner-readiness.mjs --profile=<aws-profile> --region=<region> --runner-ids=<instance-id> --image=<registry/image@sha256:digest> --table=<table> --bucket=<evidence-bucket>
```

## Dashboard flow

1. Start the local dashboard and select **Use existing infrastructure**.
2. Enable AWS DynamoDB, ADB DynamoDB API, and OCI NoSQL.
3. Select the AWS runner/table/evidence bucket and the independent ADB and NoSQL profile, compartment, runners, tables, and evidence bucket.
4. Probe ADB tables and confirm the selected database ID matches the protected runner endpoint.
5. Select the four `dallas-1000-*` profiles and set three repetitions for each.
6. Enable **Measure and compare preload performance** and set the aggregate offered writes/s, maximum in-flight writes, transient-error attempts, and retry base delay. The dashboard assigns one shared preload T0 and adds elapsed time, achieved throughput, latency percentiles, failures, retries, write units, start skew, and operation evidence to the package. Preload retries cover only HTTP 429/5xx responses and do not alter the measured workload's retry policy.
7. Leave T0 blank to use the OCI-safe automatic value of 900 seconds. Run Command delivery in this environment was observed above six minutes; lowering T0 can invalidate synchronized-start fairness.
8. Approve canonical preload writes, review the immutable matrix, and start the cloud benchmark.
9. Do not start another run while any provider command from the previous run remains `ACCEPTED` or `IN_PROGRESS`.

## Expected guardrails

- Preflight verifies SSM/Run Command, Podman, the persistent runner directory, and the exact pinned image without package or registry access.
- Resource validation checks existing table state, schema, endpoint identity, and provisioned capacity without creating infrastructure.
- Preload is idempotent. When preload measurement is enabled, all targets receive the same offered write rate and shared UTC start; compare achieved throughput together with failures and latency rather than treating the requested rate as achieved throughput. Strong certification must produce the same canonical hash on all three products before workload execution.
- Each workload gets one shared UTC T0. Evidence upload and final accounting must complete before the next session.
- A failed delivery is canceled to avoid hidden queue overlap. Inspect provider-side command status before retrying because a cancellation request can race with late delivery.
- A transient AWS or OCI status-poll failure is retried with backoff and retained in `control/command-journal.ndjson`; it is a control-plane visibility event, not evidence that the remote workload failed.
- A nonzero workload command triggers final-evidence collection before any pipeline decision. Fully accounted service errors are recorded in the comparison and do not block the remaining sessions.
- **Resume verified checkpoint** is available only after every immutable dataset gate passes. It reconciles the interrupted session, reuses finalized work, and assigns a new shared T0 only to the next unexecuted session.
- The live OCI progress uploader is best-effort; final evidence reconnects with a fresh Object Storage client and retries. Package generation streams the evidence into the ZIP and validates every incremental SHA-256/CRC rather than buffering the complete matrix in memory.

## Troubleshooting learned from the reference run

- `CredentialsProviderError` with a valid runtime usually means `sudo` stripped inherited variables. Use the protected `adb-api.runtime.env`; do not pass credentials as inherited `-e NAME` values.
- `ENOENT configs/dallas-1000-*.json` means the pinned runner image predates the workload profiles. Use the dashboard default digest or publish and select a newer immutable digest.
- `ACCEPTED` for several minutes is a control-plane delivery delay, not a NoSQL capacity failure. Keep the 900-second delivery/T0 defaults and inspect command execution before retrying.
- HTTP `429` or `504` responses from the ADB DynamoDB-compatible endpoint, SDK deserialization errors caused by an HTML gateway body, or growing request timeouts indicate endpoint saturation even when the mapped table still reports sufficient RCU/WCU. Preserve the complete requested matrix unless the operator explicitly stops it, inspect failures by offered-rate step, and distinguish table-mapped capacity from the ADB base `compute-count`. In one observed 900-byte strong-read rehearsal, a database configured with base `compute-count=2` began returning errors at 300 operations/s; treat that as an environment observation, not a universal sizing ratio or proof that base compute controls the API.
- `EACCES` during encrypted bootstrap requires both SELinux relabel `:Z` and `--user 0:0` on the two ephemeral bootstrap containers. Normal workload containers retain their normal user.
