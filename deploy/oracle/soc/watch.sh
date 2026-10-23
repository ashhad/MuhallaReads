#!/usr/bin/env bash
# The security monitor's 10-minute check (systemd timer muhallareads-soc-watch). Alerts the admins about:
#   - every SSH login, and logins that had the key but the wrong code (a stolen key?)
#   - changes to critical files: users, sudo, SSH, PAM, cron, services, Caddy, the app's code and libraries
#   - a new program listening on a network port
#   - a service stopping (and starting again), and the server restarting
#   - disk or memory running out; the HTTPS certificate not being renewed
#   - bursts of faked WhatsApp webhooks, app errors, or a heavy attack
# Routine attacks that CrowdSec blocks (bots guessing SSH passwords, scanning for pages) are only
# counted in the daily report, so alerts stay rare enough to read.
#
#   watch.sh               run the checks
#   watch.sh --rebaseline  accept the current files and ports as normal (setup.sh runs this after an update)
set -uo pipefail
# shellcheck source=lib.sh
. /usr/local/lib/muhallareads-soc/lib.sh

alerts=()
add() { alerts+=("$*"); }

# ---------- what "normal" looks like ----------

critical_files() {
  local f
  for f in /etc/passwd /etc/shadow /etc/group /etc/gshadow /etc/sudoers /etc/sudoers.d/* \
    /etc/ssh/sshd_config /etc/ssh/sshd_config.d/* /etc/pam.d/sshd /etc/pam.d/sudo /etc/pam.d/common-auth \
    /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys /home/*/.google_authenticator \
    /etc/crontab /etc/cron.d/* /etc/cron.daily/* /etc/cron.hourly/* /var/spool/cron/crontabs/* \
    /etc/systemd/system/*.service /etc/systemd/system/*.timer /etc/systemd/system/*.wants/* \
    /etc/caddy/Caddyfile /etc/ld.so.preload /etc/muhallareads/muhallareads.env \
    /usr/local/bin/* /usr/local/lib/muhallareads-soc/*; do
    # Snap packages rewrite their own units when they update themselves (several times a week).
    [[ $f == /etc/systemd/system/snap[.-]* || $f == /etc/systemd/system/*.wants/snap[.-]* ]] && continue
    [[ -e $f || -L $f ]] && echo "$f"
  done
  find "$APP_DIR" -path "$APP_DIR/node_modules" -prune -o -type f -print 2>/dev/null
}

# "hash  path" for each critical file.
snapshot_files() {
  local f
  critical_files | sort -u | while IFS= read -r f; do
    if [[ -L $f ]]; then
      # A link (e.g. an enabled service): what it points to.
      printf '%s  %s\n' "$(readlink "$f" | sha256sum | cut -d' ' -f1)" "$f"
    elif [[ $f == */.google_authenticator ]]; then
      # Only the secret: the rest of the file changes at every login (used codes are remembered).
      printf '%s  %s\n' "$(head -1 "$f" | sha256sum | cut -d' ' -f1)" "$f"
    elif [[ -f $f ]]; then
      sha256sum "$f" 2>/dev/null
    fi
  done
  # The app's libraries, as one fingerprint (thousands of files; any change shows up).
  [[ -d $APP_DIR/node_modules ]] &&
    echo "$(find "$APP_DIR/node_modules" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)  $APP_DIR/node_modules"
}

# Sockets reachable from outside this machine: "proto address:port program".
snapshot_ports() {
  ss -Htlnp 2>/dev/null | awk '$4 !~ /^(127\.|\[::1\]|::1)/ {print "tcp", $4, $6}'
  ss -Hulnp 2>/dev/null | awk '$4 !~ /^(127\.|\[::1\]|::1)/ {print "udp", $4, $6}'
}
# Just "proto address:port": which program holds a socket can change harmlessly (e.g. SSH socket activation).
ports_key() { snapshot_ports | awk '{print $1, $2}' | sort -u; }

if [[ ${1:-} == --rebaseline ]]; then
  snapshot_files > "$SOC_STATE/files"
  ports_key > "$SOC_STATE/ports"
  date +%s > "$SOC_STATE/last-run"
  rm -f "$SOC_STATE/updating"
  echo "Security monitor: current files and ports recorded as normal."
  exit 0
fi

now=$(date +%s)
last=$(cat "$SOC_STATE/last-run" 2>/dev/null || echo $((now - 600)))
echo "$now" > "$SOC_STATE/last-run"
since="@$last"
# setup.sh marks an update in progress; files, ports and services are expected to change meanwhile.
updating=$([[ -n $(find "$SOC_STATE/updating" -mmin -30 2>/dev/null) ]] && echo 1)
uptime_s=$(cut -d. -f1 /proc/uptime)

# ---------- 1. SSH logins ----------
ssh_log=$(journalctl -q --since "$since" -t sshd -t sshd-session -o cat 2>/dev/null)
# With two-factor on, a login shows as "Accepted keyboard-interactive/pam" (the key step is "Partial").
while read -r who; do
  [[ -n $who ]] && add "🔐 SSH login: $who"
done < <(sed -nE 's/^Accepted ([^ ]+) for ([^ ]+) from ([^ ]+) port.*/\2 from \3 (\1)/p' <<<"$ssh_log" | grep -v ' (publickey)$' | sort -u)
# "Accepted publickey" means that login didn't need the 6-digit code.
while read -r who; do
  [[ -n $who ]] && add "🔐 SSH login with only a key (no code): $who. Is two-factor SSH off?"
done < <(sed -nE 's/^Accepted publickey for ([^ ]+) from ([^ ]+) port.*/\1 from \2/p' <<<"$ssh_log" | sort -u)
while read -r who; do
  [[ -n $who ]] && add "⚠️ SSH: someone had a valid key for $who but the wrong 6-digit code. If that wasn't you, your SSH key may be stolen."
done < <(sed -nE 's/^Failed keyboard-interactive\/pam for ([^ ]+) from ([^ ]+) port.*/\1 from \2/p' <<<"$ssh_log" | sort -u)

# ---------- 2. Critical files ----------
if [[ -z $updating ]]; then
  current=$(snapshot_files)
  if [[ -f $SOC_STATE/files ]]; then
    changes=$(diff <(sort -k2 "$SOC_STATE/files") <(sort -k2 <<<"$current") | sed -nE 's/^[<>] [0-9a-f]{64}  //p' |
      sort -u | head -15 | tr '\n' ' ')
    if [[ -n $changes ]]; then
      why="if you didn't do this, investigate"
      [[ /var/log/dpkg.log -nt $SOC_STATE/files ]] && why="packages were updated just now, which probably explains it"
      add "📝 Files changed: $changes($why)"
    fi
  fi
  printf '%s\n' "$current" > "$SOC_STATE/files"
fi

# ---------- 3. New listening ports ----------
if [[ -z $updating ]]; then
  ports=$(ports_key)
  if [[ -f $SOC_STATE/ports ]]; then
    while read -r key; do
      [[ -z $key ]] && continue
      prog=$(snapshot_ports | awk -v k="$key" '$1 " " $2 == k {print $3}' | sed -nE 's/^users:\(\("([^"]+)".*/\1/p' | head -1)
      add "🚪 New program listening on the network: $key ${prog:-(unknown program)}"
    done < <(comm -13 "$SOC_STATE/ports" <(printf '%s\n' "$ports") | head -5)
  fi
  printf '%s\n' "$ports" > "$SOC_STATE/ports"
fi

# ---------- 4. Restarts and services ----------
boot=$(cat /proc/sys/kernel/random/boot_id)
if [[ -f $SOC_STATE/boot-id && $(cat "$SOC_STATE/boot-id") != "$boot" ]]; then
  add "🔄 The server restarted ($(uptime -s 2>/dev/null)). Fine after updates or if you rebooted it."
fi
echo "$boot" > "$SOC_STATE/boot-id"
if [[ -z $updating ]] && (( uptime_s > 300 )); then
  for svc in muhallareads caddy ssh crowdsec crowdsec-firewall-bouncer; do
    [[ -n $(systemctl list-unit-files --no-legend "$svc.service" 2>/dev/null) ]] || continue
    down=0
    systemctl is-active --quiet "$svc" || down=1
    case $(changed "down-$svc" "$down") in
      start) add "❌ $svc has stopped. Check: sudo journalctl -u $svc -n 30" ;;
      end) add "✅ $svc is running again." ;;
    esac
  done
fi

# ---------- 5. Disk and memory ----------
disk=$(df --output=pcent / | tail -1 | tr -dc 0-9)
case $(changed disk-full $(( disk >= 85 ))) in
  start) add "💾 Disk is ${disk}% full." ;;
  end) add "💾 Disk is back to ${disk}% full." ;;
esac
mem_avail=$(awk '/MemAvailable/ {a=$2} /MemTotal/ {t=$2} END {print int(a*100/t)}' /proc/meminfo)
case $(changed mem-low $(( mem_avail < 5 ))) in
  start) add "🧠 Memory is nearly used up (${mem_avail}% free)." ;;
esac

# ---------- 6. HTTPS certificate (once an hour) ----------
domain=$(cat /etc/muhallareads/domain 2>/dev/null)
if [[ -n $domain && $(date +%M) -lt 10 ]]; then
  end=$(echo | timeout 15 openssl s_client -connect "$domain:443" -servername "$domain" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [[ -n $end ]]; then
    days=$(( ($(date -d "$end" +%s) - now) / 86400 ))
    # Caddy renews 30 days before expiry, so under 14 days means renewal is failing.
    case $(changed cert-expiring $(( days < 14 ))) in
      start) add "🔒 The HTTPS certificate expires in $days days and hasn't renewed. Check: sudo journalctl -u caddy -n 50" ;;
    esac
  fi
fi

# ---------- 7. App: faked webhooks, errors ----------
app_log=$(journalctl -q --since "$since" -u muhallareads -o cat 2>/dev/null)
forged=$(grep -c 'signature mismatch' <<<"$app_log")
(( forged >= 5 )) && add "🎭 $forged faked WhatsApp webhook calls in the last few minutes (rejected). Someone is probing the bot."
grep -q 'WHATSAPP_APP_SECRET is not set' <<<"$app_log" && add "🎭 The bot is refusing WhatsApp messages: WHATSAPP_APP_SECRET is not set."
errors=$(grep -cE '^(Error|TypeError|RangeError|SyntaxError|ReferenceError)\b' <<<"$app_log")
(( errors >= 5 )) && add "🐞 The app logged $errors errors in the last few minutes. Check: sudo journalctl -u muhallareads -n 50"

# ---------- 8. A heavy attack ----------
if command -v cscli >/dev/null; then
  attackers=$(cscli alerts list --since "$(( now - last + 60 ))s" --limit 0 -o json 2>/dev/null | jq '[.[]?.source.value] | unique | length' 2>/dev/null)
  (( ${attackers:-0} >= 30 )) && add "🚨 $attackers addresses attacked the server in the last few minutes; CrowdSec blocked them. See: sudo cscli alerts list"
fi

# ---------- send ----------
if (( ${#alerts[@]} )); then
  notify "$(printf '🛡️ *MohallaReads security alert*\n'; printf '• %s\n' "${alerts[@]}")"
fi

# "I'm alive" ping for an outside dead-man's switch (e.g. healthchecks.io), so you hear if the VM dies.
hc=$(setting SOC_HEALTHCHECK_URL)
[[ -n $hc ]] && curl -fsS -m 10 --retry 2 "$hc" >/dev/null 2>&1
exit 0
