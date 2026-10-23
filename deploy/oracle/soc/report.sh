#!/usr/bin/env bash
# The security monitor's daily report (systemd timer muhallareads-soc-report, every morning): the last
# 24 hours in a few lines. Sent quietly on ntfy, on WhatsApp if that's free right now, and saved so an
# admin can send "security" to the bot any time.
#
#   report.sh          make, save and send the report
#   report.sh --print  only print it
set -uo pipefail
# shellcheck source=lib.sh
. /usr/local/lib/muhallareads-soc/lib.sh

now=$(date +%s)
since=$((now - 86400))
out=()
line() { out+=("$*"); }
plural() { (( $1 == 1 )) && echo "$1 $2" || echo "$1 ${3:-${2}s}"; }

line "🛡️ *MohallaReads security report* · $(date '+%a %-d %b')"

# ---------- web traffic (Caddy's access log) ----------
logdir=$(dirname "$CADDY_LOG")
if compgen -G "$logdir/access*" >/dev/null; then
  read -r total visitors server_err limited bad_signin forged < <(
    find "$logdir" -name 'access*' -newermt "@$since" -print0 2>/dev/null | xargs -0 -r zcat -f 2>/dev/null |
      jq -nrR --argjson since "$since" --arg self "$(cat "$SOC_STATE/self-ip" 2>/dev/null)" '
        # Not the server itself (its daily security check pokes at the site like an attacker would).
        def own: . == $self or startswith("127.") or startswith("10.") or . == "::1";
        reduce (inputs | fromjson? | select(type == "object" and (.ts // 0) >= $since)
                | select((.request.client_ip // .request.remote_ip // "") | own | not)) as $e
          ({n: 0, ips: {}, c5: 0, c429: 0, login: 0, forged: 0};
           .n += 1
           | .ips[$e.request.client_ip // $e.request.remote_ip // "?"] = 1
           | ($e.status // 0) as $s | ($e.request.uri // "") as $uri
           | if $s >= 500 then .c5 += 1 else . end
           | if $s == 429 then .c429 += 1 else . end
           | if $e.request.method == "POST" and ($uri | startswith("/api/login")) and $s == 401 then .login += 1 else . end
           | if ($uri | startswith("/webhooks/")) and $s == 401 then .forged += 1 else . end)
        | [.n, (.ips | length), .c5, .c429, .login, .forged] | @tsv' 2>/dev/null)
  if [[ -n ${total:-} ]]; then
    web="🌐 Web: $(plural "$total" request) from $(plural "$visitors" address addresses)"
    (( limited )) && web+=" · $limited slowed down (too many requests)"
    (( bad_signin )) && web+=" · $(plural "$bad_signin" "failed sign-in")"
    (( forged )) && web+=" · $(plural "$forged" "faked WhatsApp webhook")"
    if (( server_err )); then web+=" · ⚠️ $(plural "$server_err" "server error")"; else web+=" · no server errors"; fi
    line "$web"
  fi
else
  line "🌐 Web: no access log yet (re-run setup.sh)"
fi

# ---------- attacks blocked (CrowdSec) ----------
if command -v cscli >/dev/null; then
  blocked=$(cscli alerts list --since 24h --limit 0 -o json 2>/dev/null | jq -r '
    def nice: sub("^[^/]+/"; "") | ({
      "ssh-bf": "SSH password guessing", "ssh-slow-bf": "SSH password guessing", "ssh-bf_user-enum": "SSH user guessing",
      "ssh-refused-conn": "SSH scanning", "ssh-cve-2024-6387": "SSH exploit",
      "http-probing": "page scanning", "http-crawl-non_statics": "aggressive crawling",
      "http-sensitive-files": "looking for secret files", "http-backdoors-attempts": "looking for backdoors",
      "http-admin-interface-probing": "looking for admin pages", "http-path-traversal-probing": "path tricks",
      "http-sqli-probing": "SQL injection", "http-xss-probing": "script injection", "http-bad-user-agent": "known attack tools",
      "http-wordpress-scan": "WordPress scanning", "http-open-proxy": "open-proxy check"
    }[.] // (if test("cve|exploit|CVE") then "known exploits" else . end));
    [.[]?] as $a
    | if ($a | length) == 0 then "" else
      ($a | map(.source.value) | unique | length) as $ips
      | ($a | map(.scenario | nice) | group_by(.) | map([.[0], length]) | sort_by(-.[1]) | .[:4] | map("\(.[0]) \(.[1])") | join(", ")) as $what
      | ($a | map(.source.cn // "" | select(. != "")) | group_by(.) | map([.[0], length]) | sort_by(-.[1]) | .[:3] | map(.[0]) | join(", ")) as $from
      | "\($ips)\t\($what)\t\($from)" end' 2>/dev/null)
  banned=$(cscli decisions list -o json 2>/dev/null | jq '[.[]?.decisions[]?] | length' 2>/dev/null)
  if [[ -n $blocked ]]; then
    IFS=$'\t' read -r ips what from <<<"$blocked"
    line "🚫 Blocked $(plural "$ips" attacker): $what${from:+ · mostly from $from} · ${banned:-0} still banned, plus CrowdSec's community blocklist"
  else
    line "🚫 No attacks needed blocking · CrowdSec's community blocklist is on"
  fi
  systemctl is-active --quiet crowdsec 2>/dev/null && systemctl is-active --quiet crowdsec-firewall-bouncer 2>/dev/null ||
    line "⚠️ CrowdSec or its firewall bouncer isn't running: sudo systemctl status crowdsec crowdsec-firewall-bouncer"
fi

# ---------- SSH ----------
ssh_log=$(journalctl -q --since "@$since" -t sshd -t sshd-session -o cat 2>/dev/null)
logins=$(sed -nE 's/^Accepted [^ ]+ for ([^ ]+) from ([^ ]+) port.*/\1 from \2/p' <<<"$ssh_log")
n_logins=$(grep -c . <<<"$logins")
# One line per try: unknown user names, passwords (always refused), and known users without the key.
bots=$(grep -cE '^(Invalid user|Failed password|(Connection closed by|Disconnected from) authenticating user)' <<<"$ssh_log")
wrong=$(grep -c '^Failed keyboard-interactive/pam' <<<"$ssh_log")
ssh="🔐 SSH: $(plural "$n_logins" login)"
(( n_logins )) && ssh+=" ($(sort -u <<<"$logins" | head -3 | paste -sd, - | sed 's/,/, /g'))"
ssh+=" · $(plural "$bots" "failed attempt") by bots"
(( wrong )) && ssh+=" · ⚠️ $(plural "$wrong" "wrong 6-digit code")"
line "$ssh"

# ---------- the server ----------
disk=$(df --output=pcent / | tail -1 | tr -dc 0-9)
mem=$(awk '/MemAvailable/ {a=$2} /MemTotal/ {t=$2} END {print int(a*100/t)}' /proc/meminfo)
load=$(cut -d' ' -f3 /proc/loadavg)
up=$(( $(cut -d. -f1 /proc/uptime) / 86400 ))
server="🖥️ Server: disk ${disk}% · memory ${mem}% free · load $load · up $(plural "$up" day)"
domain=$(cat /etc/muhallareads/domain 2>/dev/null)
if [[ -n $domain ]]; then
  end=$(echo | timeout 15 openssl s_client -connect "$domain:443" -servername "$domain" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [[ -n $end ]]; then
    server+=" · certificate $(plural $(( ($(date -d "$end" +%s) - now) / 86400 )) day)"
  else
    server+=" · ⚠️ couldn't check the certificate"
  fi
fi
latest=$(ls -1t /var/backups/muhallareads/muhallareads-*.db 2>/dev/null | head -1)
if [[ -n $latest ]]; then
  server+=" · backup $(( (now - $(stat -c %Y "$latest")) / 3600 ))h old"
else
  server+=" · ⚠️ no backup"
fi
line "$server"
alerts_sent=$(journalctl -q --since "@$since" -t muhallareads-soc -o cat 2>/dev/null | grep -c 'security alert')
(( alerts_sent )) && line "📣 $(plural "$alerts_sent" alert) sent in the last day (sudo muhallareads-soc log)"

# ---------- the full security check ----------
if command -v muhallareads-security-check >/dev/null; then
  check=$(timeout 120 muhallareads-security-check 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g')
  summary=$(tail -1 <<<"$check")
  problems=$(grep -E '^\s+(WARN|FAIL)\s' <<<"$check" | sed -E 's/^\s+(WARN|FAIL)\s+/• \1: /' | head -6)
  if [[ -z $problems ]]; then
    line "✅ Security check: $summary"
  else
    line "🩺 Security check: $summary"
    line "$problems"
  fi
fi

report=$(printf '%s\n' "${out[@]}")
if [[ ${1:-} == --print ]]; then
  printf '%s\n' "$report"
  exit 0
fi
# Saved for the bot's "security" command (the app can read it, not change it).
if [[ -d $(dirname "$REPORT_FILE") ]]; then
  printf '%s\n\n(made %s; a new one comes every morning)\n' "$report" "$(date '+%-d %b, %H:%M')" > "$REPORT_FILE.tmp" &&
    chown root:muhallareads "$REPORT_FILE.tmp" && chmod 640 "$REPORT_FILE.tmp" && mv "$REPORT_FILE.tmp" "$REPORT_FILE"
fi
notify "$report" report
exit 0
