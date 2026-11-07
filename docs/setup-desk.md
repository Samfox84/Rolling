# Rolling Desk — the producer's app

Rolling Desk is a free app for **Mac, Windows and Linux**. You can use it in two ways:

| | **Connect to your studio** | **Host a studio on your computer** |
|---|---|---|
| **For** | You already have Rolling on a server ([set one up](setup-server.md)) | You don't have a server |
| **Where the studio runs** | Your server | This computer, while the app is open |
| **Guest link** | Your own web address, the same every time | A free Cloudflare address, **new each time you start** |
| **Recordings** | On the server, **and** copied to this computer | On this computer |
| **Best for** | A regular show | Trying Rolling, or an occasional show |

---

## Install it

1. Go to the [Releases page](https://github.com/Samfox84/Rolling/releases) and open the newest **Rolling Desk**.
2. Download the file for your computer:

| Your computer | Download | Then |
|---|---|---|
| **Mac with Apple Silicon** (M1 and newer) | `…-mac-arm64.dmg` | Open it, drag **Rolling Desk** into **Applications** |
| **Mac with Intel** (e.g. Mac Pro 2013; macOS 12 or newer) | `…-mac-x64.dmg` | Same as above |
| **Windows 10 / 11** | `…-win-x64.exe` | Run it and follow the installer |
| **Linux** | `…-x86_64.AppImage` | Right-click › Properties › allow running as a program, then double-click |
| **Ubuntu / Debian** (alternative) | `…-amd64.deb` | `sudo apt install ./Rolling-Desk-*.deb` |

**The first time you open it:** the app isn't signed by Apple or Microsoft (that costs money every year), so:
- **Mac:** right-click the app › **Open** › **Open**. If macOS still refuses, paste this into Terminal:
  `xattr -dr com.apple.quarantine "/Applications/Rolling Desk.app"`
- **Windows:** if a blue box says "Windows protected your PC", press **More info › Run anyway**.

**Not sure which Mac you have?** Apple menu › **About This Mac**: "Chip: Apple M…" is Apple Silicon, "Processor: Intel" is Intel.

---

## Connect to your studio

1. On your Rolling dashboard, copy the link under **Open studio as host** for your show.
2. Open Rolling Desk, choose **Connect to my studio server**, and paste the link.
3. Choose where to save recordings on this computer (the default is **Rolling Recordings** in your home folder),
   then press **Connect**.
4. Your studio opens. Choose **Run the show from the control room** for the full mixing desk (🎛 Console), or join
   on mic as normal.

While you record, the app saves a full-quality copy as it goes. When the take is ready it downloads every finished
file. If you try to close it before everything's saved, it warns you.

---

## Host a studio on your computer (no server)

1. Open Rolling Desk and choose **Host it on this computer**.
2. Choose where to keep your shows and recordings (a **Rolling Studio** folder is made there — pick a drive with
   plenty of space: about 4 GB per person per hour).
3. Press **Start my studio**. After a few seconds you're signed in to your own dashboard.
4. Create a room for your show. Your **guest link** shows on the dashboard and in the window's title.
   **File › Copy the guest link address** copies it.
5. Send the guest link to your guests, then run the show as normal. Open the room with **Open studio as host** —
   it opens right here in the app.

**While you're hosting:**
- **This computer *is* the studio.** Keep it on, awake and online until the files are ready. The app stops it
  sleeping, and asks before you close it if anyone's recording, still in the studio, or the files aren't finished.
- **The guest link is new each time** you start the studio, so send it out after you start.
- **If the internet drops,** the call drops but nothing is lost: everyone's recording is kept in their browser and
  uploads when they reconnect. If the guest link had to be remade, the app tells you the new one.
- **To stop hosting:** close the app, or **File › Stop hosting**.
- Everything it needs is built in: ffmpeg, the Cloudflare link and the transcript engine.

---

## Updates

The Mac app and the Linux AppImage **update themselves**. They check GitHub when they open and every 6 hours, and
ask you to restart — never during a show. You can also use **File › Check for updates…**. Windows and the `.deb`
tell you when there's a new version and open the download page.

## If something goes wrong

| What you see | What to do |
|---|---|
| **"The studio couldn't start"** (hosting) | The message says why. The full log is `studio.log` in the app's settings folder: Mac `~/Library/Application Support/Rolling Desk`, Windows `%APPDATA%\Rolling Desk`, Linux `~/.config/Rolling Desk`. |
| **"The studio didn't accept that link"** | Copy **Open studio as host** again from your dashboard — the guest link won't work here. |
| **The app opens straight into an old studio** | It remembers the last one. **File › Connect to a different studio, or host it myself…** |
| **Guests can't hear or see each other** | Ask everyone to use Chrome or Edge. On strict office Wi-Fi, set up the free relay in **Studio settings**. |
| **Want to start completely fresh** | Close the app and delete its settings folder (above). Your recordings aren't in there and are kept. |

What's changed in each version: [desk/CHANGELOG.md](../desk/CHANGELOG.md).
