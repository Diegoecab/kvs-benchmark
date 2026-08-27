#!/bin/sh
set -eu
: "${IMAGE:?Set IMAGE to an immutable ghcr.io image digest}"
: "${TABLE:?Set TABLE}"
: "${AWS_REGION:=us-east-1}"
: "${CONFIG:=configs/x1-read-open-loop.json}"
: "${RESULTS_DIR:=$PWD/results/aws}"
: "${START_AT:?Set START_AT to a shared UTC timestamp}"
mkdir -p "$RESULTS_DIR"
exec docker run --rm --network host \
  -e AWS_REGION \
  -v "$RESULTS_DIR:/app/results" \
  "$IMAGE" run --config="$CONFIG" --target=aws --table="$TABLE" --output=results/run --start-at="$START_AT"
