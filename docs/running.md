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

The cloud-aware `doctor` checks runtime, visible CPU/RAM, required environment, endpoint DNS/TCP connectivity, image identity, host clock evidence, and existing table state/schema/capacity. It does not create or update infrastructure. Run it before preload:

```bash
IMAGE='ghcr.io/diegoecab/kvs-benchmark-runner@sha256:DIGEST' TABLE='TABLE' scripts/container/doctor-aws.sh
```

See [container.md](container.md) and the scripts under `scripts/container/` for equivalent AWS, ADB API, and OCI NoSQL commands.

## Coordinated triplet and monitoring evidence

`coordinate` launches exactly one AWS, ADB API, and OCI NoSQL runner with a shared UTC T0. The plan contains executable plus argument arrays, avoiding shell interpolation. It records command fingerprints and collection status.

```bash
node src/cli.mjs coordinate --plan=results/session-plan.json --output=results/coordinator
```

After the session, `metrics` captures provider-side monitoring for the exact window. Run it from an operator checkout with the AWS/OCI CLIs installed; cloud CLIs are intentionally not included in the runner image.

```bash
node src/cli.mjs metrics --target=aws --start-at=START --end-at=END --table=TABLE --region=us-east-1 --output=results/aws/monitoring
node src/cli.mjs metrics --target=ndcs --start-at=START --end-at=END --resource-id=TABLE_OCID --compartment=COMPARTMENT_OCID --profile=PROFILE --output=results/ndcs/monitoring
node src/cli.mjs metrics --target=adb --start-at=START --end-at=END --resource-id=ADB_OCID --compartment=COMPARTMENT_OCID --profile=PROFILE --output=results/adb/monitoring
```

## Phase 1

Use `run-phase1-aws.sh`, `run-phase1-adb.sh`, and `run-phase1-oci.sh` with one shared `START_AT`. The command performs an exact-capacity read-only preflight and then runs workload plus capacity transitions together. See [phase1.md](phase1.md).

## Final deliverable

Describe accepted sessions using `configs/report-suite.example.json`, then run:

```bash
node src/cli.mjs package --suite=results/suite.json --output=benchmark-package
```

See [reporting.md](reporting.md) for package contents and acceptance checks.
