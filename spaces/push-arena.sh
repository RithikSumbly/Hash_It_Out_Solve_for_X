#!/usr/bin/env bash
# Upload the arena service to its Hugging Face Space (needs `hf auth login` once). Secrets are never uploaded:
# only the files the container needs are copied into a clean folder first.
set -euo pipefail
SPACE="${1:-CelestialLord/red-queen-arena}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cd "$ROOT"
mkdir -p "$STAGE/contracts" "$STAGE/web"
cp package.json package-lock.json "$STAGE/"
cp contracts/package.json "$STAGE/contracts/"
cp web/package.json "$STAGE/web/"
rsync -a --exclude node_modules --exclude .state --exclude '*.log' sdk relay bots deployments "$STAGE/"
cp spaces/arena/Dockerfile spaces/arena/README.md spaces/arena/gateway.mjs "$STAGE/"
if grep -rlE "(PRIVATE_KEY|MNEMONIC)[\"'\s]*[=:][\"'\s]*(0x[0-9a-fA-F]{64}|([a-z]+ ){11,}[a-z]+)" "$STAGE" >/dev/null 2>&1; then echo "refusing: a secret is in the upload" >&2; exit 1; fi
hf repo create "$SPACE" --repo-type space --space-sdk docker --exist-ok >/dev/null 2>&1 || hf repo create "$SPACE" --repo-type space --space_sdk docker --exist-ok
hf upload "$SPACE" "$STAGE" . --repo-type space --commit-message "Arena service: relay, demo, top-up, bots"
echo "https://huggingface.co/spaces/$SPACE"
