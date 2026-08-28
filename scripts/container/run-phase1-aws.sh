#!/bin/sh
set -eu
: "${IMAGE:?Set IMAGE to an immutable ghcr.io image digest}"
: "${TABLE:?Set TABLE}"
: "${START_AT:?Set START_AT to a shared UTC timestamp}"
: "${AWS_REGION:=us-east-1}"
: "${CONFIG:=configs/x1-read-open-loop.json}"
: "${CAPACITY_PLAN:=configs/phase1-x1-strong-capacity.json}"
: "${RESULTS_DIR:=$PWD/results/phase1/aws}"
: "${CONTAINER_RUNTIME:=docker}"
case "${CONTAINER_RUNTIME##*/}:$(id -u)" in podman:0) set -- ;; podman:*) set -- --userns=keep-id ;; *) set -- ;; esac
mkdir -p "$RESULTS_DIR"
exec "$CONTAINER_RUNTIME" run "$@" --rm --network host -e AWS_REGION -v "$RESULTS_DIR:/app/results:Z" "$IMAGE" phase1 --config="$CONFIG" --plan="$CAPACITY_PLAN" --target=aws --table="$TABLE" --output=results/run --start-at="$START_AT"
