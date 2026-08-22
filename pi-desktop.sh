#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_APP="$SCRIPT_DIR/apps/desktop"
ELECTRON_BIN="$SCRIPT_DIR/node_modules/.bin/electron"
MAIN_FILE="$DESKTOP_APP/dist/electron/main.js"
VITE_BIN="$SCRIPT_DIR/node_modules/vite/bin/vite.js"

desktop_build_required() {
	[[ ! -f "$MAIN_FILE" ]] && return 0
	find "$DESKTOP_APP/electron" "$DESKTOP_APP/renderer" "$DESKTOP_APP/shared" \
		"$DESKTOP_APP/package.json" "$DESKTOP_APP/tsconfig.json" -type f -newer "$MAIN_FILE" -print -quit | grep -q .
}

FORCE_BUILD=false
DEV_MODE=false
FORWARD_ARGS=()
for arg in "$@"; do
	if [[ "$arg" == "--build" ]]; then
		FORCE_BUILD=true
	elif [[ "$arg" == "--dev" ]]; then
		DEV_MODE=true
	else
		FORWARD_ARGS+=("$arg")
	fi
done

if [[ ! -f "$ELECTRON_BIN" ]]; then
	echo "Electron not found at $ELECTRON_BIN. Run 'npm install --ignore-scripts' from the repo root first." >&2
	exit 1
fi

if [[ "$DEV_MODE" == "true" ]]; then
	if [[ ! -f "$VITE_BIN" ]]; then
		echo "Vite not found at $VITE_BIN. Run 'npm install --ignore-scripts' from the repo root first." >&2
		exit 1
	fi
	if [[ "$FORCE_BUILD" == "true" ]] || desktop_build_required; then
		echo "Building AutoPi Desktop runtime..."
		npm --prefix "$DESKTOP_APP" run build
	fi
	echo "Starting Vite dev server..."
	( cd "$DESKTOP_APP" && node "$VITE_BIN" --config renderer/vite.config.ts ) &
	VITE_PID=$!
	cleanup() { kill "$VITE_PID" 2>/dev/null || true; }
	trap cleanup EXIT
	READY=false
	for i in $(seq 1 40); do
		sleep 0.5
		if curl -sf "http://localhost:5173" >/dev/null 2>&1; then
			READY=true
			break
		fi
	done
	if [[ "$READY" != "true" ]]; then
		echo "Vite dev server did not start at http://localhost:5173" >&2
		exit 1
	fi
	echo "Launching AutoPi (dev mode)..."
	"$ELECTRON_BIN" "$DESKTOP_APP" --dev "${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"}"
else
	if [[ "$FORCE_BUILD" == "true" ]] || desktop_build_required; then
		echo "Building AutoPi Desktop..."
		npm --prefix "$DESKTOP_APP" run build
	fi
	"$ELECTRON_BIN" "$DESKTOP_APP" "${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"}"
fi
