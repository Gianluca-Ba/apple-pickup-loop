#!/usr/bin/env bash
# Author: GB
set -euo pipefail

instance="${1:-apple-pickup-linux}"
if [[ ! "$instance" =~ ^[a-z][a-z0-9-]{0,47}$ || "$#" -gt 1 ]]; then
  printf 'Usage: %s [instance-name]\n' "$0" >&2
  exit 2
fi
command -v multipass >/dev/null || { printf 'Install Multipass first.\n' >&2; exit 1; }
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if multipass info "$instance" >/dev/null 2>&1; then
  printf 'Instance already exists. Use scripts/deploy.sh --guest %s to update a project VM.\n' "$instance" >&2
  exit 1
fi

multipass launch 24.04 --name "$instance" \
  --cpus "${APPLE_LOOP_VM_CPUS:-2}" \
  --memory "${APPLE_LOOP_VM_MEMORY:-4G}" \
  --disk "${APPLE_LOOP_VM_DISK:-24G}" \
  --cloud-init "$script_directory/cloud-init.yaml"

"$script_directory/deploy.sh" --guest "$instance"
