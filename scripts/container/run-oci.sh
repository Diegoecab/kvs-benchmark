#!/bin/sh
set -eu
: "${IMAGE:?Set IMAGE to an immutable ghcr.io image digest}"
: "${TABLE:?Set TABLE}"
: "${OCI_COMPARTMENT_ID:?Set OCI_COMPARTMENT_ID}"
: "${OCI_REGION:=us-ashburn-1}"
: "${CONFIG:=configs/x1-read-open-loop.json}"
: "${RESULTS_DIR:=$PWD/results/ndcs}"
: "${START_AT:?Set START_AT to a shared UTC timestamp}"
mkdir -p "$RESULTS_DIR"
exec docker run --rm --network host \
  -e OCI_USE_INSTANCE_PRINCIPAL=true \
  -e OCI_REGION \
  -e OCI_COMPARTMENT_ID \
  -v "$RESULTS_DIR:/app/results" \
  "$IMAGE" run --config="$CONFIG" --target=ndcs --table="$TABLE" --output=results/run --start-at="$START_AT"
