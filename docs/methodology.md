# Methodology

## Primary comparison

The scored benchmark is deterministic and open-loop. It asks: **what happens when every product receives the same operations at the same intended UTC timestamps?** The scheduler does not wait for one request to complete before offering the next request.

The primary workload is 100% point reads over a canonical `pk`/`sk`/`version`/`payload` record so that correctness and capacity-unit boundaries remain explicit.

## Concurrency

Threads, offered load, open requests, and network connections are different controls:

- Offered load is specified by the operations-per-second schedule.
- `maxInflight` is a safety ceiling, never a claimed thread count.
- Actual in-flight requests are sampled every 100 ms and recorded at every operation start.
- Connection-pool limits are explicit provider settings.
- Scheduler drops are failures and cannot be omitted from completion rate.

The optional closed-loop sweep asks a separate question: **how does throughput and latency change as active client concurrency increases?** Its results must not be pooled with the primary open-loop ranking.

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

## Method ownership

The workload model, evidence schema, acceptance rules, and result calculations are maintained and versioned in this repository. A benchmark report must identify the exact repository commit used for execution.
