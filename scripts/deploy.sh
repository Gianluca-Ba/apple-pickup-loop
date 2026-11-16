#!/usr/bin/env bash
# Author: GB
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

case "${1:-}" in
  '')
    [[ "$(uname -s)" == Darwin ]] || { printf 'Run the dashboard deployment on macOS.\n' >&2; exit 1; }
    command -v node >/dev/null && command -v npm >/dev/null || { printf 'Install Node.js 22 or newer.\n' >&2; exit 1; }
    node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
    /usr/bin/xcrun --find clang >/dev/null
    npm ci
    node app/build-native.mjs
    printf 'Dashboard ready. Run ./scripts/start.sh after configuring the Linux VM.\n'
    ;;
  --guest)
    instance="${2:-apple-pickup-linux}"
    [[ "$#" -le 2 && "$instance" =~ ^[a-z][a-z0-9-]{0,47}$ ]] || exit 2
    multipass exec "$instance" -- cloud-init status --wait
    [[ "$(multipass exec "$instance" -- cat /etc/apple-pickup-loop-vm)" == apple-pickup-loop-v1 ]] ||
      { printf 'This VM does not have the project bootstrap marker.\n' >&2; exit 1; }

    local_directory="$(mktemp -d)"
    guest_directory="$(multipass exec "$instance" -- mktemp -d)"
    [[ "$guest_directory" =~ ^/tmp/tmp\.[A-Za-z0-9]+$ ]] || exit 1
    cleanup() {
      rm -f -- "$local_directory/release.tar"
      rmdir -- "$local_directory"
      multipass exec "$instance" -- rm -f -- "$guest_directory/release.tar" >/dev/null 2>&1 || true
      multipass exec "$instance" -- rmdir -- "$guest_directory" >/dev/null 2>&1 || true
    }
    trap cleanup EXIT
    # Only the reviewed commit goes into the VM, never local configuration.
    git archive --format=tar HEAD app package.json package-lock.json scripts/bootstrap-linux.sh scripts/apple-pickup-worker.service scripts/apple-pickup-chromium.apparmor > "$local_directory/release.tar"
    multipass transfer "$local_directory/release.tar" "$instance:$guest_directory/release.tar"
    multipass exec "$instance" -- sudo -n /bin/bash -c '
      set -euo pipefail
      temporary="$(mktemp -d)"
      trap '\''rm -rf -- "$temporary"'\'' EXIT
      tar -xf "$1" -C "$temporary"
      /bin/bash "$temporary/scripts/bootstrap-linux.sh" "$temporary"
    ' bash "$guest_directory/release.tar"
    ;;
  *)
    printf 'Usage: %s [--guest [instance-name]]\n' "$0" >&2
    exit 2
    ;;
esac
