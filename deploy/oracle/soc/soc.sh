#!/usr/bin/env bash
# The security monitor's controls. Installed as /usr/local/bin/muhallareads-soc by setup.sh.
#
#   sudo muhallareads-soc               is everything running?
#   sudo muhallareads-soc report        today's report, now (printed, not sent)
#   sudo muhallareads-soc test          send a test alert (WhatsApp and ntfy)
#   sudo muhallareads-soc bans          addresses blocked right now, and why
#   sudo muhallareads-soc unban 1.2.3.4 unblock an address (e.g. a member blocked by mistake)
#   sudo muhallareads-soc log           the latest alerts
set -uo pipefail
[[ $EUID -eq 0 ]] || { echo "Please run with sudo: sudo muhallareads-soc ${1:-}"; exit 1; }
# shellcheck source=lib.sh
. /usr/local/lib/muhallareads-soc/lib.sh

case ${1:-status} in
  status)
    for u in crowdsec crowdsec-firewall-bouncer muhallareads-soc-watch.timer muhallareads-soc-report.timer; do
      printf '  %-32s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null)"
    done
    last=$(cat "$SOC_STATE/last-run" 2>/dev/null || echo 0)
    echo "  Last check: $(( ($(date +%s) - last) / 60 )) minutes ago"
    echo "  Blocked now: $(cscli decisions list -o json 2>/dev/null | jq '[.[]?.decisions[]?] | length') addresses (plus the community blocklist)"
    echo "  Alerts go to: WhatsApp$( [[ -n $(setting SOC_NTFY_URL) ]] && echo ', ntfy' )$( [[ -n $(setting SOC_HEALTHCHECK_URL) ]] && echo ' · dead-man switch on' )"
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
  *) sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
