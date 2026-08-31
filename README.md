# KVS Benchmark

Reproducible, client-observed KV benchmarking for:

- AWS DynamoDB
- Oracle Autonomous AI Database DynamoDB API
- OCI NoSQL Database Cloud Service

The harness defines its own versioned methodology for deterministic open-loop scheduling, synchronized UTC starts, capacity-transition timelines, complete error metadata, client-concurrency telemetry, and evidence packaging.

## Status

`v0.1` provides validated workload specifications, deterministic operation generation, AWS/ADB and OCI NoSQL adapters, open-loop and fixed-concurrency closed-loop execution, synchronized Phase 1 capacity transitions, concurrency/client-health telemetry, HTML evidence packaging, and offline tests. Cloud provisioning remains outside this repository.

The optional local control dashboard is documented in [docs/local-control-dashboard.md](docs/local-control-dashboard.md). It discovers local AWS/OCI profile names, builds a validated run matrix, exports a reviewable run specification, and can execute a fixed two-second local mock smoke test with persisted evidence. Cloud execution and infrastructure management remain disabled.

The harness also loads and certifies the canonical dataset in pre-existing, dedicated benchmark tables. It does not provision cloud infrastructure or create tables.

## Quick start

For the complete cloud sequence, use the [one-page quick start](docs/quickstart.md).

```bash
npm ci
npm test
node src/cli.mjs validate --config=configs/x1-read-open-loop.json
node src/cli.mjs run --config=configs/smoke.json --target=mock --table=local --output=results/mock
npm run dashboard
```

Dataset workflow:

```bash
node src/cli.mjs preload --config=configs/x1-read-open-loop.json --target=mock --table=local --output=results/preload
node src/cli.mjs certify --config=configs/x1-read-open-loop.json --target=mock --table=local --output=results/audit
```

Cloud credentials are never accepted in configuration files. Use the standard SDK environment/profile mechanisms described in [docs/running.md](docs/running.md).

## Dashboard quick start

From the repository root:

```bash
npm ci
npm run dashboard
```

On Windows PowerShell, use `npm.cmd` if the local execution policy blocks `npm.ps1`:

```powershell
npm.cmd ci
npm.cmd run dashboard
```

Then open `http://127.0.0.1:4177` and follow the five-step wizard:

1. Select the detected AWS/OCI profile names and enter existing resource references.
2. Keep **Use existing infrastructure** selected; managed infrastructure is plan-only.
3. Select workload profiles and optional overrides. Model-specific overrides are applied only where compatible.
4. Select **Async** (default) or **Live**.
5. Review the immutable matrix and select **Run local functional test**.

The local functional test is safe and does not contact AWS or OCI. It runs a two-second in-memory workload through the real scheduler, metrics, report, and packaging path. When it reaches `COMPLETE`, select **Download benchmark output (.zip)**. The ZIP contains the standalone HTML report, operation and telemetry evidence, final summary, effective configuration, and SHA-256 manifest. Evidence is also written under `.kvs/runs/<run-id>/`.

Cloud execution from the dashboard is not connected yet. Cloud runs remain available through the documented CLI workflow in [docs/quickstart.md](docs/quickstart.md). Complete dashboard behavior and limitations are documented in [docs/local-control-dashboard.md](docs/local-control-dashboard.md).

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

## Portable runner

AWS and OCI runners use the same `linux/amd64` container image and immutable digest. See the [container contract](docs/container.md). The image includes the harness and runtime dependencies, but never credentials or cloud-specific resource identifiers.

```bash
docker run --rm ghcr.io/diegoecab/kvs-benchmark-runner:main doctor --config=configs/smoke.json --target=mock --skip-network=true
```

## Phase 1 and deliverable

The explicit `phase1` command runs the workload and T+3/T+8 capacity controller against an existing dedicated table. It validates the active baseline first, and the final event must restore it. See [Phase 1](docs/phase1.md).

After accepted sessions are collected, generate the portable English HTML report and checksummed evidence package:

```bash
node src/cli.mjs package --suite=results/suite.json --output=benchmark-package
```

See [reporting](docs/reporting.md) and `configs/report-suite.example.json`.

## Security

Do not commit cloud credentials, wallets, private keys, raw customer evidence, account identifiers, OCIDs, IP addresses, or Terraform state. See [SECURITY.md](SECURITY.md).
