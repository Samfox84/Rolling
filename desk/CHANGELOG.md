# Changelog — Rolling Desk (the desktop app)

What changed in each version of the app. Newest first. Downloads are on the
[Releases page](https://github.com/Samfox84/Rolling/releases). The studio itself has its own list:
[../CHANGELOG.md](../CHANGELOG.md).

## 0.3.2
- **A proper Rolling icon** for the app (Mac dock, Windows taskbar, Linux menu) and on the start screen
- Carries studio 0.9.1 when hosting: the Health panel in plain words and a clearer "your computer is struggling"
  message

## 0.3.1
- **The start screen asks each time:** "Connect to a hosting server" or "Host locally on this computer". Tick
  **Remember my choice** to go straight there next time (change it from the File menu)
- **The Linux .deb updates itself too:** it downloads and checks the new version, asks for your password in the usual
  Ubuntu box, installs it and reopens
- Fix: the "new version" message could appear twice at once; now it's asked once per version

## 0.3.0
- **Your own guest-link address** when hosting (e.g. podcast.yourname.com, the same every time) with a free
  Cloudflare account — step-by-step with sign-up links on the start screen. Your tunnel token is kept only on this
  computer, encrypted
- **Free space** for your studio folder on the start screen (and roughly how many hours of recording), in the window
  title while hosting, and a warning if it's nearly full
- **Windows updates itself** now too (downloads the new installer, checks its fingerprint, installs after you restart)
- **Problem reports:** the app keeps a diary of what it did and any errors (activity.log, and a crash file whenever
  something goes wrong). **Help › Save a problem report…** puts one file on your Desktop to send on Discord or by
  email — keys, tokens, passwords, emails and your user name are removed first. **Help › Open the log folder**
- If the app ever crashes while hosting, the guest-link program it left running is stopped next time it opens
- Small fixes: a failed page shows a clear message; the start screen is taller to fit everything

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
