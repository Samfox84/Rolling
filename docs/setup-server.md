# Set up Rolling on your own server

This puts your studio on a computer that's always on, at your own web address (like `podcast.yourname.com`).
Guests and hosts just open a link in their browser. This is the best setup for a regular show.

> **Don't have a server?** You can run the whole studio from the Rolling Desk app on your own computer instead —
> see [Host a studio from your computer](setup-desk.md#host-a-studio-on-your-computer-no-server).

**Time:** about 30 minutes. **You'll type:** a few commands, copied from this page.

---

## What you need

| | |
|---|---|
| **A computer that stays on** | Ubuntu 22.04 or newer, or Debian 12 or newer (64-bit). An old laptop, a mini PC or a Raspberry Pi 5 is fine. |
| **Disk space** | About **4 GB per person per hour** of recording. A 1-hour show with 3 people needs about 12 GB. |
| **A web address (domain)** | Any domain you own, added to a **free Cloudflare account**. You'll use a part of it, like `podcast.yourname.com`. |
| **Internet** | Normal home broadband is fine. |

You **don't** need to open ports on your router: Cloudflare Tunnel connects your studio to the internet safely.

---

## Step 1 — Install Rolling

On the server, open a terminal (or connect with SSH) and paste this, changing `podcast.yourname.com` to your own
address:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/Samfox84/Rolling.git
cd Rolling
sudo DOMAIN=podcast.yourname.com STUDIO_NAME="My Podcast Studio" bash install.sh
```

The installer:
- installs everything Rolling needs (ffmpeg, Node.js, the transcript engine and its speech model)
- sets the studio to start by itself whenever the computer starts
- **prints your admin password at the end — write it down.** (Forgot it? `sudo podcast-studio-reset-password`)

It takes 5–15 minutes, mostly building the transcript engine. Don't want transcripts? Add `NO_TRANSCRIBE=1`
before `bash`.

---

## Step 2 — Put it on the internet (Cloudflare Tunnel)

Browsers only allow cameras and microphones on secure (`https://`) web addresses. A Cloudflare Tunnel gives you
one, for free, with no router settings.

**Already have a Cloudflare Tunnel on this computer?** The installer added your address to it in Step 1 —
skip to Step 3.

**Setting one up for the first time:**
1. Log in at **one.dash.cloudflare.com**.
2. Go to **Networks › Tunnels › Create a tunnel**, choose **Cloudflared**, and give it a name (e.g. `studio`).
3. Choose **Debian / 64-bit**. Cloudflare shows a command starting `sudo cloudflared service install …` —
   copy it and paste it into the server's terminal. (If it says `cloudflared: command not found`, paste the
   other install command Cloudflare shows on the same page first.)
4. Back in Cloudflare, press **Next**, then add a **Public hostname**:
   - **Subdomain:** `podcast` · **Domain:** your domain
   - **Type:** `HTTP` · **URL:** `localhost:8790`
5. **Save tunnel.**

Open `https://podcast.yourname.com` — you should see the Rolling login page.

> Using your own web server instead (Caddy or nginx)? Point it at `127.0.0.1:8790` — see the
> [README](../README.md#https).

---

## Step 3 — Your first show

1. Open your studio's address and log in with the admin password.
2. Type a name for your show (e.g. `My Podcast`) and press **Create room**. Each show gets its own room, and it stays
   there for every episode.
3. You get two links:
   - **Open studio as host** — for you (or your presenter). **Keep this one private:** anyone with it can run
     the show.
   - **Guest link** — send this to your guests.
4. Open the host link in **Chrome** on a laptop. Turn on your camera and mic, then **Join studio**. Or choose
   **Run the show from the control room** to produce without being on mic — that gives you the full mixing desk
   (🎛 Console).
5. Guests click their link, check their mic, and knock. You press **Let in** (or **🟢 Green room** to chat first).
6. Press **Start recording**, choose whether to record room tone, and talk. Press **Stop** when you're done.
7. A few minutes later, open **Recordings** to download everything: each person's untouched track, cleaned copies,
   the Producer mix, video, transcripts, chapters, and session files for Audition, Premiere or Resolve.

**Tips for everyone:** Chrome or Edge on a laptop, wired headphones, a quiet room.

---

## Keeping it up to date

New versions are listed in the [changelog](../CHANGELOG.md). To update, on the server:

```bash
cd ~/Rolling && git pull && sudo bash install.sh
```

The installer keeps your settings, password and recordings. Don't update in the middle of a show.

## Looking after it

- **Disk space:** the dashboard's **🩺 Health** panel shows how many hours of recording are left. Delete old takes from
  the Recordings page once you've downloaded them.
- **Backups:** set a backup folder (e.g. a USB drive) in **Studio settings** — every finished take is copied there.
- **Email when ready:** add your email server in **Studio settings** to get an email when a take's files are ready.
- **Something wrong?** `sudo journalctl -u podcast-studio -n 100` shows the studio's recent log.
- **Restart it:** `sudo systemctl restart podcast-studio`

## Want a producer's desk app too?

[Rolling Desk](setup-desk.md) opens your studio's Console in its own window and saves a copy of every recording
on your own computer as well.
