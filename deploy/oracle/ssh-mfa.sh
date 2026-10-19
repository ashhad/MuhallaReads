#!/usr/bin/env bash
# Two-factor SSH for the VM: logging in needs your SSH key AND a 6-digit code from an authenticator app.
#
#   Turn on:   sudo bash deploy/oracle/ssh-mfa.sh
#   Turn off:  sudo bash deploy/oracle/ssh-mfa.sh --undo
#
# Keep the SSH session you run this from open until you've logged in from a second terminal. If the new
# login fails, run the --undo command in the session that's still open.
set -euo pipefail

PAM=/etc/pam.d/sshd
DROPIN=/etc/ssh/sshd_config.d/10-muhallareads-mfa.conf # sorts before 50-cloudimg-settings.conf, so it wins
BACKUP=/etc/muhallareads/ssh-mfa-backup

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Please run with sudo:  sudo bash $0"
USER_NAME=${SUDO_USER:-}
[[ -n $USER_NAME && $USER_NAME != root ]] || die "Run this with sudo from your normal login (e.g. ubuntu), not as root."
USER_HOME=$(getent passwd "$USER_NAME" | cut -d: -f6)

restart_ssh() {
  sshd -t || return 1
  systemctl restart ssh 2>/dev/null || systemctl restart sshd
}

if [[ ${1:-} == --undo ]]; then
  step "Turning two-factor SSH off"
  rm -f "$DROPIN"
  [[ -f $BACKUP/sshd.pam ]] && cp "$BACKUP/sshd.pam" "$PAM"
  restart_ssh
  echo "Done. SSH needs only your key again."
  exit 0
fi

if [[ -f $DROPIN ]]; then
  echo "Two-factor SSH is already on. To set it up again (e.g. new phone): sudo bash $0 --undo, then run this again."
  exit 0
fi

grep -qiE '^\s*Include\s+/etc/ssh/sshd_config\.d/' /etc/ssh/sshd_config ||
  die "This server's SSH config doesn't read /etc/ssh/sshd_config.d/, so this script can't safely change it."

step "Installing the authenticator module"
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libpam-google-authenticator >/dev/null

step "Linking your authenticator app"
cat <<'EOF'
A QR code appears below. Scan it with an authenticator app (Google Authenticator, Microsoft
Authenticator, Aegis, 2FAS...). Then type the 6-digit code the app shows.

IMPORTANT: also write down the emergency scratch codes it prints and keep them somewhere safe
(not on the VM). Each one logs you in once if you lose your phone.
EOF
# Time-based codes, no reuse, at most 3 tries per 30 seconds, allow a little clock drift.
sudo -u "$USER_NAME" -H google-authenticator --time-based --disallow-reuse --force \
  --rate-limit=3 --rate-time=30 --window-size=3 --qr-mode=UTF8
[[ -f $USER_HOME/.google_authenticator ]] || die "The authenticator wasn't set up, so nothing was changed."

step "Asking for the code at SSH login"
mkdir -p "$BACKUP"
[[ -f $BACKUP/sshd.pam ]] || cp "$PAM" "$BACKUP/sshd.pam"
# With a key login, the only thing PAM should ask for is the code, not a password (cloud users have none).
sed -i -E 's/^@include common-auth/# @include common-auth  # disabled by ssh-mfa.sh: key + code instead/' "$PAM"
grep -q pam_google_authenticator.so "$PAM" || echo 'auth required pam_google_authenticator.so' >> "$PAM"
cat > "$DROPIN" <<'EOF'
# Written by MuhallaReads deploy/oracle/ssh-mfa.sh: SSH key AND authenticator code.
UsePAM yes
KbdInteractiveAuthentication yes
AuthenticationMethods publickey,keyboard-interactive
EOF

if ! restart_ssh || ! sshd -T 2>/dev/null | grep -qi '^authenticationmethods publickey,keyboard-interactive'; then
  rm -f "$DROPIN"
  cp "$BACKUP/sshd.pam" "$PAM"
  restart_ssh || true
  die "The SSH settings didn't check out, so they were put back as they were."
fi

cat <<EOF

$(printf '\033[1m')Two-factor SSH is on.$(printf '\033[0m')

Now, WITHOUT closing this window, open a second terminal and log in as usual.
After your key, it asks for a "Verification code": type the 6 digits from the app.

  - Works: you're done. Close the old window whenever you like.
  - Doesn't work: in THIS window run   sudo bash $0 --undo
EOF
