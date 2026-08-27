# Security

Report suspected credential exposure privately to the repository owner. Do not open a public issue containing secrets.

The harness reads authentication only through official SDK credential providers and environment variables. Configuration files must contain logical names and non-secret workload parameters only.

Before publishing evidence, redact tenancy/account IDs, compartment and resource OCIDs, endpoints containing resource IDs, public IPs, request IDs, usernames, and customer data. If a secret is ever committed, rotate it immediately; removing it in a later commit is insufficient.

