# 🎛 Rolling Desk

The producer's desktop app for a Rolling studio, for Mac, Windows and Linux. It connects to your studio server — or runs the whole studio on this computer, no server needed.

- **Your studio in its own window.** Join as the control room and the **audio Console** opens by itself. It has faders, EQ, a gate, a compressor, pan, mute and solo, auto level and auto mix, scenes, the soundboard, the green room, the live loudness of your mix, talkback, cue cards, quick tags, producer notes, the script/teleprompter and the rundown clock, all usable from the keyboard.
- **Every recording is saved on this computer as well as on the server:**
  - **While recording:** a live copy of everyone's full-quality audio (24-bit WAV, exactly what their browser recorded) and camera, a few seconds behind. Only audio that has arrived complete with no gaps is copied, so nothing already saved ever changes.
  - **When the take is ready:** every finished file is downloaded and checked: untouched and cleaned voices, the Producer mix, video, edit list, transcript and session files. If the take changes later (Clean again, marker edits), the changed files are fetched again.
  - The live copy is removed once the finished files are safe (you can turn that off in the File menu).
- **It never loses a recording by closing too early.** It warns you if it's still saving, and keeps the computer awake while recording or saving. The status shows **✅ safe to close** when everything is saved.

The app doesn't change the studio. It uses the same server and the same host link as a browser. Anyone can still run the show from a normal browser.

**Step-by-step guide (install, connect, host on your computer, troubleshooting): [docs/setup-desk.md](../docs/setup-desk.md)** · What's new: [CHANGELOG.md](CHANGELOG.md)

## Install
Download from the repo's **Releases** page (or the latest **Actions › Rolling Desk app** run):

| Computer | File |
|---|---|
| Mac with Intel (e.g. Mac Pro 2013), macOS 12 Monterey or newer | `Rolling-Desk-…-mac-x64.dmg` |
| Mac with Apple Silicon (M1 and newer) | `Rolling-Desk-…-mac-arm64.dmg` |
| Linux | `Rolling-Desk-…-x86_64.AppImage` (make it executable, then double-click) or `…-amd64.deb` |

The Mac app isn't signed by Apple (that costs £79 a year). The first time you open it, **right-click › Open › Open**. If macOS still refuses, run this in Terminal:
```
xattr -dr com.apple.quarantine "/Applications/Rolling Desk.app"
```

## Host it on this computer (no server)
Don't have a server? On the start screen choose **Host it on this computer** and press **Start my studio**. Rolling Desk runs the whole studio itself: the dashboard, the Console, recording, the finished files and transcripts — the same as on a server.
- **The guest link** is a free Cloudflare address (like `something.trycloudflare.com`) made when you start. It's new each time, so send it out after you start. Your window's title shows it, and **File › Copy the guest link address** copies it. The dashboard and the studio's **Copy guest link** use it automatically.
- **Everything is saved in your studio folder** (default `~/Rolling Studio`, change it on the start screen). About 4 GB per person per hour.
- **Keep the computer on, awake and online** until the files are ready. Rolling Desk stops it sleeping while hosting, and asks before you close it if anyone's recording, in the studio, or the files aren't finished.
- **If the internet drops,** the call drops but nothing is lost — everyone's recording is kept in their browser and uploads when they're back. If the guest link has to be remade, the app tells you the new one.
- Included in the app: ffmpeg, the Cloudflare tunnel program (`cloudflared`), and the transcript engine (whisper.cpp) with its English speech model. Nothing else to install.
- Quick links have no uptime promise from Cloudflare; for a regular show, a server (like Steve's) is still the steadiest setup.

## Updates
The app **updates itself**. It checks GitHub for a new version when it starts and every 6 hours (or **Check for updates…** in the menu). It downloads the new version, checks its fingerprint against the Release's `SHA256SUMS.txt`, and asks you to restart — never while you're recording or still saving. If anything goes wrong while swapping, the old version is put back.
- Works for the Mac app and the Linux AppImage. Windows and the `.deb` can't replace themselves yet, so they tell you there's a new version and open the download page.
- Needs the Rolling project on GitHub to be **public** (GitHub doesn't show releases of private projects without signing in).

## Use
1. Open Rolling Desk and paste your show's **host link**, from the dashboard under "Open studio as host".
2. Choose where recordings are saved (default: `Rolling Recordings` in your home folder), then click **Connect**.
3. Type your name and click **Control room**. The Console opens.

Recordings are saved as `Rolling Recordings/<Show>/<Episode or Take (date time)>/…`. To switch to a different show, use **File › Connect to a different studio or show…**.

## Build it yourself
```
cd desk
npm install
npm start               # run it
npm run dist:mac        # on a Mac: Intel + Apple Silicon .dmg
npm run dist:linux      # AppImage + .deb
```
Whenever the app changes on `main`, GitHub builds every version and puts them on a Release named after the version in `desk/package.json` (or run it by hand: Actions › Rolling Desk app › Run workflow).

It uses Electron 43, the newest version that still runs on macOS 12 Monterey, so it works on a Mac Pro 2013.
