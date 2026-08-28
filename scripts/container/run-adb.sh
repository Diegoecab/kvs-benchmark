#!/bin/sh
set -eu
: "${IMAGE:?Set IMAGE to an immutable ghcr.io image digest}"
: "${TABLE:?Set TABLE}"
: "${DDB_ENDPOINT:?Set DDB_ENDPOINT}"
: "${AWS_ACCESS_KEY_ID:?Set a short-lived access key}"
: "${AWS_SECRET_ACCESS_KEY:?Set a short-lived secret key}"
: "${CONFIG:=configs/x1-read-open-loop.json}"
: "${RESULTS_DIR:=$PWD/results/adb}"
: "${START_AT:?Set START_AT to a shared UTC timestamp}"
: "${CONTAINER_RUNTIME:=docker}"
case "${CONTAINER_RUNTIME##*/}:$(id -u)" in podman:0) set -- ;; podman:*) set -- --userns=keep-id ;; *) set -- ;; esac
mkdir -p "$RESULTS_DIR"
exec "$CONTAINER_RUNTIME" run "$@" --rm --network host \
  -e AWS_REGION=us-ashburn-1 \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e DDB_ENDPOINT \
  -v "$RESULTS_DIR:/app/results:Z" \
  "$IMAGE" run --config="$CONFIG" --target=adb --table="$TABLE" --output=results/run --start-at="$START_AT"
