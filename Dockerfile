# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-bookworm-slim AS runner
ARG VERSION=dev
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="KVS Benchmark Runner" \
      org.opencontainers.image.description="Portable AWS DynamoDB, ADB DynamoDB API, and OCI NoSQL benchmark runner" \
      org.opencontainers.image.source="https://github.com/Diegoecab/kvs-benchmark" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$VCS_REF" \
      org.opencontainers.image.created="$BUILD_DATE"
ENV NODE_ENV=production \
    KVS_IMAGE_VERSION=$VERSION \
    KVS_IMAGE_REVISION=$VCS_REF
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY configs ./configs
COPY docs ./docs
COPY docker/entrypoint.sh /usr/local/bin/kvs-benchmark
RUN mkdir -p /app/results && chown -R node:node /app /usr/local/bin/kvs-benchmark && chmod 0555 /usr/local/bin/kvs-benchmark
USER node
VOLUME ["/app/results"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/kvs-benchmark"]
CMD ["doctor", "--config=configs/smoke.json", "--target=mock", "--skip-network=true"]

