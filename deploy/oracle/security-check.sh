#!/usr/bin/env bash
# Checks the server's security settings and prints PASS / WARN / FAIL for each. Changes nothing, and
# never prints secrets.
#
#   sudo muhallareads-security-check        (installed by setup.sh)
#   sudo bash deploy/oracle/security-check.sh
set -uo pipefail

ENV_FILE=/etc/muhallareads/muhallareads.env
DATA_DIR=/var/lib/muhallareads
BACKUPS=/var/backups/muhallareads
APP_USER=muhallareads

pass=0 warn=0 fail=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$*"; pass=$((pass + 1)); }
meh()  { printf '  \033[33mWARN\033[0m  %s\n' "$*"; warn=$((warn + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fail=$((fail + 1)); }
note() { printf '  \033[36mNOTE\033[0m  %s\n' "$*"; }
section() { printf '\n\033[1m%s\033[0m\n' "$*"; }
setting() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2-; }

[[ $EUID -eq 0 ]] || { echo "Please run with sudo: sudo $0"; exit 1; }

section "SSH"
sshd_t=$(sshd -T 2>/dev/null)
grep -qi '^passwordauthentication no' <<<"$sshd_t" && ok "Passwords can't be used to log in" || bad "Password logins are allowed (set PasswordAuthentication no)"
root_login=$(awk 'tolower($1) == "permitrootlogin" {print tolower($2)}' <<<"$sshd_t")
case $root_login in
  no) ok "Root can't log in over SSH" ;;
  prohibit-password | without-password) meh "Root can log in over SSH with a key (never a password); re-run setup.sh to turn it off" ;;
  *) bad "Root can log in over SSH with a password (PermitRootLogin $root_login)" ;;
esac
grep -qi '^authenticationmethods .*keyboard-interactive' <<<"$sshd_t" && ok "Two-factor SSH is on (key + code)" ||
  meh "Two-factor SSH is off: sudo bash deploy/oracle/ssh-mfa.sh"

section "Updates"
systemctl is-enabled unattended-upgrades >/dev/null 2>&1 && ok "Security updates install automatically" || bad "Automatic security updates are off"
upgradable=$(apt-get -s upgrade 2>/dev/null | grep -c '^Inst .*security' || true)
(( upgradable == 0 )) && ok "No security updates waiting" || meh "$upgradable security update(s) waiting: sudo apt update && sudo apt upgrade"
[[ -f /var/run/reboot-required ]] && meh "A restart is needed to finish updates: sudo reboot" || ok "No restart pending"

section "Network"
public=$(ss -Htlnp 2>/dev/null | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|::1)' | sed -E 's/.*:([0-9]+)$/\1/' | sort -un | tr '\n' ' ')
extra=$(tr ' ' '\n' <<<"$public" | grep -vxE '22|80|443|' | tr '\n' ' ')
[[ -z $extra ]] && ok "Only SSH, HTTP and HTTPS are reachable from outside (${public% })" ||
  bad "Other ports are open to the internet: $extra(close them, or check Oracle's security list)"
ss -Htlnp 2>/dev/null | grep -q '127.0.0.1:3000' && ok "The app listens only on this machine (Caddy in front)" ||
  meh "Couldn't see the app on 127.0.0.1:3000 (is it running?)"

section "App settings"
if [[ -f $ENV_FILE ]]; then
  perms=$(stat -c '%a %U:%G' "$ENV_FILE")
  [[ $perms == "640 root:$APP_USER" ]] && ok "Settings file readable only by root and the app ($perms)" || bad "Settings file permissions are $perms (want 640 root:$APP_USER)"
  [[ -n $(setting WHATSAPP_APP_SECRET) ]] && ok "WhatsApp messages must be signed by Meta (app secret set)" ||
    bad "WHATSAPP_APP_SECRET is empty: the bot refuses all messages until it's set"
  [[ $(setting PUBLIC_URL) == https://* ]] && ok "The site address uses HTTPS" || bad "PUBLIC_URL isn't https://"
  [[ -n $(setting ADMIN_PHONES) ]] && ok "Admins are set (they approve new members)" || meh "ADMIN_PHONES is empty: new members are let in without approval"
  [[ -n $(setting ANTHROPIC_API_KEY) ]] && note "Photo scanning is on: keep a monthly spend limit set in the Anthropic Console" || ok "Photo scanning is off (no paid API key on the server)"
else
  bad "No settings file at $ENV_FILE"
fi

section "Data"
[[ $(stat -c '%a' "$DATA_DIR" 2>/dev/null) == 750 ]] && ok "Data folder is private (750)" || bad "Data folder permissions are $(stat -c '%a' "$DATA_DIR" 2>/dev/null)"
db=$DATA_DIR/muhallareads.db
if [[ -f $db ]]; then
  [[ $(stat -c '%a %U' "$db") == "600 $APP_USER" ]] && ok "Database readable only by the app" || meh "Database permissions are $(stat -c '%a %U' "$db") (want 600 $APP_USER; re-run setup.sh)"
fi
latest=$(ls -1t "$BACKUPS"/muhallareads-*.db 2>/dev/null | head -1)
if [[ -n $latest ]] && (( $(date +%s) - $(stat -c %Y "$latest") < 2 * 86400 )); then
  ok "Latest backup is recent ($(basename "$latest"))"
else
  meh "No backup from the last 2 days in $BACKUPS"
fi
[[ $(stat -c '%a' "$BACKUPS" 2>/dev/null) == 750 ]] && ok "Backups folder is private" || meh "Backups folder permissions are $(stat -c '%a' "$BACKUPS" 2>/dev/null) (re-run setup.sh)"

section "Web"
domain=$(cat /etc/muhallareads/domain 2>/dev/null)
if [[ -n $domain ]]; then
  hdrs=$(curl -sSI -m 10 "https://$domain/" 2>&1)
  grep -qi '^HTTP/[0-9.]* 200' <<<"$hdrs" && ok "https://$domain answers with a valid certificate" || bad "https://$domain didn't answer properly: $(head -1 <<<"$hdrs")"
  grep -qi '^strict-transport-security' <<<"$hdrs" && ok "Browsers are told to always use HTTPS" || meh "No HSTS header (re-run setup.sh)"
  grep -qi '^content-security-policy' <<<"$hdrs" && ok "Content-Security-Policy is sent" || meh "No Content-Security-Policy (update the app)"
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST -H 'Content-Type: application/json' -d '{}' "https://$domain/webhooks/whatsapp")
  [[ $code == 401 ]] && ok "Unsigned WhatsApp webhook calls are rejected" || meh "Unsigned webhook call returned $code (expected 401)"
fi

section "App sandbox"
score=$(systemd-analyze security muhallareads 2>/dev/null | tail -1)
[[ -n $score ]] && ok "systemd exposure: ${score#*: }" || meh "Couldn't rate the service sandbox"

printf '\n%s passed, %s warnings, %s failed\n' "$pass" "$warn" "$fail"
(( fail == 0 ))
