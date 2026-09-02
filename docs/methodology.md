# Methodology

## Primary comparison

The scored benchmark is deterministic and open-loop. It asks: **what happens when every product receives the same operations at the same intended UTC timestamps?** In `concurrent` mode, the scheduler does not wait for one request to complete before offering the next request. In `sequential` mode, each operation waits for the previous one and the resulting queue delay remains visible.

The read/write percentage is explicit and deterministic. Each target receives the same operation type, key and intended timestamp sequence over a canonical `pk`/`sk`/`version`/`payload` record, so correctness and capacity-unit boundaries remain explicit.

Item size is reported twice: configured payload bytes and the UTF-8 byte length of the largest provider-neutral canonical JSON record in the dataset. The latter includes logical attribute names and values but is not a claim about a provider's physical storage or billable item-size calculation.

## Distributed load generators

A run may select `N` load-generator VMs per target. The same `N` applies to every compared target and the VMs use the same declared client class. Open-loop operations are assigned by `globalSequence mod N`; the aggregate schedule, operation identities, and offered rate are unchanged. Closed-loop global worker IDs are partitioned by the same rule. All sources receive one shared T0.

Raw evidence and runner telemetry are preserved for every source. Target-level latency distributions are recalculated from the union of operation records instead of averaging percentiles. Aggregate live counts and throughput are sums; the displayed rolling P95 is the maximum source rolling P95 until final evidence is available.

Provider-reported VM/VNIC IP metadata identifies the selected source resource but does not prove the address observed by a service after NAT or proxying. Any experiment whose hypothesis depends on source IP must separately verify effective egress identity.

## Read consistency

Consistency is an explicit workload dimension, never an implicit provider default. Every run declares either `strong` or `eventual`, and results from different consistency modes are not pooled.

For the 900-byte canonical item, capacity-normalized eventual profiles reserve half the read units used by the corresponding strong profile while preserving the same effective point-read envelope. The harness verifies consumed units during calibration and records the selected mode in both `run-config.json` and `summary.json`.

## Concurrency

Threads, offered load, open requests, and network connections are different controls:

- Offered load is specified by the operations-per-second schedule.
- `executionMode` is either `concurrent` or `sequential`; sequential mode requires `maxInflight: 1`.
- `maxInflight` is a safety ceiling, never a claimed thread count.
- Actual in-flight requests are sampled every 100 ms and recorded at every operation start.
- Connection-pool limits are explicit provider settings.
- Scheduler drops are failures and cannot be omitted from completion rate.

A fixed-concurrency closed-loop run asks a separate question: **what throughput and latency does each target sustain with the same constant number of active workers?** Its results must not be pooled with the primary open-loop ranking.

The capacity-covered balanced phase asks another separate question: **how do the products compare when a 50/50 workload remains below each table's normalized provisioned read and write limits?** It uses no capacity transition and is designed not to require burst capacity.

## Latency boundaries

For each operation the harness records:

- queue delay: actual start minus intended start;
- service latency: immediately before SDK call through result/error;
- intended latency: completion minus intended start;
- attempt count and safe error metadata.

Successful and failed-operation latency distributions are reported separately. Retries are disabled in the raw service profile; a resilience profile may enable identical retry policies and must report logical and per-attempt latency separately.

## Required metrics

- scheduled, started, successful, rejected and scheduler-dropped operations;
- achieved throughput and completion rate;
- p50/p95/p99/p99.9/max successful latency;
- error count, status, request ID, affected seconds and longest continuous window;
- instantaneous/mean/p95/max in-flight operations;
- queue delay, event-loop delay, CPU, memory and network counters;
- consumed capacity and provider-side monitoring metrics;
- dataset certificate, configuration hash, commit SHA and evidence checksums.
- configured payload bytes, logical canonical item bytes, load-generator count, declared VM shape/vCPU/memory, source VM/network identities, verified egress identity when available, and shard mapping;
- scheduled and actual UTC start/end timestamps for every target in every repetition.

## Method ownership

The workload model, evidence schema, acceptance rules, and result calculations are maintained and versioned in this repository. A benchmark report must identify the exact repository commit used for execution.
