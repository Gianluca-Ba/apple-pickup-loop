#!/usr/bin/env bash
# Author: GB
set -euo pipefail

instance="${1:-apple-pickup-linux}"
[[ "$#" -le 1 && "$instance" =~ ^[a-z][a-z0-9-]{0,47}$ ]] || exit 2
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
[[ "$(uname -s)" == Darwin ]] || { printf 'Safari checkout requires macOS.\n' >&2; exit 1; }
[[ -x app/native/safari && -d node_modules/playwright ]] || { printf 'Run ./scripts/deploy.sh first.\n' >&2; exit 1; }
if /usr/sbin/lsof -nP -iTCP:4318 -sTCP:LISTEN >/dev/null 2>&1; then
  printf 'Port 4318 is already in use. Stop the existing dashboard first.\n' >&2
  exit 1
fi
# A failed VM check cannot start a second dashboard or implicit host fallback.
multipass exec "$instance" -- systemctl is-active --quiet apple-pickup-worker.service
export APPLE_LOOP_VM="$instance"
exec node app/server.mjs
