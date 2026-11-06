# Changelog

## 1.5.0 — the audio Console (stage 1 of Rolling Desk)
For the producer in the control room: **🎛 Console**, a full-screen audio mixing desk. Everyone is heard through it.
- **Channel strip per person:** low cut (80 Hz), 3-band EQ (low 120 Hz · presence 2.5 kHz · high 8 kHz, ±12 dB),
  compressor with gain-reduction meter, pan, vertical fader with level meter, their live loudness, MUTE (out of the mix),
  SOLO (your headphones), TALK (hold) and CUE
- **Master section:** live EBU R128 loudness of your mix — momentary, short-term, integrated and true peak — against a
  −16 (podcast) or −23 (broadcast) LUFS target; reset integrated; listening volume
- **Keyboard control (no hardware needed):** ← → pick a channel · ↑ ↓ fader 1 dB (Shift 0.25) · 0 = 0 dB · X mute ·
  S solo · Q low cut · W compressor · hold T to talk to them · scroll on a fader for 0.5 dB
- **What you hear is what you get:** fader and mute moves are baked into the Producer mix exactly as you made them;
  each channel's EQ, compressor and pan as set at the end of the take. **The Producer mix is now stereo.**
- **Remembered:** each person's channel settings are saved by name and come back next show (and if they drop out and rejoin)
- Quick tags, cue cards, talkback, rundown clock, record and room tone are all on the same screen
- The untouched recordings, cleaned files and video are made exactly as before

## 1.4.2 — whole-workflow testing and the fixes it found
Two new end-to-end tests drive real browsers through the whole job, then download and open every file:
basic user (dashboard → room → guest → room tone → record → marker → stop → Recordings → downloads) and
advanced producer (control room, 3-segment rundown, show clock, quick tags, desk, cue cards, talkback, cough,
a guest dropping out and rejoining, the **server crashing mid-show**, then Clean again / Make transcript /
free space / delete). Fixed along the way:
- **Markers, segments, fader moves and coughs are stamped at the moment the button was pressed** (using the
  synced clock), not when the message reached the server — exact even on a slow connection or busy computer
- **Rebuilding a take never breaks a download**: files are built in a separate folder and swapped in at the end;
  the previous files stay downloadable meanwhile (this happens automatically when late pieces arrive after a dropout)
- **No more occasional failed downloads / Cloudflare 502s**: idle connections are kept open longer than Cloudflare's
- **The show clock survives a server restart** — the current segment is remembered with the take

## 1.4.1 — timecode clock and tally
- **Timecode bar for everyone** (like a broadcast monitor): REC timecode (HH:MM:SS:FF, starts at 00:00:00:00 with the take — the same timeline as every file), current segment timecode with time left, and time of day
- **Tally**: red frame round the whole studio while recording (amber during room tone), REC lamp in the bar, and a red frame on each person who is recording
- **⛶ Clock** full-screen view and **↗ Pop out** window to drag onto a second screen (double-click it for full screen)
- **Frame rate setting** (Studio settings): 25 fps (UK, now the default) or 30 fps — used for the clock, the MP4s and the Premiere/Resolve XML, so the timecode always matches the files
- Fix: closing the full-screen clock while it was still opening could leave the screen stuck in full screen

## 1.4.0 — producer desk and clean-up files
**Live, while recording (host)**
- **🎚 Desk** with a fader per person: changes what you hear *and* is recorded into the new **Producer mix**; 🎧 mute / solo for your ears only; your own listening volume
- **Cue cards** — big on-screen messages to one person or everyone (Wrap up, 2 minutes, Go to the ad break, Speak up… or your own)
- **Talkback** — hold T (or the button) to talk privately to one person; works from the control room too
- **Quick tags** — keys 1–4: Great bit, Cut this, Retake, Ad break (M is still a plain marker)
- **⏱ Rundown and show clock** — plan segments with timings; everyone sees the clock (amber in the last minute, red when over); each segment becomes a chapter
- **Loudness history** — the last 5 minutes of each person's level in the Health panel

**Everyone**
- **🤧 Cough button** — hold C (or the button) to mute your live sound; your recording is untouched, the cough is marked and muted in the Producer mix

**After each take**
- **Cleaned copy of every voice** (−16 LUFS): repair distortion, rumble + mains hum (50/60 Hz), noise reduction set from the room tone, de-ess, gentle compression, optional gate — all switchable in Studio settings › Clean-up files; the untouched recordings are always kept
- **Producer mix** replaces the rough mix: cleaned voices + your live fader moves + coughs/talkback muted + intro/outro, at −16 LUFS
- **Edit list.txt** — tags, segments, coughs, talkback and long pauses, grouped and in time order; also in the Audition markers file (with durations)
- **🧽 Clean again** on the Recordings page re-makes the cleaned files and Producer mix with your current settings (works even after freeing up space)

## 1.3.3
- **Fix: transcripts failing with "Error opening output … No such file or directory".** The system's /tmp clean-up removed the transcription work folder while the studio was running. Work files now live with the recordings, and the folder is re-made before every job
- A transcript that hiccups once and then carries on no longer reports the old error

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
