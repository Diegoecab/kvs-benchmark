# Report and evidence package

Copy `configs/report-suite.example.json`, replace its paths and reviewed pricing metadata, then generate the complete deliverable:

```bash
node src/cli.mjs package --suite=results/suite.json --output=benchmark-package
```

The output contains a self-contained English `index.html`, a localized `suite.json`, copied raw evidence, `README.md`, and `manifest-sha256.json`. The HTML embeds chart data and uses relative links to the evidence, so the directory can be moved or zipped without breaking links.

The report includes an executive comparison, P50/P95/P99/P99.9/max, percent increase from the best P95, completion, read/write splits, client concurrency, queue/event-loop delay, scheduler drops, capacity transition timing, errors, and continuous throttle windows. Timeline controls can independently show or hide AWS DynamoDB, ADB DynamoDB API, OCI NoSQL, and offered load.

Generation fails when the three targets do not have the same logical operation schedule, raw operation counts do not match scheduled counts, or supplied dataset certificates are not accepted and identical.

The package contains raw evidence and may contain cloud identifiers. Review it before sharing outside the authorized audience.
