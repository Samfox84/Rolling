#!/usr/bin/env bash
# =============================================================================
#  Podcast Studio — installer for Ubuntu / Debian (x86-64 or ARM, e.g. Pi 5)
#
#  Run from inside this folder:
#     sudo bash install.sh
#
#  Optional settings (put them before "bash"):
#     sudo DOMAIN=podcast.example.com PORT=8790 STUDIO_NAME="My Studio" bash install.sh
#
#  Safe to run again: it updates the app but keeps your password, settings
#  and recordings.
# =============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/podcast-studio}"
PORT="${PORT:-8790}"
DOMAIN="${DOMAIN:-}"
STUDIO_NAME="${STUDIO_NAME:-Rolling}"
RUN_USER="${RUN_USER:-${SUDO_USER:-$(id -un)}}"
SERVICE=podcast-studio
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mXX  %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = 0 ] || die "Please run with sudo:  sudo bash install.sh"
id "$RUN_USER" >/dev/null 2>&1 || die "User $RUN_USER does not exist (set RUN_USER=...)"
command -v apt-get >/dev/null || die "This installer needs Ubuntu or Debian (apt-get)."

# ---------- 1. system packages ----------
say "Installing system packages (ffmpeg, curl, rsync)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ffmpeg curl ca-certificates rsync >/dev/null
apt-get install -y -qq rclone >/dev/null 2>&1 || warn "rclone isn't available here — cloud backup will be off (everything else works)"

# ---------- 2. Node.js 18+ ----------
NODE_MAJOR=0
command -v node >/dev/null && NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  say "Installing Node.js 22 (found: ${NODE_MAJOR})"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "Node $(node -v), $(ffmpeg -version | head -1 | cut -d' ' -f1-3)"

# ---------- 3. pick a free port (skips anything already in use) ----------
if [ -f "$APP_DIR/.env" ]; then PORT="$(grep -E '^PORT=' "$APP_DIR/.env" | cut -d= -f2 || echo "$PORT")"
else
  while ss -ltnH "sport = :$PORT" 2>/dev/null | grep -q .; do echo "Port $PORT is busy, trying $((PORT+1))"; PORT=$((PORT+1)); done
fi
echo "Using port $PORT"

# ---------- 4. copy the app ----------
say "Copying app to $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete --exclude node_modules --exclude recordings --exclude '.env*' --exclude '*.tar.gz' --exclude tests --exclude docs --exclude .git --exclude .github --exclude desk "$SRC/" "$APP_DIR/"

# ---------- 5. settings (.env) — created once, then kept ----------
if [ ! -f "$APP_DIR/.env" ]; then
  say "Creating settings file"
  ADMIN_PASSWORD="$(tr -dc 'a-zA-Z0-9' </dev/urandom | head -c 14 || true)"
  cat > "$APP_DIR/.env" <<EOF
# Podcast Studio settings — restart after editing:  sudo systemctl restart $SERVICE
STUDIO_NAME=$STUDIO_NAME
PORT=$PORT
# 127.0.0.1 = only reachable through the Cloudflare Tunnel / reverse proxy on this machine
BIND=127.0.0.1
ADMIN_PASSWORD=$ADMIN_PASSWORD
SECRET=$(tr -dc 'a-f0-9' </dev/urandom | head -c 64 || true)
DATA_DIR=$APP_DIR/recordings
MAX_PEOPLE=5
ROOM_TONE_SECONDS=20
# x264 speed for the MP4 copies (ultrafast..slow). veryfast suits older machines.
VIDEO_PRESET=veryfast
# Optional TURN relay for guests on very strict networks (see README):
# TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
# TURN_SECRET=
EOF
else
  say "Keeping existing settings ($APP_DIR/.env)"
fi
# backup drive: if a USB drive is mounted at /mnt/usb-drive, back up there by default (changeable in Studio settings)
if [ -z "${BACKUP_DIR:-}" ] && mountpoint -q /mnt/usb-drive 2>/dev/null; then BACKUP_DIR="/mnt/usb-drive/Podcast Studio Backups"; fi
if [ -n "${BACKUP_DIR:-}" ] && ! grep -q '^BACKUP_DIR=' "$APP_DIR/.env"; then
  echo "BACKUP_DIR=$BACKUP_DIR" >> "$APP_DIR/.env"
  mkdir -p "$BACKUP_DIR" && chown "$RUN_USER":"$(id -gn "$RUN_USER")" "$BACKUP_DIR" || warn "Couldn't create $BACKUP_DIR"
  echo "Backups will be copied to: $BACKUP_DIR"
fi
mkdir -p "$APP_DIR/recordings"
chown -R "$RUN_USER":"$(id -gn "$RUN_USER")" "$APP_DIR"
chmod 600 "$APP_DIR/.env"

# ---------- 6. node packages ----------
say "Installing Node packages"
sudo -u "$RUN_USER" -H bash -c "cd '$APP_DIR' && npm install --omit=dev --no-audit --no-fund --loglevel=error"

# ---------- 6b. transcription engine (whisper.cpp) — skip with NO_TRANSCRIBE=1 ----------
WHISPER_DIR=/opt/rolling-whisper
WHISPER_BIN="$WHISPER_DIR/whisper.cpp/build/bin/whisper-cli"
ensure_env() { grep -q "^$1=" "$APP_DIR/.env" || echo "$1=$2" >> "$APP_DIR/.env"; }
get_model() {
  local m="$1" f="$WHISPER_DIR/models/ggml-$1.bin"
  [ -s "$f" ] && return 0
  echo "Downloading speech model '$m'…"
  curl -fL --retry 3 --progress-bar -o "$f.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$m.bin" && mv "$f.part" "$f"
}
if [ "${NO_TRANSCRIBE:-0}" != 1 ]; then
  say "Setting up transcripts (the first time this builds the engine — a few minutes)"
  apt-get install -y -qq git cmake build-essential >/dev/null
  mkdir -p "$WHISPER_DIR/models"
  if [ ! -x "$WHISPER_BIN" ]; then
    rm -rf "$WHISPER_DIR/whisper.cpp"
    if git clone -q --depth 1 https://github.com/ggml-org/whisper.cpp "$WHISPER_DIR/whisper.cpp" \
       && cmake -S "$WHISPER_DIR/whisper.cpp" -B "$WHISPER_DIR/whisper.cpp/build" -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF >/dev/null \
       && cmake --build "$WHISPER_DIR/whisper.cpp/build" -j"$(nproc)" --config Release --target whisper-cli >/dev/null; then
      echo "Transcription engine built."
    else
      warn "Couldn't build the transcription engine — everything else works, transcripts are just off."
    fi
  fi
  get_model "${WHISPER_MODEL:-base.en}" || warn "Couldn't download the speech model — run: sudo rolling-get-model base.en"
  chown -R "$RUN_USER":"$(id -gn "$RUN_USER")" "$WHISPER_DIR"
  ensure_env WHISPER_BIN "$WHISPER_BIN"
  ensure_env WHISPER_MODELS "$WHISPER_DIR/models"
  # extra models later:  sudo rolling-get-model small.en
  cat > /usr/local/bin/rolling-get-model <<GETEOF
#!/bin/sh
set -e
m="\${1:-base.en}"; f="$WHISPER_DIR/models/ggml-\$m.bin"
curl -fL --retry 3 --progress-bar -o "\$f.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-\$m.bin" && mv "\$f.part" "\$f"
chown "$RUN_USER" "\$f"; echo "Model \$m ready — pick it in Studio settings > Transcripts."
GETEOF
  chmod 755 /usr/local/bin/rolling-get-model
  # self-test: run the engine for real on 2 seconds of test audio, as the user the studio runs as
  if [ -x "$WHISPER_BIN" ] && [ -s "$WHISPER_DIR/models/ggml-${WHISPER_MODEL:-base.en}.bin" ]; then
    T=$(mktemp -d); chmod 777 "$T"
    if ffmpeg -hide_banner -loglevel error -nostdin -y -f lavfi -i sine=frequency=300:duration=2 -ar 16000 -ac 1 -c:a pcm_s16le "$T/t.wav" \
       && sudo -u "$RUN_USER" timeout 120 "$WHISPER_BIN" -m "$WHISPER_DIR/models/ggml-${WHISPER_MODEL:-base.en}.bin" -f "$T/t.wav" -oj -of "$T/t" -np >"$T/log" 2>&1 \
       && [ -s "$T/t.json" ]; then
      echo "✓ Transcription engine tested and working."
    else
      warn "The transcription engine is installed but failed its test — transcripts won't be made. Last lines:"
      tail -n 5 "$T/log" 2>/dev/null || true
    fi
    rm -rf "$T"
  fi
fi

# ---------- 7. run as a service (starts on boot, restarts if it crashes) ----------
say "Setting up the $SERVICE service"
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=Podcast Studio (remote recording)
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) $APP_DIR/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"

ok=0
for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:$PORT/api/info" >/dev/null 2>&1 && { ok=1; break; }; sleep 0.5; done
[ "$ok" = 1 ] || { journalctl -u "$SERVICE" -n 30 --no-pager; die "The studio didn't start — see the log above."; }

# ---------- 8. Cloudflare Tunnel (optional) ----------
CF_MSG=""
if [ -n "$DOMAIN" ]; then
  say "Cloudflare Tunnel for $DOMAIN"
  CF_CFG=""
  for f in /etc/cloudflared/config.yml /etc/cloudflared/config.yaml "/home/$RUN_USER/.cloudflared/config.yml" "/home/$RUN_USER/.cloudflared/config.yaml"; do
    [ -f "$f" ] && grep -qE '^\s*ingress:' "$f" && { CF_CFG="$f"; break; }
  done
  if [ -n "$CF_CFG" ]; then
    ADDED=0
    if grep -q "hostname: *$DOMAIN" "$CF_CFG"; then
      echo "$DOMAIN is already set up in $CF_CFG — leaving it alone."
    else
      ADDED=1
      BAK="$CF_CFG.bak-$(date +%Y%m%d%H%M%S)"
      cp "$CF_CFG" "$BAK"
      # insert our hostname just above the final catch-all rule
      awk -v d="$DOMAIN" -v p="$PORT" '
        !done && /^[[:space:]]*-[[:space:]]*service:[[:space:]]*http_status/ {
          match($0, /^[[:space:]]*/); ind = substr($0, 1, RLENGTH)
          print ind "- hostname: " d; print ind "  service: http://localhost:" p; done = 1 }
        { print }' "$BAK" > "$CF_CFG"
      if grep -q "hostname: *$DOMAIN" "$CF_CFG"; then echo "Added $DOMAIN -> http://localhost:$PORT to $CF_CFG (backup: $BAK)."
      else cp "$BAK" "$CF_CFG"; CF_MSG="Couldn't add $DOMAIN to $CF_CFG automatically — add:  - hostname: $DOMAIN / service: http://localhost:$PORT  above the last rule."; fi
    fi
    TUNNEL="$(grep -E '^\s*tunnel:' "$CF_CFG" | head -1 | awk '{print $2}')"
    if [ "$ADDED" = 1 ] && [ -n "$TUNNEL" ] && command -v cloudflared >/dev/null; then
      if sudo -u "$RUN_USER" -H cloudflared tunnel route dns "$TUNNEL" "$DOMAIN" >/dev/null 2>&1 || cloudflared tunnel route dns "$TUNNEL" "$DOMAIN" >/dev/null 2>&1; then
        echo "DNS record for $DOMAIN created."
      else
        CF_MSG="Couldn't create the DNS record automatically. In Cloudflare DNS add: CNAME  ${DOMAIN%%.*}  ->  $TUNNEL.cfargotunnel.com  (Proxied)."
      fi
    fi
    if [ "$ADDED" = 1 ]; then systemctl restart cloudflared 2>/dev/null || warn "Restart cloudflared yourself so it picks up the new hostname."; fi
  else
    CF_MSG="Your tunnel is managed in the Cloudflare dashboard. Go to one.dash.cloudflare.com → Networks → Tunnels → your tunnel → Public hostnames → Add: hostname $DOMAIN, Service type HTTP, URL localhost:$PORT  → Save."
  fi
fi

# forgotten password helper:  sudo podcast-studio-reset-password
cat > /usr/local/bin/podcast-studio-reset-password <<RESETEOF
#!/bin/sh
cd "$APP_DIR" && sudo -u "$RUN_USER" "$(command -v node)" server.js --reset-password | head -1 && systemctl restart $SERVICE
RESETEOF
chmod 755 /usr/local/bin/podcast-studio-reset-password

# ---------- done ----------
PW="$(grep -E '^ADMIN_PASSWORD=' "$APP_DIR/.env" | cut -d= -f2)"
grep -q '"adminHash": *"scrypt' "$APP_DIR/recordings/settings.json" 2>/dev/null && PW="(you changed it in the dashboard — forgot it? run: sudo podcast-studio-reset-password)"
URL="${DOMAIN:+https://$DOMAIN}"; URL="${URL:-http://127.0.0.1:$PORT (needs HTTPS in front — see README)}"
printf '\n\033[1;32m================  Podcast Studio is running  ================\033[0m\n'
echo "  Open:            $URL"
echo "  Admin password:  $PW"
echo "  Recordings:      $APP_DIR/recordings"
echo "  Settings:        $APP_DIR/.env"
[ -n "$CF_MSG" ] && { echo; warn "$CF_MSG"; }
echo
echo "  Status:  systemctl status $SERVICE      Logs:  journalctl -u $SERVICE -f"
echo "  Update:  run this installer again (keeps settings and recordings)"
echo "============================================================="
