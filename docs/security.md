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
| Unexpected costs | `stats` on WhatsApp, the Me tab admin card, and the Anthropic / Meta billing pages. Lower `PHOTO_MONTHLY_BUDGET_INR` or `MONTHLY_TEMPLATE_LIMIT` and restart |

To restore a backup onto a fresh install:

```bash
sudo systemctl stop muhallareads
sudo cp /path/to/muhallareads-YYYY-MM-DD.db /var/lib/muhallareads/muhallareads.db
sudo chown muhallareads:muhallareads /var/lib/muhallareads/muhallareads.db
sudo chmod 600 /var/lib/muhallareads/muhallareads.db
sudo systemctl start muhallareads
```
