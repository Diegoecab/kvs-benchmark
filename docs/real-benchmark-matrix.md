# Five-minute real benchmark matrix

Every session runs for 300 seconds. All three targets start on the same UTC boundary, use the same 10,000-key uniform dataset, 900-byte payload, deterministic operation selection, one SDK attempt, and strong consistency. Mixed writes are idempotent same-size overwrites.

| Phase | Session | Workload | Load model | Capacity transition |
|---|---|---|---|---|
| 0 | R1 | 100% read | Open loop, 100/200/400/600/300 ops/s | None |
| 0 | R2 | 100% read | Open loop, 100/200/400/600/300 ops/s | None |
| 0 | W1 | 70% read / 30% write | Open loop, 100/200/400/600/300 ops/s | None |
| 1 | R1 | 100% read | Open loop, 100/200/400/600/300 ops/s | Down at T+60 s; up at T+160 s |
| 1 | R2 | 100% read | Open loop, 100/200/400/600/300 ops/s | Down at T+60 s; up at T+160 s |
| 2 | R3 | 100% read | Closed loop, fixed concurrency 8 | None |
| 3 | W2 | 50% read / 50% write | Open loop, 100/200/400/600/300 ops/s | None |

All profile values are explicit JSON parameters. Controlled command-line/environment overrides are included in a new effective configuration hash.

## Phase 3 capacity coverage

Phase 3 isolates steady, provisioned service behavior from elasticity. At the 600 ops/s peak, deterministic 50/50 selection produces 300 reads/s and 300 writes/s.

For the canonical item below 1 KB:

| Target | Provisioned | Peak required | Utilization | Nominal headroom |
|---|---:|---:|---:|---:|
| AWS DynamoDB | 400 RCU / 400 WCU | 300 RCU / 300 WCU | 75% / 75% | 25% / 25% |
| ADB DynamoDB API | 400 RCU / 400 WCU | 300 RCU / 300 WCU | 75% / 75% | 25% / 25% |
| OCI NoSQL | 800 RU / 800 WU | 600 RU / 600 WU | 75% / 75% | 25% / 25% |

OCI NoSQL absolute reads consume twice the RU of eventual reads. W2 overwrites existing rows; its conservative capacity model counts the original and replacement sub-1 KB records, or 2 WU per logical overwrite. A preflight calibration records the actual `consumedCapacity` returned by the SDK before Phase 3 is accepted. If this exact path consumes less, the difference is disclosed as additional headroom rather than used to increase offered load.

Phase 3 is reported independently from Phases 0, 1, and 2. It does not prove that a provider has no internal elasticity; it demonstrates that the declared offered load fits inside the documented provisioned envelope without relying on burst to complete it.

References:

- [Oracle NoSQL Cloud: estimating capacity](https://docs.oracle.com/en/cloud/paas/nosql-cloud/dtddt/plan-your-service.html)
- [AWS DynamoDB read/write capacity units](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/read-write-operations.html)
- [ADB DynamoDB API ECPU mapping](https://docs.oracle.com/en/cloud/paas/autonomous-database/serverless/adbsb/autonomous-features-billing.html)
