#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1

pids=()

cleanup() {
    trap - EXIT
    for pid in "${pids[@]}"; do
        kill "$pid" 2>/dev/null
    done
    wait 2>/dev/null
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

uv run python "plant.py" &
pids+=("$!")

uv run python "controller.py" &
pids+=("$!")

uv run python "sensor.py" &
pids+=("$!")

wait
