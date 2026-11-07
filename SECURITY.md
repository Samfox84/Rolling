# Security

Rolling is run by people for their own shows, so keeping it safe matters. Thank you for helping.

## Found a security problem?

**Please don't post it publicly.** Use GitHub's private report instead: on the
[Security tab](https://github.com/Samfox84/Rolling/security), press **Report a vulnerability**. Only the
maintainer sees it. Say what you found and how to repeat it; we'll reply as soon as we can and credit you in the
changelog if you'd like.

## How Rolling keeps things safe

- **Links are the keys.** A show's host link (with `?k=…`) lets someone run that show — share it only with your
  presenter or producer. Guest links can only join, and with the waiting room on, the host lets each guest in.
- **The dashboard** needs the admin password; logins are slowed down after wrong guesses.
- **The studio listens on this computer only** (`127.0.0.1`); the internet reaches it through your HTTPS tunnel or
  web server, never directly.
- **Nothing secret is in this project's files.** Passwords live in `/opt/podcast-studio/.env` on your server, and
  Rolling Desk keeps its tunnel token encrypted on your computer.
- **Problem reports** from Rolling Desk (Help › Save a problem report) have keys, tokens, passwords, email
  addresses and your user name removed before they're saved.
- **Updates:** GitHub checks Rolling's building blocks every week and flags any with a known security problem
  ([Dependabot](.github/dependabot.yml)); the tests run on every change.

## Keeping your studio up to date

```bash
cd ~/Rolling && git pull && sudo bash install.sh
```
