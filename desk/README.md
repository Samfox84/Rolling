# 🎛 Rolling Desk

The producer's desktop app for a Rolling studio, for Mac and Linux.

- **Your studio in its own window.** Join as the control room and the **audio Console** opens by itself. It has faders, EQ, a compressor, pan, mute and solo, the live loudness of your mix, talkback, cue cards, quick tags and the rundown clock, all usable from the keyboard.
- **Every recording is saved on this computer as well as on the server:**
  - **While recording:** a live copy of everyone's full-quality audio (24-bit WAV, exactly what their browser recorded) and camera, a few seconds behind. Only audio that has arrived complete with no gaps is copied, so nothing already saved ever changes.
  - **When the take is ready:** every finished file is downloaded and checked: untouched and cleaned voices, the Producer mix, video, edit list, transcript and session files. If the take changes later (Clean again, marker edits), the changed files are fetched again.
  - The live copy is removed once the finished files are safe (you can turn that off in the File menu).
- **It never loses a recording by closing too early.** It warns you if it's still saving, and keeps the computer awake while recording or saving. The status shows **✅ safe to close** when everything is saved.

The app doesn't change the studio. It uses the same server and the same host link as a browser. Anyone can still run the show from a normal browser.

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
