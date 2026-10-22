#!/usr/bin/env bash
set -u
cd "$(dirname "$0")" || exit 1

if ! command -v uv >/dev/null 2>&1; then
    echo "需要 uv：https://docs.astral.sh/uv/" >&2
    exit 1
fi

exec uv run python run.py
