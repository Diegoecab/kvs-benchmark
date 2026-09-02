# Cloud benchmark web-dashboard runbook

This runbook prepares the existing-infrastructure dashboard path for AWS DynamoDB, Autonomous Database API for DynamoDB, and OCI NoSQL. It does not create or delete database tables.

## Reference three-target topology

- AWS DynamoDB and its runner use `us-east-1`; place the runner in the same Availability Zone used by the prior benchmark (`us-east-1a`).
- Select an OCI CLI profile and region that can access both reviewed OCI targets; the profile name is environment-specific and must never be hardcoded.
- Autonomous Database must be `AVAILABLE`, use `BRING_YOUR_OWN_LICENSE`, have 2 ECPU, and have base compute autoscaling disabled.
- The dedicated ADB API table uses 500 RCU / 500 WCU. The dedicated OCI NoSQL table uses 1,000 RU / 1,000 WU. The temporary AWS table uses 500 RCU / 500 WCU.
- Keep all OCI tables after the run. Delete the temporary AWS table only after the final package and acceptance validation pass.

## One-time runner prerequisites

1. Put both OCI runners in a Dynamic Group scoped to the benchmark compartment.
2. Grant that Dynamic Group Run Command execution, `manage object-family`, and `manage nosql-family` in the benchmark compartment.
3. Enable the Compute Instance Run Command plugin and TCP/443 egress on both private runners.
4. Run `scripts/bootstrap-existing-adb-ddb-api.ps1` from the infrastructure repository to validate BYOL, rotate the transient ADMIN password, issue a time-limited API key, and set the dedicated table to 500/500.
5. Run `scripts/bootstrap-adb-runner-runtime.mjs` from this repository to transfer that key to the ADB runner using RSA-OAEP ciphertext. Confirm `ADB_RUNNER_RUNTIME_READY`.

The dashboard preflight now downloads its pinned image digest when it is missing. No manual image pull is required.

## Dashboard flow

1. Start the local dashboard and select **Use existing infrastructure**.
2. Enable AWS DynamoDB, ADB DynamoDB API, and OCI NoSQL.
3. Select the AWS runner/table/evidence bucket and the independent ADB and NoSQL profile, compartment, runners, tables, and evidence bucket.
4. Probe ADB tables and confirm the selected database ID matches the protected runner endpoint.
5. Select the four `dallas-1000-*` profiles and set three repetitions for each.
6. Leave T0 blank to use the OCI-safe automatic value of 900 seconds. Run Command delivery in this environment was observed above six minutes; lowering T0 can invalidate synchronized-start fairness.
7. Approve canonical preload writes, review the immutable matrix, and start the cloud benchmark.
8. Do not start another run while any provider command from the previous run remains `ACCEPTED` or `IN_PROGRESS`.

## Expected guardrails

- Preflight verifies SSM/Run Command, Podman, and the exact pinned image. Missing images are pulled automatically.
- Resource validation checks existing table state, schema, endpoint identity, and provisioned capacity without creating infrastructure.
- Preload is idempotent. Strong certification must produce the same canonical hash on all three products before workload execution.
- Each workload gets one shared UTC T0. Evidence upload and final accounting must complete before the next session.
- A failed delivery is canceled to avoid hidden queue overlap. Inspect provider-side command status before retrying because a cancellation request can race with late delivery.

## Troubleshooting learned from the reference run

- `CredentialsProviderError` with a valid runtime usually means `sudo` stripped inherited variables. Use the protected `adb-api.runtime.env`; do not pass credentials as inherited `-e NAME` values.
- `ENOENT configs/dallas-1000-*.json` means the pinned runner image predates the workload profiles. Use the dashboard default digest or publish and select a newer immutable digest.
- `ACCEPTED` for several minutes is a control-plane delivery delay, not a NoSQL capacity failure. Keep the 900-second delivery/T0 defaults and inspect command execution before retrying.
- `EACCES` during encrypted bootstrap requires both SELinux relabel `:Z` and `--user 0:0` on the two ephemeral bootstrap containers. Normal workload containers retain their normal user.
