# Contributing

1. Create a focused branch from `main`.
2. Keep workload logic provider-neutral; provider adapters may only translate canonical operations.
3. Add or update offline tests for every behavioral change.
4. Run `npm run check` before opening a pull request.
5. Document any result-affecting change in the pull request and increment the evidence schema when necessary.
6. Never commit credentials or non-redacted benchmark evidence.

Changes to scheduling, latency boundaries, retries, correctness checks, capacity normalization, or acceptance rules require review from a methodology owner.

