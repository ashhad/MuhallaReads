# Shared by the security monitor's scripts. Installed to /usr/local/lib/muhallareads-soc/.
# shellcheck shell=bash disable=SC2034  # the settings below are used by the scripts that source this

SOC_STATE=/var/lib/muhallareads-soc
ENV_FILE=/etc/muhallareads/muhallareads.env
APP_DIR=/opt/muhallareads
CADDY_LOG=/var/log/caddy/access.log
# The latest daily report, which admins can read on WhatsApp by sending "security" to the bot.
REPORT_FILE=/var/lib/muhallareads/security-report.txt
MAX_ALERTS_PER_HOUR=20

install -d -m 700 "$SOC_STATE"

setting() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2-; }

# Sends `text` to the admins: on WhatsApp through the library's bot, and as an instant push if
# SOC_NTFY_URL is set (https://ntfy.sh/<a long random topic>). At most MAX_ALERTS_PER_HOUR, so a flood
# of events can't flood a phone; everything is also written to the system log (journalctl -t muhallareads-soc).
#   notify <text>           an alert: if WhatsApp can't deliver it for free now, it waits until the admin
#                           next messages the bot (never a paid template)
#   notify <text> report    the daily report: sent on WhatsApp only if free right now, quietly on ntfy
notify() {
  local text=$1 kind=${2:-alert} hour count
  logger -t muhallareads-soc -- "$text"
  hour=$(date +%Y%m%d%H)
  count=$(cat "$SOC_STATE/alerts-$hour" 2>/dev/null || echo 0)
  if (( count >= MAX_ALERTS_PER_HOUR )); then
    logger -t muhallareads-soc "alert limit reached this hour; not sent"
    return 0
  fi
  echo $((count + 1)) > "$SOC_STATE/alerts-$hour"
  find "$SOC_STATE" -name 'alerts-*' -mmin +120 -delete 2>/dev/null

  local flag=()
  [[ $kind == report ]] && flag=(--if-free)
  systemd-run --quiet --pipe --wait -p User=muhallareads -p EnvironmentFile="$ENV_FILE" \
    -p WorkingDirectory="$APP_DIR" /usr/bin/node --disable-warning=ExperimentalWarning \
    scripts/notify-admins.js "${flag[@]}" "$text" >/dev/null 2>&1 || logger -t muhallareads-soc "WhatsApp alert could not be sent"

  local ntfy priority=high
  [[ $kind == report ]] && priority=low
  ntfy=$(setting SOC_NTFY_URL)
  if [[ -n $ntfy ]]; then
    printf '%s' "$text" | curl -fsS -m 10 -H 'Title: MohallaReads security' -H 'Tags: shield' -H "Priority: $priority" \
      --data-binary @- "$ntfy" >/dev/null 2>&1 || logger -t muhallareads-soc "ntfy alert could not be sent"
  fi
}

# Remembers a yes/no condition, so an alert is sent when it starts and once when it ends, not every run.
# Usage: changed <name> <0|1>  → prints "start", "end" or nothing.
changed() {
  local file="$SOC_STATE/state-$1" before
  before=$(cat "$file" 2>/dev/null || echo 0)
  echo "$2" > "$file"
  [[ $before == 0 && $2 == 1 ]] && echo start
  [[ $before == 1 && $2 == 0 ]] && echo end
  return 0
}
