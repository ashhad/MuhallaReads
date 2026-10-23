# Keeping MohallaReads secure

The library holds members' names, rough locations and WhatsApp numbers, so it's worth keeping
locked down. Most of it is automatic; the checklist below covers the parts only you can do.

Run this on the VM any time to check the server:

```bash
sudo muhallareads-security-check
```

## What protects what

| Threat | Protection |
|---|---|
| Someone pretends to be a member (or an admin) on WhatsApp | Every webhook delivery must be signed by Meta with your app secret; unsigned ones are refused, and the bot won't accept any if `WHATSAPP_APP_SECRET` is empty |
| A stranger joins | Every newcomer, by invite or join code, waits for an admin's approval and can only browse titles until then |
| Phone numbers leaking | Numbers are never sent to the website or to other members (only a number its owner shares on one request). Logs never contain numbers or message text |
| Guessing a sign-in link or session | 192-bit random tokens; sign-in links work once, for 15 minutes; sessions end after 60 days unused; "Sign out on all devices" / `logout everywhere` |
| Malicious page content (XSS) | Everything shown is escaped; a strict Content-Security-Policy blocks injected scripts; the page can't be framed |
| Flooding the server | Request size limits (256 KB; 8 MB for photos). Signed in: 60 requests and 30 book lookups a minute per member. Not signed in: 60 a minute per IP, and 5 failed sign-ins per 15 minutes per IP (successful sign-ins don't count, so neighbours sharing a network aren't locked out) |
| Running up API bills | Photo scans: per-member daily limit, monthly photo and ₹ budget caps, admin alerts. WhatsApp: monthly template cap |
| A member dressing a book title or message up as a notice from the library | Titles and authors are stored as plain text (no WhatsApp *bold*, no line breaks); chat and request notes are relayed as quotes |
| Someone sending you *their* sign-in link, so your books and chats land in their account | The app asks "Switch account?" when a link is for a different account |
| An old Approve button approving the wrong person | Approval buttons and commands carry a tag for that exact person (`approve 12-3fa9`) |
| Approval being skipped | If admins are set but none is active, newcomers keep waiting; `ADMIN_PHONES` works with or without 91 |
| Tracking members via images | Book covers are only accepted from Open Library / archive.org / Google |
| A bug in the app being used to take over the server | The app runs as its own user, can only write to its data folder, has no privileges, can't see other processes, devices or kernel settings (systemd sandbox) |
| Break-in over SSH | Key-only logins, plus a 6-digit code (`deploy/oracle/ssh-mfa.sh`); no passwords; root can't log in over SSH at all (you log in as `ubuntu` and use `sudo`); unused services such as rpcbind are off |
| Unpatched software | Ubuntu installs security updates daily; `npm audit` shows no known issues |
| Losing the data | A daily database backup, kept 14 days, readable only by root and admins |
| Bots attacking the server | CrowdSec blocks addresses that guess SSH logins or probe the site, plus addresses on its community blocklist before they even try (with the [security monitor](#security-monitor)) |
| Not noticing a break-in | The security monitor alerts on SSH logins, changed system files, new open ports and stopped services |

## Your checklist

Do these once; tick them off.

**Accounts: turn on two-factor login everywhere.** Whoever controls one of these controls a part
of the library:

- [ ] **Meta / Facebook** (the account that owns the business portfolio and app): Settings →
  Accounts Centre → Password and security → Two-factor authentication. Also in Business Settings →
  Security Centre, require two-factor for everyone in the business.
- [ ] **Oracle Cloud**: it asks for MFA at sign-up; make sure it's on and you have the recovery codes.
- [ ] **GitHub** (the code): Settings → Password and authentication → Two-factor.
- [ ] **Google** (the Books API key) and **Anthropic** (the photo key): two-factor on both.
- [ ] **DuckDNS**: it signs in with GitHub or Google, so it's covered once those have two-factor.
  Whoever controls DuckDNS could point your address at another server.
- [ ] **Admins' WhatsApp**: admin powers follow the phone number, so every admin should turn on
  WhatsApp → Settings → Account → **Two-step verification**. The bot's own number too (its PIN).

**Keys: give each one as little power as possible.**

- [ ] **Google Books key**: Google Cloud Console → APIs & Services → Credentials → the key →
  *API restrictions*: only "Books API"; *Application restrictions*: IP address: your VM's public IP.
  Then a leaked key is useless elsewhere.
- [ ] **Anthropic key**: Console → Limits → a monthly spend limit (e.g. $4). Use a key made only
  for this server, so you can revoke it without affecting anything else.
- [ ] **WhatsApp token**: a System User token with only `whatsapp_business_messaging` and
  `whatsapp_business_management`, for this one app and WhatsApp account.
- [ ] Keys live **only** in `/etc/muhallareads/muhallareads.env` on the VM. Never paste them in a
  chat, an email, a screenshot or the repository.

**Oracle network.**

- [ ] VCN → Security List → Ingress rules: only TCP 22, 80 and 443 from `0.0.0.0/0`. Delete
  anything else.

**Monitoring.**

- [ ] Turn on the [security monitor](#security-monitor): `sudo bash deploy/oracle/soc-setup.sh`.
- [ ] Set `SOC_NTFY_URL` (instant alerts) and `SOC_HEALTHCHECK_URL` (hear if the server dies).

**Habits.**

- [ ] Every month or so: `sudo muhallareads-security-check`, and `sudo reboot` if it says a
  restart is needed.
- [ ] Approve only people you, or the person who invited them, actually know.

## If something goes wrong

| What happened | Do this |
|---|---|
| A member lost their phone | They (or you) send `logout everywhere` from their WhatsApp, or tap "Sign out on all devices" in the app on another device |
| Someone unwanted got in | `remove member 12` (see `members` for the number); they can't rejoin without a new approval |
| A key or token leaked | Revoke it at the source first (Meta: Business Settings → System users → Revoke tokens; Google: delete the key; Anthropic: delete the key), make a new one, put it in the settings file, `sudo systemctl restart muhallareads` |
| The WhatsApp app secret leaked | developers.facebook.com → your app → App settings → Basic → *Reset* App secret, then update `WHATSAPP_APP_SECRET` and restart |
| You think the VM was broken into | Don't log in to other accounts from it. Copy the latest backup off it, make a new VM, run `setup.sh`, restore the database, rotate **every** key above, and point DuckDNS at the new VM |
| An alert you don't recognise | See [the security monitor's alerts](#what-to-do-about-an-alert) |
| Unexpected costs | `stats` on WhatsApp, the Me tab admin card, and the Anthropic / Meta billing pages. Lower `PHOTO_MONTHLY_BUDGET_INR` or `MONTHLY_TEMPLATE_LIMIT` and restart |

## Security monitor

A small security operations centre (SOC) that runs on the VM itself, for free:

```bash
sudo bash deploy/oracle/soc-setup.sh
```

It uses about 150 MB of memory and a few seconds of CPU every 10 minutes.

| What it watches | What happens |
|---|---|
| Bots guessing SSH logins, scanning the site for secret files or admin pages, trying known exploits | [CrowdSec](https://www.crowdsec.net) blocks the address in the firewall for 4 hours. Addresses on its free community blocklist are blocked before they try. Counted in the daily report |
| Every SSH login, and a login with the right key but the wrong 6-digit code | Alert |
| Changed system files: users, sudo, SSH, PAM, cron, services, Caddy, the settings file, the app's code and libraries | Alert (updates with `setup.sh` don't count) |
| A new program listening on a network port | Alert |
| A service stopping, the server restarting | Alert |
| Disk or memory running out, the HTTPS certificate not renewing | Alert |
| Floods of faked WhatsApp webhooks, app errors, a heavy attack | Alert |
| The last 24 hours: visits, blocked attackers, SSH, disk, backups, plus the full security check | Report every morning at 08:55 |

**Where alerts go** (at most 20 an hour):

- **WhatsApp**, from the bot, to every admin. Only free messages: straight away if you've messaged
  the bot in the last 24 hours, otherwise alerts wait and arrive the next time you do (never a paid
  template). The morning report is only sent when it's free; send `security` to the bot any time to
  read the latest one.
- **ntfy** (recommended, free): install the ntfy app, subscribe to a long random topic, and put
  `SOC_NTFY_URL=https://ntfy.sh/<topic>` in the settings file. Alerts then arrive instantly.
- **healthchecks.io** (free): make a check with a 10-minute period and 20-minute grace, and put its
  ping URL in `SOC_HEALTHCHECK_URL`. It emails you if the server stops checking in (crashed, deleted,
  out of disk).
- Optional, also free: an [UptimeRobot](https://uptimerobot.com) monitor for your site's address
  (tells you when the site is down from the outside), and the CrowdSec Console dashboard
  (app.crowdsec.net, then `sudo cscli console enroll <key>`).

**On the server:**

```bash
sudo muhallareads-soc               # is everything running?
sudo muhallareads-soc report        # today's report, now
sudo muhallareads-soc test          # send a test alert
sudo muhallareads-soc bans          # who is blocked, and why
sudo muhallareads-soc unban 1.2.3.4 # unblock an address
sudo muhallareads-soc log           # recent alerts
```

### What to do about an alert

| Alert | Do this |
|---|---|
| 🔐 SSH login you didn't make | Someone has your key **and** your code. Follow "You think the VM was broken into" above, and make a new SSH key and authenticator code |
| ⚠️ Right key, wrong code | Fine if it was you mistyping. If not, your SSH key is stolen: remove it from `~/.ssh/authorized_keys` (add a new one first) |
| 📝 Files changed | Fine if you just edited that file, or if it says packages were updated. Otherwise compare the app with the repository: `sudo diff -r --exclude=node_modules --exclude=.git ~/MuhallaReads /opt/muhallareads`, and treat unknown changes to users, SSH or cron as a break-in |
| 🚪 New program listening | Fine if you just installed something. Otherwise find it with `sudo ss -tlnp` and treat it as a break-in |
| ❌ A service stopped | `sudo journalctl -u <service> -n 30`, then `sudo systemctl restart <service>` |
| 🎭 Faked webhooks | Nothing to do: they're rejected. If it continues, rotate the app secret (see above) |
| 🚨 Heavy attack | Usually bots; CrowdSec is already blocking them. Check the site still loads |

**A member can't open the site at all?** They may share a mobile network address with an attacker.
`sudo muhallareads-soc bans` shows who is blocked; `sudo muhallareads-soc unban <address>` lets them
back in (blocks also end by themselves after 4 hours).

**Blocked yourself?** (e.g. several wrong codes) Connect from another network, such as your phone's
hotspot or Oracle's Cloud Shell, and unban your address; or wait 4 hours. Addresses in
`SOC_TRUSTED_IPS` are never blocked (re-run `setup.sh` after changing it).

**Privacy.** The web log keeps visitors' addresses, the pages they open and when, for 7 days. It
leaves out sign-in tokens, cookies, searches, book look-ups and invite codes. CrowdSec shares the
addresses that attack the server (and how) with its community network, and nothing else.

**Turning it off:** `sudo rm /etc/muhallareads/soc.enabled`, re-run `setup.sh`, then
`sudo apt remove crowdsec crowdsec-firewall-bouncer-nftables`.

## Restoring a backup

To restore a backup onto a fresh install:

```bash
sudo systemctl stop muhallareads
sudo cp /path/to/muhallareads-YYYY-MM-DD.db /var/lib/muhallareads/muhallareads.db
sudo chown muhallareads:muhallareads /var/lib/muhallareads/muhallareads.db
sudo chmod 600 /var/lib/muhallareads/muhallareads.db
sudo systemctl start muhallareads
```
