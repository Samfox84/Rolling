# Changelog — Rolling Desk (the desktop app)

What changed in each version of the app. Newest first. Downloads are on the
[Releases page](https://github.com/Samfox84/Rolling/releases). The studio itself has its own list:
[../CHANGELOG.md](../CHANGELOG.md).

## 0.2.2
- Fix: **Host it on this computer** failed to start ("The studio couldn't start") because the studio's packages were
  left out of the app. Every build now starts the studio from inside the finished app before it's published
- Fix: switching from the File menu ("Connect to a different studio, or host it myself…") could crash the app on macOS
- If the studio can't start, the message now says why (and the full log is kept in `studio.log` in Rolling Desk's settings folder)
- The studio always gets its own **Rolling Studio** folder inside whichever folder you pick

## 0.2.1
- The app's internal ID no longer contains a personal web address (now `io.github.samfox84.rolling-desk`). The app
  never had any studio address built in — it always starts blank and you enter your own

## 0.2.0 — host it on this computer (no server)
- New choice on the start screen: **Host it on this computer.** The app runs the whole studio itself and makes a free
  internet link for guests (a Cloudflare quick tunnel). Everything works as on a server — Console, recordings, files,
  transcripts. ffmpeg, the tunnel and the transcript engine (with its English model) are included
- **Windows version** (installer), alongside Mac (Intel and Apple Silicon) and Linux
- Studio pages now show guest links with the studio's public address when it has one (the hosted app's tunnel)
- The studio stops by itself if Rolling Desk closes, and the app asks before closing during a show

## 0.1.0 — the first release
- Your studio and its **audio Console** in their own window: paste your show's host link once
- **Everything saved on this computer as well as the server:** a live full-quality copy while recording, then every
  finished file when the take is ready
- Never closes too early: warns while saving and keeps the computer awake while recording or saving
- **Updates itself** from GitHub Releases (Mac and Linux AppImage; the download's fingerprint is checked; never
  restarts during a show)
- Mac (Intel and Apple Silicon) and Linux
