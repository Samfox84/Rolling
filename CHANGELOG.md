# Changelog

## 1.2.0
- Named **Rolling**; released under AGPL-3.0
- Change the admin password from the dashboard (stored hashed); `sudo podcast-studio-reset-password` if forgotten
- Each install still gets its own random starting password

## 1.1.0
- Crash-proof uploads (saved to the browser's disk first, resumed after a crash), auto-rebuild when late files arrive
- Problem alerts: silent / unplugged / distorting mic, audio glitches, upload falling behind, poor connection, low disk
- Lobby connection test; camera recording bitrate matched to the connection; audio always uploads first
- Host Health panel, waiting room, text chat, markers (M key), screen share recording
- Session XML for Audition / Premiere / Resolve, Audition markers CSV
- Automatic backup to a second drive, email when a take is ready, Cloudflare TURN relay
- Takes survive a server restart; no caching of dynamic pages by Cloudflare/browsers

## 1.0.0
- Video call for up to 5, lossless 24-bit WAV per person, camera video per person, room tone, lined-up files, zip download
