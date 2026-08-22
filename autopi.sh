#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE=desktop
ARGS=()

for arg in "$@"; do
	if [[ "$arg" == "--cli" ]]; then
		MODE=cli
	else
		ARGS+=("$arg")
	fi
done

if [[ "$MODE" == "cli" ]]; then
	"$SCRIPT_DIR/pi-test.sh" "${ARGS[@]+"${ARGS[@]}"}"
else
	"$SCRIPT_DIR/pi-desktop.sh" "${ARGS[@]+"${ARGS[@]}"}"
fi
