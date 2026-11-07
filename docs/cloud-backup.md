# Cloud backup (Google Drive, Dropbox, OneDrive…)

Rolling can upload every finished take to your cloud storage, as well as (or instead of) a backup drive. It
happens in the background after the files are made, so it never holds up the next recording. If the internet
drops, it tries again by itself; the Recordings page shows ☁️ **In the cloud**, or **Upload again** if it failed.

It uses [rclone](https://rclone.org), a free program that talks to over 70 cloud services. The installer adds it.
You set up your account once, on the server.

**Space:** about 4 GB per person per hour. A free Google Drive (15 GB) fills up fast — a paid plan or a big
Dropbox/OneDrive is best for regular shows.

---

## Step 1 — Connect your cloud account (once)

Your server has no screen, so rclone asks you to sign in on another computer that has a web browser. It takes
about 5 minutes.

1. **On your own computer** (Mac, Windows or Linux), install rclone: [rclone.org/downloads](https://rclone.org/downloads/).
   On a Mac with Homebrew: `brew install rclone`.
2. **On the server**, run:
   ```bash
   rclone config
   ```
   and answer:
   - `n` (new remote) → name: **gdrive** (or `dropbox`, `onedrive` — any short name)
   - Storage: type **drive** for Google Drive, **dropbox** for Dropbox, **onedrive** for OneDrive
   - Press **Enter** to skip `client_id`, `client_secret` and the other questions with a default
   - Google Drive: scope **1** (full access)
   - "Edit advanced config?" → `n`
   - "Use web browser to automatically authenticate?" → **`n`** (the server has no browser)
3. rclone shows a command like `rclone authorize "drive" "eyJ…"`. **Copy it and run it on your own computer.** A
   browser opens: sign in to your account and allow access.
4. Your computer prints a long code (`{"access_token": …}`). Copy all of it, paste it back into the server's
   `rclone config`, then answer `y` to keep the remote and `q` to quit.

Check it worked: `rclone lsd gdrive:` lists the folders in your cloud.

> Run `rclone config` as the same user the studio runs as (the user you installed with), so the studio can use it.

## Step 2 — Turn it on in Rolling

1. On your dashboard, open **Studio settings** › **☁️ Cloud backup**.
2. Type your remote and a folder, e.g. **`gdrive:Rolling`** (remote name, a colon, then the folder).
3. Press **Test cloud backup** — you should see ✓ **Cloud backup works**.

From now on, each finished take is uploaded to `Rolling/<show name>/Take N - <date and time>/`.

## If it goes wrong

| What you see | What to do |
|---|---|
| "There's no rclone remote called …" | The name before the colon must match the one you chose in `rclone config` (it lists yours). |
| "rclone isn't installed" | Re-run the installer, or `sudo apt install rclone`. |
| "Cloud upload failed" on a take | Hover over it to see why. Check the internet and free space in your cloud, then press **Upload again**. |
| Sign-in expired (after months) | Run `rclone config reconnect gdrive:` on the server and follow step 3 again. |

> Hosting from **Rolling Desk** on your own computer? Simply choose a studio folder inside your Dropbox, Google
> Drive or OneDrive folder — their own app uploads it for you.
