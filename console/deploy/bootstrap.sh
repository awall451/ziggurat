#!/bin/bash
# Set up a fresh Ubuntu 22.04+ or Debian 12 container (or VM) to run the Ziggurat Console
# without Docker: packages, Node, ansible-core, a service user, the data
# folders, the console's own ssh key, a firewall and the systemd unit.
#
# Run as root inside the container. sandbox/proxmox/playbooks/create-console-ct.yml
# does that for you. Safe to run again: it only adds what is missing.
#
# Settings come from the environment (or from bootstrap.env next to this file):
#   CONSOLE_ALLOW_FROM  address(es) allowed to reach ssh and the console,
#                       comma separated. Everything else is dropped.   (required)
#   CONSOLE_PORT        port the console listens on                    (8440)
#   ADMIN_USER          admin login with sudo, gets root's ssh keys    (admin)
#   REPO_URL            where to clone the repository from             (required on first run)
#   REPO_REF            branch to run                                  (main)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
[ -f "$HERE/bootstrap.env" ] && . "$HERE/bootstrap.env"

CONSOLE_PORT=${CONSOLE_PORT:-8440}
ADMIN_USER=${ADMIN_USER:-admin}
REPO_REF=${REPO_REF:-main}
REPO=/opt/ziggurat
ROOT=/srv/ziggurat
NODE_VERSION=22.12.0
ANSIBLE_SPEC='ansible-core~=2.18.0'

die() { echo "bootstrap: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root"
[ -n "${CONSOLE_ALLOW_FROM:-}" ] || die "CONSOLE_ALLOW_FROM is not set"
[[ "$CONSOLE_ALLOW_FROM" =~ ^[0-9./,]+$ ]] || die "CONSOLE_ALLOW_FROM: addresses only"
[[ "$CONSOLE_PORT" =~ ^[0-9]{2,5}$ ]] || die "CONSOLE_PORT: a port number"
[[ "$ADMIN_USER" =~ ^[a-z][a-z0-9_-]{0,30}$ ]] || die "ADMIN_USER: a plain login name"

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends \
  openssh-server openssh-client sudo rsync git curl xz-utils ca-certificates \
  python3 python3-venv nftables

echo "== node $NODE_VERSION"
if [ "$(node --version 2>/dev/null)" != "v$NODE_VERSION" ]; then
  tmp=$(mktemp -d)
  tar="node-v$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL -o "$tmp/$tar" "https://nodejs.org/dist/v$NODE_VERSION/$tar"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$tmp" && grep " $tar\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$tmp/$tar" -C /usr/local --strip-components=1 --no-same-owner
  rm -rf "$tmp"
fi

echo "== ansible-core"
# From pip, in its own venv: the same version the Docker image uses.
# It needs Python 3.11 or newer; Ubuntu 22.04 has that as a separate package.
[ -x /opt/ansible/bin/ansible-playbook ] || {
  PY=python3
  if ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))'; then
    apt-get install -y -q --no-install-recommends python3.11 python3.11-venv
    PY=python3.11
  fi
  "$PY" -m venv /opt/ansible
  /opt/ansible/bin/pip install --no-cache-dir -q "$ANSIBLE_SPEC"
}

echo "== users"
# The service user owns the data and nothing else: not the code, not the unit.
id -u console >/dev/null 2>&1 || useradd --system --uid 1000 --home-dir "$ROOT/home" --shell /usr/sbin/nologin console
id -u "$ADMIN_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash -G sudo "$ADMIN_USER"
install -d -m 700 -o "$ADMIN_USER" -g "$ADMIN_USER" "/home/$ADMIN_USER/.ssh"
[ -f /root/.ssh/authorized_keys ] && install -m 600 -o "$ADMIN_USER" -g "$ADMIN_USER" \
  /root/.ssh/authorized_keys "/home/$ADMIN_USER/.ssh/authorized_keys"
echo "$ADMIN_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$ADMIN_USER"
chmod 440 "/etc/sudoers.d/90-$ADMIN_USER"

echo "== folders"
install -d -m 755 -o root -g root "$ROOT"
for d in config console-data fleet transcripts projects; do
  install -d -m 750 -o console -g console "$ROOT/$d"
done
install -d -m 700 -o console -g console "$ROOT/home" "$ROOT/home/.ssh" "$ROOT/ssh"

echo "== the console's own ssh key"
# Made here and never copied anywhere. Only the public half leaves this machine.
KEY=$ROOT/ssh/key
[ -f "$KEY" ] || sudo -u console ssh-keygen -q -t ed25519 -N '' -C "ziggurat-console@$(hostname)" -f "$KEY"
chmod 600 "$KEY"

echo "== sshd: keys only"
cat > /etc/ssh/sshd_config.d/10-console.conf <<'EOF'
PasswordAuthentication no
PermitRootLogin prohibit-password
AllowTcpForwarding no
EOF
systemctl enable -q ssh
systemctl restart ssh

echo "== firewall"
# There is no login on the console itself: who can connect is the protection.
cat > /etc/nftables.conf <<EOF
#!/usr/sbin/nft -f
flush ruleset
table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;
    iif lo accept
    ct state established,related accept
    ip protocol icmp accept
    ip saddr { $CONSOLE_ALLOW_FROM } tcp dport { 22, $CONSOLE_PORT } accept
  }
  chain forward { type filter hook forward priority 0; policy drop; }
}
EOF
nft -c -f /etc/nftables.conf
systemctl enable -q nftables
systemctl restart nftables

echo "== repository"
if [ ! -d "$REPO/.git" ]; then
  [ -n "${REPO_URL:-}" ] || die "REPO_URL is not set and $REPO does not exist"
  git clone -q --branch "$REPO_REF" "$REPO_URL" "$REPO"
fi

echo "== unit and settings"
install -m 644 "$REPO/console/deploy/ziggurat-console.service" /etc/systemd/system/ziggurat-console.service
if [ ! -f "$ROOT/console.env" ]; then
  sed "s/^PORT=.*/PORT=$CONSOLE_PORT/" "$REPO/console/deploy/console.env.example" > "$ROOT/console.env"
  chmod 640 "$ROOT/console.env"; chgrp console "$ROOT/console.env"
fi
systemctl daemon-reload
systemctl enable -q ziggurat-console.service

echo "== build"
bash "$REPO/console/deploy/redeploy.sh" --no-pull --no-restart

echo
echo "bootstrap OK. The console's public key (add it where the console must log in):"
cat "$KEY.pub"
echo "Next: fill $ROOT/config and $ROOT/console.env, write $ROOT/home/.ssh/config, then"
echo "  systemctl start ziggurat-console"
