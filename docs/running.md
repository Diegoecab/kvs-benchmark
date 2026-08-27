# Running

## Mock smoke test

```bash
node src/cli.mjs run --config=configs/smoke.json --target=mock --table=local --output=results/mock
```

Use a reduced schedule for local development; the checked-in certified profiles run for 15 minutes.

## AWS DynamoDB

Use the standard AWS credential chain and set `AWS_REGION`. Pass the table name on the command line. No credential is stored in the repository.

```bash
node src/cli.mjs run --config=configs/x1-read-open-loop.json --target=aws --table=TABLE --output=results/aws --start-at=2026-01-01T00:00:00Z
```

## ADB DynamoDB API

Set short-lived `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION=us-ashburn-1`, and `DDB_ENDPOINT`. Then use `--target=adb`.

## OCI NoSQL

Set `OCI_REGION`, `OCI_COMPARTMENT_ID`, and either `OCI_USE_INSTANCE_PRINCIPAL=true` or the standard OCI SDK configuration variables. Then use `--target=ndcs`.

## Output

The output directory contains `operations.ndjson`, `telemetry.ndjson`, `summary.json`, and `run-config.json`. Treat raw evidence as potentially sensitive and do not commit it.

## Dataset preload and certificate

The table must already exist and be dedicated to the benchmark. Preload writes exactly 10,000 canonical rows by default; it does not create or alter table infrastructure.

```bash
node src/cli.mjs preload --config=configs/x1-read-open-loop.json --target=aws --table=TABLE --output=results/preload/aws --rate=50 --max-inflight=64
node src/cli.mjs certify --config=configs/x1-read-open-loop.json --target=aws --table=TABLE --output=results/audit/aws --rate=25 --max-inflight=64
```

Run the same commands for `adb` and `ndcs`. Certification always forces strong/absolute reads, even when the benchmark profile is eventual. The audit emits `audit-operations.ndjson` and `dataset-certificate.json`. The three `expectedSha256` and `observedSha256` values must match before a synchronized benchmark is accepted.

Choose preload/audit rates below the table's effective capacity. Increasing concurrency does not override provisioned throughput and can create avoidable throttling.

## Fast prerequisite path

1. Create one dedicated table and one runner VM per target using the provider console or an independently managed infrastructure workflow.
2. Install Node.js 22 and clone this repository, or build a reusable runner image after dependency installation.
3. Apply the minimal runtime IAM policy; the benchmark repository does not need infrastructure-management permissions.
4. Run `validate`, then `preload`, then `certify`.
5. Schedule all three `run` commands with the same UTC `--start-at`.

A future `doctor` command will automate runtime, credential, connectivity, NTP, schema, capacity, and client-headroom checks without modifying infrastructure.
