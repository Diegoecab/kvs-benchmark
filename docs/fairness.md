# Fairness rules

1. Run clients in the target region; do not compare cross-region paths.
2. Use the same logical dataset, payload, consistency and deterministic operation stream.
3. Normalize provisioned capacity using the observed capacity-unit consumption of the canonical item.
4. Keep timeouts, retry count, keep-alive policy and connection limits equivalent and disclose unavoidable SDK differences.
5. Use the same client-VM class and prove it is not saturated with CPU, memory, network, event-loop and scheduler-drop evidence.
6. Start all three target runs on the same UTC boundary with verified clock synchronization.
7. Separate accepted runs from diagnostics; never silently replace or remove errors.
8. Report successful latency together with completion, throttling and failed-operation latency.
9. Do not pool open-loop and closed-loop results.
10. Price only the explicitly declared benchmark window and disclose provisioning, preload, idle and teardown costs separately.

