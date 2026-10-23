# Free hosting on Oracle Cloud

This guide puts MuhallaReads on an Oracle Cloud **Always Free** virtual machine, with free HTTPS
and a free web address. Allow about 30–45 minutes the first time.

You'll end up with:

- the app at `https://yourname.duckdns.org`
- HTTPS certificates that renew themselves (via [Caddy](https://caddyserver.com))
- the app restarting by itself after crashes or reboots
- a daily backup of the catalogue

## 1. Create the virtual machine

In the Oracle Cloud console: **☰ → Compute → Instances → Create instance**.

| Setting | Choose |
|---|---|
| Name | `muhallareads` |
| Image | **Canonical Ubuntu 24.04** (click *Change image*). Not Oracle Linux: the setup script needs Ubuntu. |
| Shape | **Ampere → VM.Standard.A1.Flex**, 1 OCPU and 6 GB memory. If you get "Out of capacity", try another *availability domain*, or use **AMD → VM.Standard.E2.1.Micro**. Both are labelled *Always Free-eligible*. |
| Networking | Create a new virtual cloud network and public subnet (the defaults), with **Assign a public IPv4 address** on |
| SSH keys | **Generate a key pair for me** → **Save private key**. Keep this file safe: it's how you log in. |

Click **Create**. When the instance is *Running*, copy its **Public IP address**.

Free resources only exist in your account's *home region* (e.g. Mumbai or Hyderabad), so create
the VM there.

## 2. Open the web ports in Oracle's firewall

Oracle blocks web traffic by default. On the instance page, click the **subnet** link, then
**Security → Security Lists → Default Security List → Add Ingress Rules**:

- Source CIDR: `0.0.0.0/0`
- IP Protocol: `TCP`
- Destination Port Range: `80,443`

Save. (The VM also has its own firewall. The setup script opens that one for you.)

## 3. Get a free web address

1. Go to <https://www.duckdns.org> and sign in (Google or GitHub).
2. Type a subdomain, e.g. `ourmuhallabooks`, and click **add domain**.
3. In the **current ip** box, paste the VM's public IP and click **update ip**.

Your address is now `ourmuhallabooks.duckdns.org`. If you already own a domain, add an `A` record
pointing to the VM's IP instead.

## 4. Log in to the VM

From a terminal: on Windows, use PowerShell; on a Mac, the Terminal app.

```bash
ssh -i path/to/ssh-key.key ubuntu@YOUR_VM_IP
```

On Mac or Linux, if ssh complains about permissions, run `chmod 600 path/to/ssh-key.key` first.
On Windows, keep the key in your user folder (e.g. `C:\Users\you\.ssh\`).

## 5. Download the code

**If the GitHub repo is public:**

```bash
git clone https://github.com/ashhad/MuhallaReads.git
```

**If it's private**, give the VM a read-only *deploy key*:

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
cat ~/.ssh/id_ed25519.pub
```

Copy the line it prints. On GitHub go to **repo → Settings → Deploy keys → Add deploy key**, paste
it, and leave *Allow write access* off. Then:

```bash
git clone git@github.com:ashhad/MuhallaReads.git
```

## 6. Run the setup script

Use your own address in place of the example:

```bash
cd MuhallaReads
sudo bash deploy/oracle/setup.sh ourmuhallabooks.duckdns.org
```

It takes a few minutes. When it prints **✅ MuhallaReads is running**, open
`https://ourmuhallabooks.duckdns.org` on your phone. The first visit can take up to a minute
while the HTTPS certificate is issued.

## 7. Settings

```bash
sudo nano /etc/muhallareads/muhallareads.env
```

The values most people set:

```
COMMUNITY_NAME=Our Muhalla Library
JOIN_CODE=books2026
ADMIN_PHONES=919812345678
ANTHROPIC_API_KEY=sk-ant-...
```

- `JOIN_CODE`: neighbours send `join books2026` to the bot to get in, so share it in your group.
- `ADMIN_PHONES`: your own WhatsApp number with country code, so you can send `stats` to the bot.
- `ANTHROPIC_API_KEY`: optional; turns on shelf-photo scanning.

Don't add comments after a value on the same line: they would become part of the value.

Save with `Ctrl+O`, Enter, `Ctrl+X`. Then restart the app:

```bash
sudo systemctl restart muhallareads
```

For WhatsApp, follow **WhatsApp setup** in the README. Your webhook URL is
`https://ourmuhallabooks.duckdns.org/webhooks/whatsapp`. The setup script already generated a
`WHATSAPP_VERIFY_TOKEN` and filled in `PUBLIC_URL` in the settings file: copy the verify token
into Meta's webhook form. Leave `WHATSAPP_TEMPLATES=off` until Meta approves the templates in
[whatsapp-templates.md](whatsapp-templates.md).

To sign in to the website before WhatsApp is set up, create a one-time link on the VM:

```bash
sudo muhallareads-login 9812345678 "Your name"
```

## Everyday tasks

| Task | Command (on the VM) |
|---|---|
| Update to the latest code | `cd ~/MuhallaReads && git pull && sudo bash deploy/oracle/setup.sh` |
| Website sign-in link without WhatsApp | `sudo muhallareads-login 9812345678 "Name"` |
| See what the app is doing | `journalctl -u muhallareads -f` (Ctrl+C to stop) |
| Restart | `sudo systemctl restart muhallareads` |
| List backups | `ls /var/backups/muhallareads` |

**Copy a backup to your laptop** once in a while. Backups on the VM don't help if the VM itself
is lost. Run this on your laptop:

```bash
scp -i path/to/ssh-key.key "ubuntu@YOUR_VM_IP:/var/backups/muhallareads/*.db" .
```

**Restore a backup** (on the VM):

```bash
sudo systemctl stop muhallareads
sudo cp /var/backups/muhallareads/muhallareads-2026-10-18.db /var/lib/muhallareads/muhallareads.db
sudo rm -f /var/lib/muhallareads/muhallareads.db-wal /var/lib/muhallareads/muhallareads.db-shm
sudo chown muhallareads:muhallareads /var/lib/muhallareads/muhallareads.db
sudo systemctl start muhallareads
```

## Security

See [security.md](security.md) for what's protected and a short checklist (two-factor on your
accounts, restricting the API keys). Check the server any time with `sudo muhallareads-security-check`.

## Two-factor SSH (recommended)

Make logging in to the VM need **both** your SSH key **and** a 6-digit code from an authenticator
app on your phone, so a stolen key alone isn't enough:

```bash
cd ~/MuhallaReads && git pull
sudo bash deploy/oracle/ssh-mfa.sh
```

It shows a QR code: scan it with Google Authenticator, Microsoft Authenticator, Aegis or similar,
and **write down the emergency scratch codes** it prints (each logs you in once if you lose your
phone). Keep that SSH window open, log in from a second terminal to check the code works, and only
then close the first one. If the new login fails, run `sudo bash deploy/oracle/ssh-mfa.sh --undo` in
the window that's still open.

**Before you start, give your user a password** with `sudo passwd ubuntu`. SSH still won't accept it
(that stays key + code), but it's what lets you in through Oracle's rescue console if you're ever
locked out: Compute → Instances → your VM → **Console connection** → Launch Cloud Shell connection,
log in as `ubuntu` with that password, and run `sudo bash ~/MuhallaReads/deploy/oracle/ssh-mfa.sh --undo`.

## Security monitor (recommended)

A small security operations centre that runs on the VM for free: CrowdSec blocks attackers in the
firewall, and you get alerts (SSH logins, changed system files, new open ports, stopped services, a
certificate that isn't renewing) and a short report every morning:

```bash
cd ~/MuhallaReads && git pull
sudo bash deploy/oracle/soc-setup.sh
```

Alerts come on WhatsApp from the bot (free messages only). For instant alerts on your phone, run
`sudo muhallareads-soc ntfy`; to hear if the server dies, `sudo muhallareads-soc healthcheck` (both
free, steps in security.md). See [security.md](security.md#security-monitor) for what it watches and
what to do about an alert. `sudo muhallareads-soc` shows its status.

## Keeping it free

- **The VM** costs nothing while you stay within Always Free limits. Oracle may *reclaim* Always
  Free VMs that sit nearly idle for a week. A small community app is mostly idle, so this can
  happen. To prevent it, upgrade the account to **Pay As You Go** (Billing → Upgrade). You still
  pay nothing for Always Free resources. Also set a **budget alert** (Billing → Budgets) at, say,
  ₹100, so any accidental charge emails you. Either way, keep a backup copy on your laptop.
- **WhatsApp:** replies to people who messaged the bot recently are free (first 1,000 a month).
  Telling someone about a request while they're away costs about ₹0.14, capped by
  `MONTHLY_TEMPLATE_LIMIT` (default 200 ≈ ₹27 a month). A pilot typically costs ₹5–15 a month.
  Send `stats` to the bot to see this month's usage.
- **Photo scanning** costs money too. Each photo is one Claude API call: about ₹0.10 with the
  default Haiku model, ₹2 with `CLAUDE_MODEL=claude-sonnet-5-5`, ₹4 with `claude-opus-5-5`. Hard
  limits keep it small: `PHOTO_DAILY_LIMIT` (10 per member a day), `PHOTO_MONTHLY_LIMIT` (300 a
  month) and `PHOTO_MONTHLY_BUDGET_INR` (default ₹90 a month; costs are converted from dollars at `USD_INR_RATE`, default 88), after which scanning pauses until the
  1st. Admins are messaged on WhatsApp at 50%, 80% and 100%. As a backstop, also set a monthly
  spend limit in the Anthropic Console (Settings → Limits). To turn it off, leave
  `ANTHROPIC_API_KEY` empty. Typing and barcode scanning are always free.

## Troubleshooting

| Problem | Check |
|---|---|
| Site doesn't load at all | The ingress rule from step 2 exists; `ping yourname.duckdns.org` shows the VM's IP |
| Browser says the certificate is invalid | Wait a minute after DNS points to the VM, then `journalctl -u caddy -n 50` |
| "Something went wrong" in the app | `journalctl -u muhallareads -n 50` |
| Setup fails during `npm ci` on the Micro VM | Run the script again: it adds swap memory first, which usually fixes it |
| Camera doesn't open | The app must be opened over `https://`, and the browser must be allowed to use the camera |
