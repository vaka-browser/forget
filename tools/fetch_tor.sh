#!/usr/bin/env bash
# Hämtar Tor Projects "expert bundle" (tor + pluggable transports + geoip) till tor-bundle/.
# Binärerna ligger inte i git. Verifierar mot torprojects sha256sums för versionen.
# Användning: tools/fetch_tor.sh [linux-x86_64|windows-x86_64|macos-x86_64|macos-aarch64] [version]
set -euo pipefail
PLAT="${1:-linux-x86_64}"
BASE="https://dist.torproject.org/torbrowser"
if [ -n "${2:-}" ]; then VER="$2"; else
  VER=$(curl -fsSL "$BASE/" | grep -oE 'href="[0-9]+\.[0-9]+(\.[0-9]+)?/"' | tr -d 'href="/' | sort -V | tail -1)
fi
FILE="tor-expert-bundle-$PLAT-$VER.tar.gz"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
echo "Hämtar $FILE …"
curl -fsSL -o "$TMP/$FILE" "$BASE/$VER/$FILE"
curl -fsSL -o "$TMP/sums" "$BASE/$VER/sha256sums-unsigned-build.txt"
WANT=$(grep " $FILE\$" "$TMP/sums" | awk '{print $1}')
GOT=$(sha256sum "$TMP/$FILE" | awk '{print $1}')
[ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || { echo "Checksumman stämmer inte – avbryter." >&2; exit 1; }
rm -rf "$DIR/tor-bundle"; mkdir -p "$DIR/tor-bundle"
tar -xzf "$TMP/$FILE" -C "$DIR/tor-bundle"
echo "Klart: $DIR/tor-bundle ($("$DIR/tor-bundle/tor/tor" --version 2>/dev/null | head -1 || echo "$VER"))"
