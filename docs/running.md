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
