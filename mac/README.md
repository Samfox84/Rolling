# Rolling for Mac

A native Mac app for Rolling, built with SwiftUI for macOS 26 (Tahoe). It isn't a web page in a window.

- **Host on this Mac.** The app runs the whole Rolling studio itself, with no server. It uses the same `server.js`, run by a copy of Node inside the app, and makes a free internet link for your guests (or uses your own Cloudflare address).
- **Connect to a studio server.** Sign in with the studio's admin password to see every show, or paste one show's host link. Every recording is also saved on this Mac.
- **The producer's studio, native.** Everyone's video, recording and markers, timecode and tally, the Console (faders, mute and solo live; EQ, compressor, gate, low cut and pan baked into the Producer mix), the soundboard (F1–F12), green room, talkback, cue cards, rundown and show clock, script and teleprompter, live transcript, chat, Health and a big clock. Your own voice is recorded losslessly (24-bit, 48 kHz) and your camera as an MP4, both on this Mac, exactly like a guest's browser does.

Guests still join from a link in Chrome, Edge or Safari. They install nothing.

## Build it

You need Xcode 26 or newer, and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).

```sh
cd mac
xcodegen            # makes Rolling.xcodeproj from project.yml
open Rolling.xcodeproj
```

Press ⌘R. The first build downloads Node, ffmpeg, ffprobe and cloudflared into `Rolling/Resources/Tools`, and copies the studio into `Rolling/Resources/Studio`. It needs the internet that first time.

WebRTC comes from the [stasel/WebRTC](https://github.com/stasel/WebRTC) Swift package (Google's libwebrtc, BSD licence).

## How it's put together

| Folder | What's in it |
|---|---|
| `Rolling/App` | The app, its windows and menus, and `AppModel` (hosting or connected, the shows) |
| `Rolling/Engine` | The studio's web API, hosting on this Mac (`LocalStudio`, which runs node and cloudflared), and saving copies (`Mirror`) |
| `Rolling/Screens` | The main window: welcome, shows, recordings, rundown, soundboard pads, show settings, invites, Settings |
| `Rolling/Studio` | The live studio: signalling (`StudioSession`), calls (`PeerLink`), sound (`StudioAudio`, a custom audio device for libwebrtc), soundboard, recorder, camera, and the studio window and its panels |
