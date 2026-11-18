#!/bin/bash
# Puts Rolling's studio (the server) and the programs it needs inside the Mac app's resources.
#   Rolling/Resources/Studio  server.js and friends, public/, node_modules (copied fresh on every build)
#   Rolling/Resources/Tools   node, ffmpeg, ffprobe, cloudflared (downloaded once; delete the folder to fetch again)
# Xcode runs this before each build. You can also run it by hand: mac/scripts/prepare.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"          # mac/
REPO="$(cd "$HERE/.." && pwd)"                    # the Rolling repo
RES="$HERE/Rolling/Resources"
TOOLS="$RES/Tools"
STUDIO="$RES/Studio"
NODE_MAJOR=22
FF="https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0"
CF="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz"

fetch() { curl -fsSL --retry 3 --retry-delay 5 "$1" -o "$2"; }

mkdir -p "$TOOLS"
if [ ! -x "$TOOLS/node" ]; then
  echo "Getting node $NODE_MAJOR…"
  NAME=$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" | grep -o "node-v[0-9.]*-darwin-arm64.tar.gz" | head -1)
  TMP=$(mktemp -d)
  fetch "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/$NAME" "$TMP/node.tgz"
  tar xzf "$TMP/node.tgz" -C "$TMP"
  cp "$TMP"/node-*/bin/node "$TOOLS/node"
  rm -rf "$TOOLS/npm" && cp -R "$TMP"/node-*/lib/node_modules/npm "$TOOLS/npm"
  rm -rf "$TMP"
fi
for t in ffmpeg ffprobe; do
  if [ ! -x "$TOOLS/$t" ]; then
    echo "Getting $t…"
    fetch "$FF/$t-darwin-arm64.gz" "$TOOLS/$t.gz" && gunzip -f "$TOOLS/$t.gz" && chmod +x "$TOOLS/$t"
  fi
done
if [ ! -x "$TOOLS/cloudflared" ]; then
  echo "Getting cloudflared…"
  fetch "$CF" "$TOOLS/cloudflared.tgz" && tar xzf "$TOOLS/cloudflared.tgz" -C "$TOOLS" && rm "$TOOLS/cloudflared.tgz" && chmod +x "$TOOLS/cloudflared"
fi
# downloaded programs are marked as "from the internet"; they're ours to run
xattr -dr com.apple.quarantine "$TOOLS" 2>/dev/null || true

# the studio: the same files a server runs
mkdir -p "$STUDIO"
rsync -a --delete --exclude node_modules \
  --include '/*.js' --include '/package.json' --include '/package-lock.json' --include '/public/***' --include '/LICENSE' \
  --exclude '*' "$REPO/" "$STUDIO/"
if [ ! -d "$STUDIO/node_modules" ] || [ "$REPO/package.json" -nt "$STUDIO/node_modules" ]; then
  echo "Installing the studio's building blocks…"
  (cd "$STUDIO" && PATH="$TOOLS:$PATH" "$TOOLS/node" "$TOOLS/npm/bin/npm-cli.js" install --omit=dev --no-audit --no-fund --loglevel=error)
  touch "$STUDIO/node_modules"
fi
echo "Studio and tools ready."
