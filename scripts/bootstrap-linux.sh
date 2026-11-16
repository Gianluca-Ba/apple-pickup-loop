#!/usr/bin/env bash
# Author: GB
set -euo pipefail
umask 022

source_directory="${1:?release directory required}"
[[ "$(id -u)" == 0 && "$(cat /etc/apple-pickup-loop-vm)" == apple-pickup-loop-v1 ]]
case "$(uname -m)" in
  aarch64) architecture=arm64 ;;
  x86_64) architecture=x64 ;;
  *) printf 'Unsupported Linux architecture.\n' >&2; exit 1 ;;
esac

# Use the maintained Node 22 line and verify the archive against Node's manifest.
node_directory=/opt/node22
if [[ ! -x "$node_directory/bin/node" ]]; then
  version="$(curl --fail --silent --show-error https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt |
    sed -nE "s/^[a-f0-9]{64}  node-(v22\.[0-9]+\.[0-9]+)-linux-${architecture}\.tar\.xz$/\1/p")"
  [[ "$version" =~ ^v22\.[0-9]+\.[0-9]+$ ]]
  archive="node-$version-linux-$architecture.tar.xz"
  download="$(mktemp -d)"
  trap 'rm -rf -- "$download"' EXIT
  curl --fail --silent --show-error "https://nodejs.org/dist/$version/$archive" -o "$download/$archive"
  curl --fail --silent --show-error "https://nodejs.org/dist/$version/SHASUMS256.txt" -o "$download/SHASUMS256.txt"
  (cd "$download"; awk -v archive="$archive" '$2 == archive {print}' SHASUMS256.txt | sha256sum --check --strict -)
  tar -xJf "$download/$archive" -C "$download"
  mv -- "$download/node-$version-linux-$architecture" "$node_directory"
fi
ln -sfn "$node_directory/bin/node" /usr/local/bin/node
export PATH="$node_directory/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH=/opt/iphone-stock-browsers

if ! id monitor >/dev/null 2>&1; then
  useradd --create-home --shell /usr/sbin/nologin monitor
fi
install -d -m 0755 /opt/iphone-stock-pool /etc/iphone-stock
fleet_configuration=/opt/iphone-stock-pool/fleet-vpn.json
if [[ ! -e "$fleet_configuration" ]]; then
  printf '%s\n' '{"workerCount":1,"tunnelLimit":1,"nordLimit":1,"nativeProvider":"nordvpn"}' > "$fleet_configuration"
fi
worker_ledger=/home/monitor/.iphone-stock-ledger.json
if [[ ! -e "$worker_ledger" ]]; then
  runuser -u monitor -- /bin/sh -c 'umask 077; printf "{}\n" > "$1"' sh "$worker_ledger"
fi

# Build dependencies in a new release directory before changing the service.
releases=/opt/iphone-stock-releases
install -d -m 0755 "$releases"
release="$(mktemp -d "$releases/release.XXXXXXXX")"
chmod 0755 "$release"
cp -R "$source_directory/app" "$source_directory/package.json" "$source_directory/package-lock.json" "$release/"
(cd "$release"; npm ci --omit=dev; ./node_modules/.bin/playwright install --with-deps chromium)
chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"
if [[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || true)" == 1 ]]; then
  install -m 0644 "$source_directory/scripts/apple-pickup-chromium.apparmor" /etc/apparmor.d/apple-pickup-chromium
  apparmor_parser -r /etc/apparmor.d/apple-pickup-chromium
fi
# Check that Chromium can use its sandbox under the service account.
(cd "$release"
  runuser -u monitor -- env PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" \
    "$node_directory/bin/node" --input-type=module -e '
      import { chromium } from "playwright";
      const browser = await chromium.launch({channel:"chromium", chromiumSandbox:true});
      try { const page = await browser.newPage(); await page.goto("about:blank"); }
      finally { await browser.close(); }
    '
)
install -m 0644 "$release/app/linux-vpn-control.py" /opt/iphone-stock-pool/linux-vpn-control.py
install -m 0644 "$source_directory/scripts/apple-pickup-worker.service" /etc/systemd/system/apple-pickup-worker.service
if [[ -e /opt/iphone-stock && ! -L /opt/iphone-stock ]]; then
  printf '/opt/iphone-stock already exists as a real directory.\n' >&2
  exit 1
fi
link_directory="$(mktemp -d /opt/.apple-pickup-link.XXXXXXXX)"
ln -s "$release" "$link_directory/worker"
mv -Tf "$link_directory/worker" /opt/iphone-stock
rmdir "$link_directory"
systemctl daemon-reload
systemctl enable apple-pickup-worker.service
systemctl restart apple-pickup-worker.service
printf 'Linux worker installed. Configure and authenticate the VPN in the guest.\n'
