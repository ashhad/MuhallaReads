#!/usr/bin/env bash
# Adds the security monitor (a small "SOC") to a MohallaReads server. Everything runs on the VM, free:
#   - CrowdSec reads the SSH and web logs and blocks attackers in the firewall. In return for reporting
#     the attackers it sees, it gets CrowdSec's community blocklist of known bad addresses (free).
#   - Checks every 10 minutes (SSH logins, changed system files, new open ports, stopped services, disk,
#     certificate) and a short report every morning, sent to the admins on WhatsApp (only free
#     messages, never a paid template) and, if you set it up, as instant phone alerts with ntfy.
#
#   sudo bash deploy/oracle/soc-setup.sh        (after setup.sh; safe to run again)
#
# Uses about 150 MB of memory. To remove it: sudo rm /etc/muhallareads/soc.enabled, re-run setup.sh,
# then sudo apt remove crowdsec crowdsec-firewall-bouncer-nftables.
set -euo pipefail

CONF_DIR=/etc/muhallareads
ENV_FILE=$CONF_DIR/muhallareads.env
REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Please run with sudo:  sudo bash $0"
[[ -f $ENV_FILE && -f $CONF_DIR/domain ]] || die "Set up the library first:  sudo bash deploy/oracle/setup.sh yourname.duckdns.org"

mem_kb=$(awk '/MemTotal/ {m=$2} /SwapTotal/ {s=$2} END {print m + s}' /proc/meminfo)
if (( mem_kb < 1500000 )); then
  echo "Note: this server has little memory ($(( mem_kb / 1024 )) MB including swap). CrowdSec needs about 150 MB;"
  echo "keep an eye on the daily report's memory figure."
fi

step "Installing CrowdSec (free and open source)"
export DEBIAN_FRONTEND=noninteractive
# Ubuntu's own CrowdSec is years old; use CrowdSec's package repository.
if [[ ! -f /etc/apt/sources.list.d/crowdsec_crowdsec.list ]]; then
  curl -fsSL https://install.crowdsec.net | sh >/dev/null
fi
apt-get install -y -qq crowdsec jq >/dev/null
# The nftables bouncer keeps its rules in its own table, so it never mixes with the saved iptables rules.
apt-get install -y -qq crowdsec-firewall-bouncer-nftables >/dev/null
cscli hub update >/dev/null
cscli collections install crowdsecurity/linux crowdsecurity/sshd crowdsecurity/caddy \
  crowdsecurity/base-http-scenarios crowdsecurity/http-cve >/dev/null
systemctl enable --now crowdsec crowdsec-firewall-bouncer 2>/dev/null ||
  echo "CrowdSec didn't start; see: sudo journalctl -u crowdsec -u crowdsec-firewall-bouncer -n 30"
grep -qE '^mode:\s*nftables' /etc/crowdsec/bouncers/crowdsec-firewall-bouncer.yaml ||
  echo "Note: the firewall bouncer isn't in nftables mode; check /etc/crowdsec/bouncers/crowdsec-firewall-bouncer.yaml"

step "Turning the security monitor on"
touch "$CONF_DIR/soc.enabled"
if ! grep -q '^SOC_NTFY_URL=' "$ENV_FILE"; then
  cat >> "$ENV_FILE" <<'ENV'

# --- Security monitor (deploy/oracle/soc-setup.sh) ---
# Instant alerts on your phone through the free ntfy app. Set it up with: sudo muhallareads-soc ntfy
SOC_NTFY_URL=
# To hear if this server goes down: a free healthchecks.io check. Set it up with: sudo muhallareads-soc healthcheck
SOC_HEALTHCHECK_URL=
# Addresses that are never blocked, separated by spaces (optional; home internet addresses often change).
SOC_TRUSTED_IPS=
ENV
fi

# The rest (web log, CrowdSec settings, the checks and their timers) is part of setup.sh, so updates keep it current.
bash "$REPO_DIR/deploy/oracle/setup.sh"

step "Sending a test alert"
/usr/local/bin/muhallareads-soc test || true

cat <<DONE

🛡️ The security monitor is on.

  Status:    sudo muhallareads-soc
  Report:    sudo muhallareads-soc report     (also every morning; admins can send "security" to the bot)
  Blocked:   sudo muhallareads-soc bans       ·  sudo muhallareads-soc unban <address>

  Recommended (free):
  1. Instant phone alerts with the ntfy app:  sudo muhallareads-soc ntfy
     (WhatsApp alerts only arrive straight away if you've messaged the bot in the last 24 hours.)
  2. Hear if the server dies: make a check at healthchecks.io (period 10 min, grace 20 min), then
     sudo muhallareads-soc healthcheck
  3. Optional dashboard: sign up at app.crowdsec.net and run the "cscli console enroll" command it shows.
DONE
