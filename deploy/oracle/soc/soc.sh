#!/usr/bin/env bash
# The security monitor's controls. Installed as /usr/local/bin/muhallareads-soc by setup.sh.
#
#   sudo muhallareads-soc               is everything running?
#   sudo muhallareads-soc ntfy          set up instant phone alerts with the free ntfy app ("ntfy off" to stop)
#   sudo muhallareads-soc healthcheck   connect a free healthchecks.io check, to hear if the server dies ("off" to stop)
#   sudo muhallareads-soc report        today's report, now (printed, not sent)
#   sudo muhallareads-soc test          send a test alert (WhatsApp and ntfy)
#   sudo muhallareads-soc bans          addresses blocked right now, and why
#   sudo muhallareads-soc unban 1.2.3.4 unblock an address (e.g. a member blocked by mistake)
#   sudo muhallareads-soc log           the latest alerts
set -uo pipefail
[[ $EUID -eq 0 ]] || { echo "Please run with sudo: sudo muhallareads-soc ${1:-}"; exit 1; }
# shellcheck source=lib.sh
. /usr/local/lib/muhallareads-soc/lib.sh

# Sets KEY=value in the settings file. Values are checked URLs (or empty), so they need no escaping.
save_setting() {
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
  chown root:muhallareads "$ENV_FILE" && chmod 640 "$ENV_FILE"
  # You made this change, so the 10-minute check shouldn't alert about the settings file.
  if [[ -f $SOC_STATE/files ]]; then
    { grep -vF "  $ENV_FILE" "$SOC_STATE/files"; sha256sum "$ENV_FILE"; } > "$SOC_STATE/files.new" &&
      mv "$SOC_STATE/files.new" "$SOC_STATE/files"
  fi
}

case ${1:-status} in
  status)
    for u in crowdsec crowdsec-firewall-bouncer muhallareads-soc-watch.timer muhallareads-soc-report.timer; do
      printf '  %-32s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null)"
    done
    last=$(cat "$SOC_STATE/last-run" 2>/dev/null || echo 0)
    echo "  Last check: $(( ($(date +%s) - last) / 60 )) minutes ago"
    blocked=$(cscli decisions list -o json 2>/dev/null | jq '[.[]?.decisions[]?] | length')
    echo "  Blocked now: ${blocked:-?} attacker$( [[ $blocked == 1 ]] || echo s ) caught here (see: sudo muhallareads-soc bans), plus the community blocklist"
    echo "  Phone alerts (ntfy): $( [[ -n $(setting SOC_NTFY_URL) ]] && echo on || echo 'off  → sudo muhallareads-soc ntfy' )"
    echo "  Dead-man's switch:   $( [[ -n $(setting SOC_HEALTHCHECK_URL) ]] && echo on || echo 'off  → sudo muhallareads-soc healthcheck' )"
    ;;

  ntfy)
    if [[ ${2:-} == off ]]; then
      save_setting SOC_NTFY_URL ''
      echo "ntfy alerts are off. (Unsubscribe from the topic in the app too.)"
      exit 0
    fi
    # A topic nobody can guess: anyone who knows it can read the alerts.
    url=${2:-$(setting SOC_NTFY_URL)}
    [[ -n $url ]] || url="https://ntfy.sh/mohallareads-$(openssl rand -hex 8)"
    [[ $url =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9_-]{1,64}$ ]] ||
      { echo "That isn't an ntfy topic address like https://ntfy.sh/mytopic"; exit 1; }
    save_setting SOC_NTFY_URL "$url"
    topic=${url##*/} server=${url%/*}
    cat <<EOF

Security alerts will go to this ntfy topic:

    $topic

On your phone:
  1. Install "ntfy" from the Play Store or App Store (free, no account needed).
  2. Tap +, type the topic name above exactly, and tap Subscribe.$( [[ $server != https://ntfy.sh ]] && printf '\n     Turn on "Use another server" and enter %s' "$server" )
  3. Allow notifications when it asks. On Android, also open the topic's settings and set
     "Instant delivery" on, so alerts aren't delayed.

Keep the topic name to yourself: anyone who knows it can read the alerts.

EOF
    read -rp "Press Enter once you've subscribed, to send a test… " _ || true
    if push_ntfy "✅ MohallaReads security alerts will arrive here. Nothing is wrong." default; then
      echo "Sent. Your phone should show it now. If not, check the topic name in the app."
    else
      echo "Couldn't reach $server. Check the server's internet connection and try again."
      exit 1
    fi
    ;;

  healthcheck)
    if [[ ${2:-} == off ]]; then
      save_setting SOC_HEALTHCHECK_URL ''
      echo "The dead-man's switch is off. Pause or delete the check on healthchecks.io, or it will report the server as down."
      exit 0
    fi
    url=${2:-}
    [[ -n $url ]] || read -rp "Paste the check's ping URL from healthchecks.io (https://hc-ping.com/…): " url
    url=${url//[[:space:]]/}
    [[ $url =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9/_-]+$ ]] ||
      { echo "That isn't a ping URL like https://hc-ping.com/1234abcd-…"; exit 1; }
    if ! curl -fsS -m 10 --retry 2 "$url" >/dev/null; then
      echo "Couldn't ping that URL. Copy it again from the check's page and retry."
      exit 1
    fi
    save_setting SOC_HEALTHCHECK_URL "$url"
    echo "Saved and pinged: the check on healthchecks.io should now show as up (green)."
    echo "The server pings it every 10 minutes from now on; if the pings stop, healthchecks.io tells you."
    ;;

  report) /usr/local/lib/muhallareads-soc/report.sh --print ;;
  test)
    notify "🛡️ *MohallaReads security alert*
• Test alert from $(hostname): alerts reach you. Nothing is wrong."
    echo "Sent. On WhatsApp it arrives now if you messaged the bot in the last day, otherwise the next time you do."
    ;;
  bans) cscli decisions list ;;
  unban)
    [[ -n ${2:-} ]] || { echo "Usage: sudo muhallareads-soc unban <address>"; exit 1; }
    cscli decisions delete --ip "$2"
    ;;
  log) journalctl -t muhallareads-soc -n "${2:-30}" --no-pager ;;
  *) grep '^#   sudo' "$0" | sed 's/^# *//'; exit 1 ;;
esac
