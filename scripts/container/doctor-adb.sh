#!/bin/sh
set -eu
: "${IMAGE:?Set IMAGE to an immutable ghcr.io image digest}"
: "${TABLE:?Set TABLE}"
: "${DDB_ENDPOINT:?Set DDB_ENDPOINT}"
: "${AWS_ACCESS_KEY_ID:?Set a short-lived access key}"
: "${AWS_SECRET_ACCESS_KEY:?Set a short-lived secret key}"
: "${RESULTS_DIR:=$PWD/results/doctor/adb}"
: "${CONTAINER_RUNTIME:=docker}"
mkdir -p "$RESULTS_DIR"
chronyc tracking > "$RESULTS_DIR/chronyc-tracking.txt"
exec "$CONTAINER_RUNTIME" run --rm --network host \
  -e AWS_REGION=us-ashburn-1 \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e DDB_ENDPOINT \
  -v "$RESULTS_DIR:/app/results:Z" \
  "$IMAGE" doctor --config=configs/x1-read-open-loop.json --target=adb \
  --table="$TABLE" --clock-evidence=results/chronyc-tracking.txt \
  --output=results/doctor.json
