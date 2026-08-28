#!/bin/sh
set -eu
: "${IMAGE:?Set IMAGE to an immutable ghcr.io image digest}"
: "${TABLE:?Set TABLE}"
: "${AWS_REGION:=us-east-1}"
: "${RESULTS_DIR:=$PWD/results/doctor/aws}"
: "${CONTAINER_RUNTIME:=docker}"
case "${CONTAINER_RUNTIME##*/}" in podman) set -- --userns=keep-id ;; *) set -- ;; esac
mkdir -p "$RESULTS_DIR"
chronyc tracking > "$RESULTS_DIR/chronyc-tracking.txt"
exec "$CONTAINER_RUNTIME" run "$@" --rm --network host \
  -e AWS_REGION \
  -v "$RESULTS_DIR:/app/results:Z" \
  "$IMAGE" doctor --config=configs/x1-read-open-loop.json --target=aws \
  --table="$TABLE" --clock-evidence=results/chronyc-tracking.txt \
  --output=results/doctor.json
