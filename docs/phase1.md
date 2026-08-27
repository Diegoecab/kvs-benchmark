# Phase 1 capacity transitions

Phase 1 is an explicit mutating command. It never creates or deletes infrastructure, but it changes the provisioned capacity of the named existing benchmark table at T+180 seconds and T+480 seconds.

Before starting workload, the command performs a read-only preflight and refuses to run unless the table is `ACTIVE` at the exact declared baseline. Every checked-in plan requires the final event to restore that baseline.

```bash
node src/cli.mjs phase1 \
  --config=configs/x1-read-open-loop.json \
  --plan=configs/phase1-x1-strong-capacity.json \
  --target=aws \
  --table=TABLE \
  --output=results/phase1/strong/r1/aws \
  --start-at=2026-09-01T15:00:00Z
```

The workload and capacity controller share the same UTC T0. `capacity-events.json` records scheduled/requested/applied timestamps, request skew, transition duration, requested and observed capacity, status, and safe error evidence. A controller result is accepted only when both events are applied, observed values match, and request skew is within 250 ms. If the final scale-up fails, the controller records and attempts an emergency baseline recovery; the run remains rejected even when recovery succeeds.

Required permissions are read/write data-plane access plus `DescribeTable`/`UpdateTable` for AWS and ADB API, or table inspection/update permissions for OCI NoSQL. Restrict them to the dedicated benchmark table or compartment.

Use `capacity --dry-run=true` to authenticate and verify the baseline without changing capacity.
