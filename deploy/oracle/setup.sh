#!/usr/bin/env bash
# Installs (or updates) MuhallaReads on an Ubuntu server such as an Oracle Cloud Always Free VM.
#
#   First time:  sudo bash deploy/oracle/setup.sh yourname.duckdns.org
#   Update:      git pull && sudo bash deploy/oracle/setup.sh
#
# What it does: installs Node.js 22 and Caddy (automatic HTTPS), copies the app to /opt/muhallareads,
# runs it as a systemd service, opens ports 80/443 in the VM firewall, and sets up daily backups.
# Also keeps the security monitor up to date once deploy/oracle/soc-setup.sh has turned it on.
# Safe to run again; it only changes what's needed.
set -euo pipefail

APP_DIR=/opt/muhallareads
DATA_DIR=/var/lib/muhallareads
CONF_DIR=/etc/muhallareads
ENV_FILE=$CONF_DIR/muhallareads.env
APP_USER=muhallareads
PORT=3000
REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Please run with sudo:  sudo bash $0 ${1:-yourname.duckdns.org}"
[[ -f $REPO_DIR/package.json ]] || die "Run this from inside the MuhallaReads folder."
command -v apt-get >/dev/null || die "This script needs Ubuntu (pick the Canonical Ubuntu image on Oracle Cloud)."

mkdir -p "$CONF_DIR"
# The security monitor (deploy/oracle/soc-setup.sh), if it's on.
SOC_STATE=/var/lib/muhallareads-soc
SOC=$([[ -f $CONF_DIR/soc.enabled ]] && echo on || true)
# Tell it an update is running, so the files and services this changes don't raise alarms.
[[ -d $SOC_STATE ]] && touch "$SOC_STATE/updating"
DOMAIN=${1:-$(cat "$CONF_DIR/domain" 2>/dev/null || true)}
DOMAIN=${DOMAIN#https://}
DOMAIN=${DOMAIN%%/*}
[[ -n $DOMAIN ]] || die "Usage: sudo bash $0 yourname.duckdns.org"
echo "$DOMAIN" > "$CONF_DIR/domain"

step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg rsync sqlite3 openssl iptables-persistent \
  debian-keyring debian-archive-keyring apt-transport-https >/dev/null

node_ok() {
  command -v node >/dev/null &&
    node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'
}
if ! node_ok; then
  step "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "Node $(node --version)"

if ! command -v caddy >/dev/null; then
  step "Installing Caddy (handles HTTPS certificates automatically)"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
    gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

# The 1 GB "Micro" VM is tight for npm installs; a swap file prevents out-of-memory failures.
if [[ ! -f /swapfile ]] && (( $(awk '/MemTotal/ {print $2}' /proc/meminfo) < 2000000 )); then
  step "Adding 2 GB swap"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

step "Opening ports 80 and 443 in the VM firewall"
# Oracle's Ubuntu images ship iptables rules that reject everything except SSH.
for p in 80 443; do
  iptables -C INPUT -p tcp --dport "$p" -m state --state NEW -j ACCEPT 2>/dev/null ||
    iptables -I INPUT 1 -p tcp --dport "$p" -m state --state NEW -j ACCEPT
done
netfilter-persistent save >/dev/null
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi

step "Installing the app to $APP_DIR"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$DATA_DIR"
rsync -a --delete --exclude .git --exclude node_modules --exclude data --exclude .env "$REPO_DIR"/ "$APP_DIR"/
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chown -R root:root "$APP_DIR"
chown "$APP_USER:$APP_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

if [[ ! -f $ENV_FILE ]]; then
  step "Creating settings file $ENV_FILE"
  sed -e "s#^PORT=.*#PORT=$PORT#" \
      -e "s#^DATA_DIR=.*#DATA_DIR=$DATA_DIR#" \
      -e "s#^WHATSAPP_VERIFY_TOKEN=.*#WHATSAPP_VERIFY_TOKEN=$(openssl rand -hex 16)#" \
      "$APP_DIR/.env.example" > "$ENV_FILE"
fi
sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=https://$DOMAIN#" "$ENV_FILE"
chown root:"$APP_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

step "Starting the service"
install -m 644 "$APP_DIR/deploy/oracle/muhallareads.service" /etc/systemd/system/muhallareads.service
systemctl daemon-reload
systemctl enable muhallareads >/dev/null 2>&1
systemctl restart muhallareads

CADDY_LOG=''
if [[ -n $SOC ]]; then
  install -d -m 755 -o caddy -g caddy /var/log/caddy
  [[ -f /var/log/caddy/access.log ]] || install -m 640 -o caddy -g adm /dev/null /var/log/caddy/access.log
  # Read by CrowdSec to spot attacks. Visitors' addresses are kept 7 days; sign-in tokens, cookies, and
  # what people search for, look up or join with are left out.
  CADDY_LOG=$(cat <<'LOG'
	log {
		output file /var/log/caddy/access.log {
			roll_size 20MiB
			roll_keep 3
			roll_keep_for 168h
		}
		format filter {
			wrap json
			fields {
				request>headers>Authorization delete
				request>headers>Cookie delete
				request>headers>Referer delete
				resp_headers>Set-Cookie delete
				request>uri query {
					delete q
					delete isbn
					delete title
					delete author
					delete join
					delete hub.verify_token
					delete hub.challenge
				}
			}
		}
	}
LOG
)
fi
write_caddyfile() {
  cat > /etc/caddy/Caddyfile.new <<CADDY
$DOMAIN {
	encode gzip
	header {
		# Browsers only ever use HTTPS for this site from now on.
		Strict-Transport-Security "max-age=31536000"
		-Server
	}
	# Nothing the app accepts is bigger than a photo upload.
	request_body {
		max_size 10MB
	}
$1
	reverse_proxy 127.0.0.1:$PORT
}
CADDY
}
write_caddyfile "$CADDY_LOG"
if [[ -n $CADDY_LOG ]] && ! caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile >/dev/null 2>&1; then
  echo "This Caddy version didn't accept the access-log settings, so the web log is off (SSH is still watched)."
  write_caddyfile ''
fi
mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
systemctl enable caddy >/dev/null 2>&1
systemctl reload-or-restart caddy

install -m 755 "$APP_DIR/deploy/oracle/backup.sh" /etc/cron.daily/muhallareads-backup
# Backups hold members' phone numbers: only root and the admin group (adm) may read them.
install -d -m 750 -o root -g adm /var/backups/muhallareads
chmod 640 /var/backups/muhallareads/*.db 2>/dev/null || true
# The database too: only the app's own user.
chmod 600 "$DATA_DIR"/*.db* 2>/dev/null || true

step "Locking down SSH and unused services"
# Root never logs in over SSH: you log in as ubuntu and use sudo. (Root isn't renamed; Ubuntu relies on
# that name.) The change is checked with sshd -t before it takes effect, so it can't lock you out.
SSH_DROPIN=/etc/ssh/sshd_config.d/05-muhallareads.conf
# Only if you can still get in afterwards: you ran this with sudo as a normal user who logs in with a key.
ADMIN_USER=${SUDO_USER:-}
ADMIN_KEYS=$( [[ -n $ADMIN_USER && $ADMIN_USER != root ]] && getent passwd "$ADMIN_USER" | cut -d: -f6)/.ssh/authorized_keys
if [[ -z $ADMIN_USER || $ADMIN_USER == root || ! -s $ADMIN_KEYS ]]; then
  echo "Skipping the SSH lock-down: run setup.sh with sudo from your normal login (e.g. ubuntu) that uses an SSH key."
elif grep -qiE '^\s*Include\s+/etc/ssh/sshd_config\.d/' /etc/ssh/sshd_config; then
  printf '%s\n' '# Written by MuhallaReads setup.sh' 'PermitRootLogin no' 'PasswordAuthentication no' > "$SSH_DROPIN"
  if sshd -t 2>/dev/null; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
  else
    rm -f "$SSH_DROPIN"
    echo "SSH settings didn't check out, so SSH was left unchanged."
  fi
fi
# rpcbind (port 111) is only needed for NFS network drives, which this server doesn't use.
if ! findmnt -rn -t nfs,nfs4 >/dev/null 2>&1; then
  systemctl disable --now rpcbind.socket rpcbind.service >/dev/null 2>&1 || true
  systemctl mask rpcbind.socket rpcbind.service >/dev/null 2>&1 || true
fi

# Security updates install automatically (Ubuntu's default; make sure it's on).
apt-get install -y -qq unattended-upgrades >/dev/null
echo 'APT::Periodic::Update-Package-Lists "1"; APT::Periodic::Unattended-Upgrade "1";' > /etc/apt/apt.conf.d/20auto-upgrades

install -m 755 "$APP_DIR/deploy/oracle/security-check.sh" /usr/local/bin/muhallareads-security-check

PUBLIC_IP=$(curl -fs -m 5 https://api.ipify.org || true)
SOC_LIB=/usr/local/lib/muhallareads-soc
SOC_UNITS="muhallareads-soc-watch.service muhallareads-soc-watch.timer muhallareads-soc-report.service muhallareads-soc-report.timer"
if [[ -n $SOC ]]; then
  step "Updating the security monitor"
  install -d -m 755 "$SOC_LIB"
  install -d -m 700 "$SOC_STATE"
  # So the daily report can leave out the server's own visits (its security check).
  [[ -n $PUBLIC_IP ]] && echo "$PUBLIC_IP" > "$SOC_STATE/self-ip"
  install -m 644 "$APP_DIR/deploy/oracle/soc/lib.sh" "$SOC_LIB/lib.sh"
  install -m 755 "$APP_DIR/deploy/oracle/soc/watch.sh" "$APP_DIR/deploy/oracle/soc/report.sh" "$SOC_LIB/"
  install -m 755 "$APP_DIR/deploy/oracle/soc/soc.sh" /usr/local/bin/muhallareads-soc
  for u in $SOC_UNITS; do install -m 644 "$APP_DIR/deploy/oracle/soc/$u" /etc/systemd/system/; done
  cat > /etc/logrotate.d/muhallareads-caddy <<'ROTATE'
# The web access log for the security monitor: one file a day, kept 7 days.
/var/log/caddy/access.log {
	su caddy caddy
	daily
	rotate 6
	maxage 7
	missingok
	notifempty
	compress
	delaycompress
	copytruncate
}
ROTATE

  if [[ -d /etc/crowdsec ]]; then
    # Whether CrowdSec already reads a log (its installer may have found it), not counting our own files.
    acquired() {
      local f
      for f in /etc/crowdsec/acquis.yaml /etc/crowdsec/acquis.d/*.yaml; do
        [[ -f $f && $f != */muhallareads-* ]] && grep -qs "$1" "$f" && return 0
      done
      return 1
    }
    install -d /etc/crowdsec/acquis.d /etc/crowdsec/parsers/s02-enrich
    if acquired /var/log/caddy; then
      rm -f /etc/crowdsec/acquis.d/muhallareads-caddy.yaml
    else
      printf '%s\n' '# Written by MuhallaReads setup.sh' 'filenames:' '  - /var/log/caddy/access.log' 'labels:' '  type: caddy' \
        > /etc/crowdsec/acquis.d/muhallareads-caddy.yaml
    fi
    if acquired 'auth\.log\|_SYSTEMD_UNIT=ssh'; then
      rm -f /etc/crowdsec/acquis.d/muhallareads-ssh.yaml
    elif [[ -f /var/log/auth.log ]]; then
      printf '%s\n' '# Written by MuhallaReads setup.sh' 'filenames:' '  - /var/log/auth.log' 'labels:' '  type: syslog' \
        > /etc/crowdsec/acquis.d/muhallareads-ssh.yaml
    else
      printf '%s\n' '# Written by MuhallaReads setup.sh' 'source: journalctl' 'journalctl_filter:' '  - "_SYSTEMD_UNIT=ssh.service"' \
        'labels:' '  type: syslog' > /etc/crowdsec/acquis.d/muhallareads-ssh.yaml
    fi
    # Never block this server itself (its daily security check visits the site from here, and pokes at
    # it like an attacker would), the private network, or the admins' SOC_TRUSTED_IPS.
    trusted=("127.0.0.0/8" "::1/128" "10.0.0.0/8")
    for ip in $PUBLIC_IP $(grep -E '^SOC_TRUSTED_IPS=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr ",\"'" '   '); do
      if [[ $ip =~ ^[0-9.]+(/[0-9]{1,2})?$ ]]; then trusted+=("$ip"); [[ $ip == */* ]] || trusted[-1]+=/32
      elif [[ $ip =~ ^[0-9a-fA-F:]+(/[0-9]{1,3})?$ ]]; then trusted+=("$ip"); [[ $ip == */* ]] || trusted[-1]+=/128
      else echo "Ignoring \"$ip\" in SOC_TRUSTED_IPS (not an address)"
      fi
    done
    {
      echo '# Written by MuhallaReads setup.sh (re-run it after changing SOC_TRUSTED_IPS)'
      echo 'name: muhallareads/whitelist'
      echo 'description: "This server and the admins trusted addresses"'
      echo 'whitelist:'
      echo '  reason: "this server or a trusted address"'
      echo '  cidr:'
      printf '    - "%s"\n' "${trusted[@]}"
    } > /etc/crowdsec/parsers/s02-enrich/muhallareads-whitelist.yaml
    if crowdsec -t >/dev/null 2>&1; then
      systemctl reload-or-restart crowdsec
    else
      rm -f /etc/crowdsec/acquis.d/muhallareads-*.yaml /etc/crowdsec/parsers/s02-enrich/muhallareads-whitelist.yaml
      echo "CrowdSec didn't accept the new settings, so they were left out. See: sudo crowdsec -t"
    fi
  fi
  systemctl daemon-reload
  systemctl enable --now muhallareads-soc-watch.timer muhallareads-soc-report.timer >/dev/null 2>&1
elif [[ -f /etc/systemd/system/muhallareads-soc-watch.timer ]]; then
  systemctl disable --now muhallareads-soc-watch.timer muhallareads-soc-report.timer >/dev/null 2>&1 || true
fi

# Admin helper: sudo muhallareads-login <whatsapp number> [display name]  → one-time website sign-in link
cat > /usr/local/bin/muhallareads-login <<'HELPER'
#!/bin/sh
exec systemd-run --quiet --pipe --wait -p User=muhallareads -p EnvironmentFile=/etc/muhallareads/muhallareads.env \
  -p WorkingDirectory=/opt/muhallareads /usr/bin/node --disable-warning=ExperimentalWarning scripts/login-link.js "$@"
HELPER
chmod 755 /usr/local/bin/muhallareads-login

for _ in $(seq 1 20); do
  curl -fs "http://127.0.0.1:$PORT/api/config" >/dev/null && break
  sleep 1
done
curl -fs "http://127.0.0.1:$PORT/api/config" >/dev/null ||
  die "The app didn't start. See the log with:  journalctl -u muhallareads -n 50"

# Everything this update changed is now the normal state the security monitor compares against.
[[ -n $SOC ]] && "$SOC_LIB/watch.sh" --rebaseline
[[ -n $PUBLIC_IP ]] || PUBLIC_IP="your VM's public IP"
if [[ -n $SOC ]]; then MONITOR="sudo muhallareads-soc   (CrowdSec, alerts, daily report)"
else MONITOR="off; turn it on with: sudo bash deploy/oracle/soc-setup.sh"; fi
cat <<DONE

✅ MuhallaReads is running.

  Web app:   https://$DOMAIN
             (make sure $DOMAIN points to $PUBLIC_IP; the HTTPS certificate is
              issued automatically within a minute after that)
  Settings:  sudo nano $ENV_FILE
             then: sudo systemctl restart muhallareads
  Sign-in:   sudo muhallareads-login <your number> "Your name"   (website link, no WhatsApp needed)
  Logs:      journalctl -u muhallareads -f
  Backups:   /var/backups/muhallareads (daily, kept 14 days)
  Update:    git pull && sudo bash deploy/oracle/setup.sh
  Security:  sudo muhallareads-security-check
  Monitor:   $MONITOR
DONE
