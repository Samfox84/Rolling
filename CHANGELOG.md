# Changelog

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
