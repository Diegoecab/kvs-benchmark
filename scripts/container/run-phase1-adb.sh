#!/bin/sh
set -eu
: "${IMAGE:?Set IMAGE to an immutable ghcr.io image digest}"
: "${TABLE:?Set TABLE}"
: "${DDB_ENDPOINT:?Set DDB_ENDPOINT}"
: "${AWS_ACCESS_KEY_ID:?Set a short-lived access key}"
: "${AWS_SECRET_ACCESS_KEY:?Set a short-lived secret key}"
: "${START_AT:?Set START_AT to a shared UTC timestamp}"
: "${CONFIG:=configs/x1-read-open-loop.json}"
: "${CAPACITY_PLAN:=configs/phase1-x1-strong-capacity.json}"
: "${RESULTS_DIR:=$PWD/results/phase1/adb}"
: "${CONTAINER_RUNTIME:=docker}"
case "${CONTAINER_RUNTIME##*/}" in podman) set -- --userns=keep-id ;; *) set -- ;; esac
mkdir -p "$RESULTS_DIR"
exec "$CONTAINER_RUNTIME" run "$@" --rm --network host -e AWS_REGION=us-ashburn-1 -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e DDB_ENDPOINT -v "$RESULTS_DIR:/app/results:Z" "$IMAGE" phase1 --config="$CONFIG" --plan="$CAPACITY_PLAN" --target=adb --table="$TABLE" --output=results/run --start-at="$START_AT"
