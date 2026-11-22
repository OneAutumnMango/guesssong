#!/usr/bin/env bash
# Local dev mode: test players enabled, loopback URL only.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
if [ -f ./.env ]; then source ./.env; fi
set +a
export PUBLIC_URL="http://127.0.0.1:${PORT:-3000}"
export DEV_MODE=1
exec node src/server.js
