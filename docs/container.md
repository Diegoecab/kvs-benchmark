# Portable runner image

The canonical runner is published as:

```text
ghcr.io/diegoecab/kvs-benchmark-runner
```

Use an immutable digest in accepted benchmarks. Mutable `main` and commit-SHA tags are discovery aids, not evidence identifiers.

```bash
docker pull ghcr.io/diegoecab/kvs-benchmark-runner:main
docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/diegoecab/kvs-benchmark-runner:main
```

The same `linux/amd64` digest must run on AWS and OCI. Credentials are supplied at runtime through EC2 roles, OCI instance principals, or short-lived ADB API keys. They are never baked into an image layer.

## Host contract

- Linux amd64 VM with at least 4 logical CPUs and 16 GiB RAM.
- Docker Engine or compatible OCI runtime.
- Host clock synchronized and independently evidenced.
- Outbound TCP/443 to the selected service endpoint and metadata service access when instance identity is used.
- Writable host results directory.
- `--network host` to remove container bridge/NAT differences.

## Build integrity

The GitHub workflow publishes an SBOM and maximum-mode build provenance alongside the image. Record the image digest, repository commit, configuration SHA-256, host image/version, and runtime command in every accepted evidence package.

## Local verification

```bash
docker build -t kvs-benchmark:test .
docker run --rm kvs-benchmark:test doctor --config=configs/smoke.json --target=mock --skip-network=true
```

