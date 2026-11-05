# Changelog

## 1.3.2
- **Live level bars on every tile** — everyone sees a moving green/amber/red bar for every person (−60 to 0 dBFS) with a peak-hold line and a red CLIP light that stays on for 3 s
- **Transcripts you can see:** the Recordings page says exactly where each take's transcript is at (live %, ready with line count, failed and why, or not made yet)
- **📝 Make transcript** button for takes recorded before transcripts were on, or to make one again — a failed re-run never throws away the old transcript
- **Live transcript progress** in the host's Health panel while recording
- **Test transcription** button in Studio settings, and the installer now test-runs the engine and says if it works
- Transcript failures are listed as take errors — never just a missing file

## 1.3.1 — deep audit (see docs/reviews/2026-11-03-audit-v1.3.1.toon)
- **Live loudness on the video tiles:** the host sees every person's LUFS while they talk; guests see their own
- **No silent failures:** every error is logged (journalctl) or shown; corrupt files are kept and reported
- **Every request has a timeout** — a stalled connection can no longer freeze uploads; the studio reconnects if the link goes quiet for 15 s
- "Click to hear everyone" appears if the browser blocks sound
- Marker/chapter updates swap files in place (never briefly missing) and reach the backup drive
- One logger (log.js), one program runner (proc.js), one set of page helpers (public/common.js); duplicate code removed
- **Automated tests:** `npm test` (44 tests: meters, transcripts, documents, full server take) and `npm run test:e2e` (real browsers)

## 1.3.0
- **Control room:** the host can run the show with no camera or mic (not recorded)
- **Broadcast loudness meters** (EBU R128 / BS.1770) for everyone in the Health panel: momentary, short-term, integrated LUFS and true peak; own loudness shown in the lobby
- **Level check after every take** (Level report) plus **normalised copies** at −16 LUFS and −23 LUFS; untouched originals kept
- **Intro and outro** audio per show, placed in the session files and a −16 LUFS rough mix
- **Native Audition session (.sesx, beta)** alongside the Premiere/Resolve/Audition XML; intro, everyone and outro lined up, with markers
- **Transcripts** made on the server with whisper.cpp, transcribed live in the background while recording; Transcript .txt / .srt / .vtt with speaker names
- **Progress bars** for uploads and for building each take (studio and Recordings page)
- **Episode number and title** per take, used in file and zip names and emails
- **Chapters** from markers (.json for podcast apps, YouTube list); markers can be renamed or deleted on the Recordings page
- **3-2-1 countdown**, **sound check** in the lobby, **free-up-space** buttons and optional automatic tidy-up
- "Mix - all voices" is now 32-bit float so overlapping voices can't clip

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
