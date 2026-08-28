#!/bin/sh
set -eu
: "${IMAGE:?Set IMAGE to an immutable ghcr.io image digest}"
: "${TABLE:?Set TABLE}"
: "${OCI_COMPARTMENT_ID:?Set OCI_COMPARTMENT_ID}"
: "${OCI_REGION:=us-ashburn-1}"
: "${RESULTS_DIR:=$PWD/results/doctor/ndcs}"
: "${CONTAINER_RUNTIME:=docker}"
case "${CONTAINER_RUNTIME##*/}:$(id -u)" in podman:0) set -- ;; podman:*) set -- --userns=keep-id ;; *) set -- ;; esac
mkdir -p "$RESULTS_DIR"
chronyc tracking > "$RESULTS_DIR/chronyc-tracking.txt"
exec "$CONTAINER_RUNTIME" run "$@" --rm --network host \
  -e OCI_USE_INSTANCE_PRINCIPAL=true \
  -e OCI_REGION -e OCI_COMPARTMENT_ID \
  -v "$RESULTS_DIR:/app/results:Z" \
  "$IMAGE" doctor --config=configs/x1-read-open-loop.json --target=ndcs \
  --table="$TABLE" --clock-evidence=results/chronyc-tracking.txt \
  --output=results/doctor.json
