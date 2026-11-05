# Rolling

**A free, open-source, self-hosted remote recording studio for podcasts** — a bit like Riverside, but on your own server.

> **Made by a human and an AI, together.** Rolling was designed and directed by **Sam Fox** and written with **Claude**, Anthropic's AI assistant (model: Claude Opus 5.5, `claude-opus-5-5`), in conversation. Sam set the goals, tested it and made the decisions; Claude wrote the code and tests. Every change is in the commit history, and AI-written commits are marked *Co-Authored-By: Claude*.

Version: see [CHANGELOG.md](CHANGELOG.md). Licence: [GNU AGPL-3.0](LICENSE) — free to use, study, change and share; any changed version that is shared, or run as a service for others, must stay free and open too.

**Recording**
- **Video call** for up to 5 people in the browser — guests just click a link, nothing to install.
- **Lossless audio per person** — each browser records its own mic as 24-bit / 48 kHz WAV.
- **Video per person** (720p) and **screen shares**, each recorded locally as its own file.
- **Room tone** — a 20-second "Quiet please" countdown when recording starts; a separate noise-print WAV per person. Grab another any time with 🤫.
- **Everything lined up** — all files start at the same moment; camera video is matched to the audio automatically.
- **Markers** — host presses **M** (or 📍) to mark edit points.
- **Session file** — open in Audition (File › Open), Premiere or Resolve to get every file on its own track, with markers. Plus an Audition markers CSV.

**Post-production**
- **Live level bars** on every person's video tile (green / amber / red, peak hold, clip light) and **broadcast loudness meters** (EBU R128) for everyone, live in the host's Health panel.
- **Level report + normalised copies** of every person at −16 LUFS (podcast) and −23 LUFS (broadcast), alongside the untouched recordings.
- **Intro & outro** per show, added to the session files and a −16 LUFS Producer mix.
- **Native Audition session (.sesx)** plus XML for Premiere / Resolve.
- **Transcripts** (TXT, SRT, VTT, with speaker names) made on your own server with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), transcribed live in the background while you record. The Recordings page shows each transcript's progress or why it failed, with a **Make transcript** button for older takes.
- **Chapters** from markers, **episode numbers and titles** in file names, progress bars for everything.
- **Control room** — the host can run the show without being on camera.

**Producer desk (live)**
- **🎚 Desk** — a fader per person (what you hear + baked into the **Producer mix**), 🎧 mute/solo for your ears only.
- **Cue cards** to one person or everyone, **talkback** (hold T), **quick tags** (keys 1–4: Great bit, Cut this, Retake, Ad break).
- **Timecode clock + tally** for everyone: record, segment and time-of-day timecode, red tally frame while recording; full-screen and pop-out clock for a second screen.
- **⏱ Rundown + show clock** everyone can see; segments become chapters. **Loudness history** for each person.
- **🤧 Cough button** for everyone (hold C) — mutes live sound only; marked and muted in the Producer mix.

**Clean-up (after each take — the untouched files are always kept)**
- **Cleaned copy of every voice** — declip, rumble + mains hum, noise reduction from the room tone, de-ess, compression, optional gate. Settings in Studio settings › Clean-up files; **🧽 Clean again** to redo a take.
- **Producer mix** (cleaned voices + your fader moves + intro/outro, −16 LUFS) and an **Edit list** (tags, segments, coughs, talkback, long pauses).

**Fail-safes**
- **Crash-proof** — every piece is saved to the guest's own disk *before* uploading, and only deleted once the server has it. If a browser crashes, the laptop dies or the tab is closed, reopening the link carries on uploading; the take rebuilds itself automatically.
- **Server restart / power cut** mid-show — the take carries on when the server is back; browsers keep recording and catch up.
- **Problem alerts** — silent mic, unplugged mic (auto-reconnects), distortion, audio glitches, upload falling behind, poor connection, low disk. Each person sees plain-English advice; the host gets a toast and the 🩺 **Health** panel.
- **Connection check** in the lobby (upload, download, delay) with advice; camera recording quality is set to match the connection. Audio always uploads first.
- **Disk check** before recording starts, with "hours left" in the Health panel.
- **Automatic backup** of every finished take to a second drive.
- **Email** when a take is ready (any SMTP server, e.g. Mailcow).

**Comfort**
- **Waiting room** — guests wait until the host lets them in.
- **Text chat** during the show (saved with the take).
- **Free relay** (Cloudflare TURN) so guests on locked-down networks can still connect.

## Install (Ubuntu / Debian, incl. Raspberry Pi OS)

```bash
tar xzf podcast-studio-*.tar.gz
cd podcast-studio
sudo DOMAIN=podcast.yourdomain.com bash install.sh
```

The installer adds ffmpeg and Node.js if needed, sets up a service that starts on boot, and prints your **admin password** at the end.

### What it needs
| Thing | Why |
|---|---|
| Ubuntu 22.04+ / Debian 12+ (64-bit) | runs the server |
| Node.js 18 or newer (installer adds 22) | the app |
| ffmpeg + ffprobe 4.4 or newer (from apt) | builds the WAV / MP4 / session files |
| npm packages: express, ws, archiver, nodemailer | installed automatically |
| whisper.cpp + a speech model (~150 MB), git, cmake, build-essential | transcripts — built by the installer (skip with `NO_TRANSCRIBE=1`; more models: `sudo rolling-get-model small.en`) |
| HTTPS on a domain | browsers only allow camera/mic over HTTPS |
| Disk space | about 4 GB per person per hour of recording (lossless audio + camera original + MP4). Delete old takes from the Recordings page once downloaded. |

### HTTPS
The app listens on `127.0.0.1:8790` and needs something in front of it for HTTPS:

- **Cloudflare Tunnel** (easiest, no port forwarding): pass `DOMAIN=...` to the installer. If your tunnel uses a local `config.yml` it's added automatically; if it's managed in the Cloudflare dashboard, add a Public Hostname → `HTTP` → `localhost:8790`.
- **Caddy**: `podcast.yourdomain.com { reverse_proxy 127.0.0.1:8790 }`
- **nginx**: proxy to `127.0.0.1:8790` with WebSocket upgrade headers for `/ws`, and `client_max_body_size 64m;`.

## Using it
1. Open your domain, log in with the admin password, and **Create room** (e.g. one per show).
2. Copy the **Host link** for the presenter and the **Guest link** for guests.
3. Host presses **Start recording** → choose room tone → everyone sees the countdown → talk.
4. Press **Stop recording**. Everyone's tab shows "Saved ✓" when their upload has finished.
5. Open **Recordings** — files appear a minute or two later (MP4 conversion takes longer on slower machines).

Tips for guests: Chrome, Edge or Safari on a laptop/desktop; headphones give the cleanest sound (tick "I'm wearing headphones").

## Settings
Email, backup drive and relay are set on the dashboard under **Studio settings** (stored in `recordings/settings.json`). Waiting room and who gets emailed are per room, on its Recordings page.

Everything else: edit `/opt/podcast-studio/.env`, then `sudo systemctl restart podcast-studio`.

| Setting | Default | |
|---|---|---|
| `ADMIN_PASSWORD` | random | dashboard login |
| `STUDIO_NAME` | Podcast Studio | shown on every page |
| `PORT` | 8790 | |
| `MAX_PEOPLE` | 5 | per room |
| `ROOM_TONE_SECONDS` | 20 | |
| `VIDEO_PRESET` | veryfast | x264 speed for MP4 copies |
| `DATA_DIR` | /opt/podcast-studio/recordings | where takes are stored |
| `BACKUP_DIR` | auto: /mnt/usb-drive/… if mounted | default backup folder |
| `MIN_FREE_GB` | 2 | refuse to start recording below this |
| `TURN_URLS`, `TURN_SECRET` | – | your own coturn relay instead of Cloudflare's (`use-auth-secret`) |

Without a relay, a guest on a locked-down network (some offices/hotels) may not see/hear the others live — **their recording still uploads fine**, because uploads go over normal HTTPS. Add the free Cloudflare relay in Studio settings to fix the live call too.

## Admin password
Each install gets its own random password, shown at the end of the install. Change it any time in **Studio settings → Admin password** (it's stored hashed). Forgot it? Run `sudo podcast-studio-reset-password` on the server.

## Tests
```bash
npm test            # 55 tests: loudness meter accuracy, transcripts, documents, a full recording through the real server
npm run test:e2e    # real browsers: studio features + two whole-workflow runs (basic user, advanced producer with a
                    # dropout and a server crash) that download and open every file (needs: npm i -g playwright && npx playwright install chromium)
```
Tests never touch the internet (`NO_EXTERNAL_CALLS=1`) and use a stand-in for whisper.cpp.

## Logs
Everything is logged to the system journal: `journalctl -u podcast-studio -f`. Set `LOG_LEVEL=debug` in `.env` to also see every step start and finish with timings.

## Looking after it
- Status: `systemctl status podcast-studio`
- Live log: `journalctl -u podcast-studio -f`
- Update: unpack the new version and run `sudo bash install.sh` again (settings and recordings are kept)
- Back up: copy `/opt/podcast-studio/recordings`
- Remove: `sudo systemctl disable --now podcast-studio && sudo rm -rf /opt/podcast-studio /etc/systemd/system/podcast-studio.service`
