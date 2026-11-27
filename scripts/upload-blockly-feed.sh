#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${SSHPASS:?Missing TRIGGER_SERVER_PASSWORD}" "${FEED_KNOWN_HOSTS:?Missing DOMESTIC_FEED_KNOWN_HOSTS}"
if [[ ! "$FEED_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ||
      ! "$FEED_USER" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ||
      ! "$FEED_PORT" =~ ^[1-9][0-9]{0,4}$ ]]; then
  echo 'Invalid domestic SSH host, user or port' >&2
  exit 1
fi
# ssh passes remote commands through the login shell. Limit arguments to literal path/version characters.
for dir in "$STAGING_ROOT" "$PUBLIC_DIR"; do
  if [[ ! "$dir" =~ ^(/[A-Za-z0-9._-]+)+$ || "$dir/" == */../* || "$dir/" == */./* ]]; then
    echo 'Set absolute DOMESTIC_FEED_STAGING_ROOT and DOMESTIC_FEED_PUBLIC_DIR without dot components' >&2
    exit 1
  fi
done
[[ "$GITHUB_RUN_ID" =~ ^[1-9][0-9]*$ && "$RELEASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]

ssh_dir=$(mktemp -d /tmp/blockly-feed-ssh.XXXXXXXX)
trap 'rm -rf -- "$ssh_dir"' EXIT
printf '%s\n' "$FEED_KNOWN_HOSTS" > "$ssh_dir/known_hosts"
cat > "$ssh_dir/config" <<EOF
Host domestic-feed
  HostName $FEED_HOST
  Port $FEED_PORT
  User $FEED_USER
  HostKeyAlias domestic-feed
  StrictHostKeyChecking yes
  UserKnownHostsFile $ssh_dir/known_hosts
  GlobalKnownHostsFile /dev/null
  PreferredAuthentications keyboard-interactive,password
  NumberOfPasswordPrompts 1
  ConnectTimeout 20
  ServerAliveInterval 30
EOF

stage="$STAGING_ROOT/blockly-$GITHUB_RUN_ID"
remote=(sshpass -e ssh -F "$ssh_dir/config" domestic-feed)
"${remote[@]}" python3 - "$STAGING_ROOT" "$PUBLIC_DIR" "$stage" <<'PY'
from pathlib import Path
import sys

root, public, stage = map(Path, sys.argv[1:])
root, public = root.resolve(strict=True), public.resolve(strict=True)
if (not root.is_dir() or not public.is_dir() or root == public or root in public.parents
        or public in root.parents or root.stat().st_dev != public.stat().st_dev):
    sys.exit("Need separate staging and serving directories on one filesystem")
if stage.is_symlink() or stage.resolve().parent != root:
    sys.exit("Unexpected staging destination")
stage.mkdir(mode=0o700, exist_ok=True)
PY
rsync --checksum --partial-dir=.rsync-partial -r -e "sshpass -e ssh -F $ssh_dir/config" \
  "$RUNNER_TEMP/blockly-bundle/" "domestic-feed:$stage/"
"${remote[@]}" python3 - publish "$RELEASE_VERSION" "$stage" "$PUBLIC_DIR" < scripts/publish-blockly-feed.py
