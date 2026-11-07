# Rolling Desk — the producer's app

Rolling Desk is a free app for **Mac, Windows and Linux**. You can use it in two ways:

| | **Connect to your studio** | **Host a studio on your computer** |
|---|---|---|
| **For** | You already have Rolling on a server ([set one up](setup-server.md)) | You don't have a server |
| **Where the studio runs** | Your server | This computer, while the app is open |
| **Guest link** | Your own web address, the same every time | A free Cloudflare address, new each time — or **your own address** with a free Cloudflare account |
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
2. Choose where to keep your shows and recordings (a **Rolling Studio** folder is made there). The screen shows how
   much space is free and roughly how many hours of recording that is (about 4 GB per person per hour).
3. Choose your **guest link** (see below), then press **Start my studio**. After a few seconds you're signed in to your own dashboard.
4. Create a room for your show. Your **guest link** shows on the dashboard and in the window's title.
   **File › Copy the guest link address** copies it.
5. Send the guest link to your guests, then run the show as normal. Open the room with **Open studio as host** —
   it opens right here in the app.

### Your guest link: new each time, or your own address

- **A new free link each time** — nothing to set up. It looks like `something.trycloudflare.com` and changes every
  time you start, so send it out after you start.
- **Your own address, the same every time** — e.g. `podcast.yourname.com`. You need a domain and a free Cloudflare
  account (the start screen has the sign-up links):
  1. [Sign up to Cloudflare](https://dash.cloudflare.com/sign-up) (free) and [add your domain](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/).
  2. At **one.dash.cloudflare.com** go to **Networks › Tunnels › Create a tunnel**, choose **Cloudflared**, name it.
  3. Copy the install command Cloudflare shows and paste it into Rolling Desk (you don't need to run it).
  4. Back in Cloudflare press **Next** and add a **Public hostname**: your address, type **HTTP**, URL
     **localhost:8790** (the port shown on the start screen). Save.

  Your token is kept only on your computer, encrypted.

**While you're hosting:**
- **This computer *is* the studio.** Keep it on, awake and online until the files are ready. The app stops it
  sleeping, and asks before you close it if anyone's recording, still in the studio, or the files aren't finished.
- **Free space** is shown in the window title, and you're warned if the studio folder is nearly full.
- **If the internet drops,** the call drops but nothing is lost: everyone's recording is kept in their browser and
  uploads when they reconnect. If the guest link had to be remade, the app tells you the new one.
- **To stop hosting:** close the app, or **File › Stop hosting**.
- Everything it needs is built in: ffmpeg, the Cloudflare link and the transcript engine.

---

## Updates

Rolling Desk **updates itself** on Mac, Windows and the Linux AppImage. It checks GitHub when it opens and every
6 hours, and asks you to restart — never during a show. You can also use **File › Check for updates…**. The `.deb`
tells you when there's a new version and opens the download page.

## If something goes wrong

**Send a problem report:** **Help › Save a problem report…** saves one file on your Desktop with what the app did
and any errors — send it on Discord or by email. Keys, tokens, passwords, email addresses and your user name are
taken out first, so it's safe to share. If the app hits a problem, it offers to save one for you.

| What you see | What to do |
|---|---|
| **"The studio couldn't start"** (hosting) | The message says why. Save a problem report (above). The logs are in the app's settings folder (**Help › Open the log folder**): Mac `~/Library/Application Support/Rolling Desk`, Windows `%APPDATA%\Rolling Desk`, Linux `~/.config/Rolling Desk`. |
| **"The studio didn't accept that link"** | Copy **Open studio as host** again from your dashboard — the guest link won't work here. |
| **The app opens straight into an old studio** | It remembers the last one. **File › Connect to a different studio, or host it myself…** |
| **Guests can't hear or see each other** | Ask everyone to use Chrome or Edge. On strict office Wi-Fi, set up the free relay in **Studio settings**. |
| **Want to start completely fresh** | Close the app and delete its settings folder (above). Your recordings aren't in there and are kept. |

What's changed in each version: [desk/CHANGELOG.md](../desk/CHANGELOG.md).
