# Quick start

## One-time prerequisites

1. Create three dedicated, empty benchmark tables outside this repository.
2. Provision the capacity declared by the selected workload profile and disable configurable autoscaling.
3. Place one adequately sized Docker host in `us-east-1` and the OCI hosts in `us-ashburn-1`; synchronize host clocks.
4. Grant data-plane access. For Phase 1, also grant capacity inspection/update access only to the dedicated benchmark table or compartment.
5. Select one immutable runner image digest and use it everywhere.

```bash
export IMAGE='ghcr.io/diegoecab/kvs-benchmark-runner@sha256:DIGEST'
docker pull "$IMAGE"
```

## Prepare the identical dataset

On each target host, run `doctor`, `preload`, and `certify`. Use the same workload configuration for all three. Copy the three `dataset-certificate.json` files to the results collector and confirm the hashes match.

## Phase 0: fixed capacity

Choose a UTC T0 at least 30 seconds in the future and use it on all three hosts:

```bash
export START_AT='2026-09-01T15:00:00Z'
IMAGE="$IMAGE" TABLE='TABLE' START_AT="$START_AT" RESULTS_DIR="$PWD/results/phase0/strong/r1/aws" scripts/container/run-aws.sh
```

Run the ADB and OCI scripts at the same time. Repeat with a new T0 for `r2`.

## Phase 1: T+3 scale-down and T+8 scale-up

Start from the exact high baseline declared in `configs/phase1-x1-strong-capacity.json`:

```bash
export START_AT='2026-09-01T16:00:00Z'
IMAGE="$IMAGE" TABLE='TABLE' START_AT="$START_AT" RESULTS_DIR="$PWD/results/phase1/strong/r1/aws" scripts/container/run-phase1-aws.sh
```

Run the equivalent ADB and OCI scripts with the same T0. The command performs a read-only baseline check before workload and writes `workload/` plus `capacity-events.json`. Repeat for `r2`.

For eventual consistency, use `x1-read-eventual-open-loop.json` together with `phase1-x1-eventual-capacity.json`. Never pool strong and eventual results.

## Generate the deliverable

Collect the accepted result directories, copy `configs/report-suite.example.json` to `results/suite.json`, update its paths and pricing evidence, then run:

```bash
node src/cli.mjs package --suite=results/suite.json --output=benchmark-package
```

Deliver the complete `benchmark-package` directory. Open `index.html` directly; its chart data is embedded and evidence links are relative.
