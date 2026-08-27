# KVS Benchmark

Reproducible, client-observed KV benchmarking for:

- AWS DynamoDB
- Oracle Autonomous AI Database DynamoDB API
- OCI NoSQL Database Cloud Service

The harness defines its own versioned methodology for deterministic open-loop scheduling, synchronized UTC starts, capacity-transition timelines, complete error metadata, client-concurrency telemetry, and evidence packaging.

## Status

`v0.1` provides the sanitized benchmark foundation: validated workload specifications, deterministic operation generation, AWS/ADB and OCI NoSQL adapters, open-loop execution, concurrency/client-health telemetry, and offline tests. Capacity controllers, cloud provisioning, HTML reporting, and a closed-loop runner are tracked in the roadmap.

The harness also loads and certifies the canonical dataset in pre-existing, dedicated benchmark tables. It does not provision cloud infrastructure or create tables.

## Quick start

```bash
npm ci
npm test
node src/cli.mjs validate --config=configs/x1-read-open-loop.json
node src/cli.mjs run --config=configs/smoke.json --target=mock --table=local --output=results/mock
```

Dataset workflow:

```bash
node src/cli.mjs preload --config=configs/x1-read-open-loop.json --target=mock --table=local --output=results/preload
node src/cli.mjs certify --config=configs/x1-read-open-loop.json --target=mock --table=local --output=results/audit
```

Cloud credentials are never accepted in configuration files. Use the standard SDK environment/profile mechanisms described in [docs/running.md](docs/running.md).

## Reproducibility contract

Every accepted comparison must use the same:

- workload configuration and commit SHA;
- logical dataset, seed, payload and key distribution;
- scheduled operation stream and UTC start;
- consistency, retries, timeout and connection policy;
- client VM class and telemetry requirements;
- acceptance rules and evidence schema.

See [methodology](docs/methodology.md), [fairness rules](docs/fairness.md), and [contributing](CONTRIBUTING.md).

Strong and eventual consistency are separate checked-in profiles. They use the same deterministic operation schedule but are reported independently.

## Security

Do not commit cloud credentials, wallets, private keys, raw customer evidence, account identifiers, OCIDs, IP addresses, or Terraform state. See [SECURITY.md](SECURITY.md).
