#!/bin/bash
# Bring a console that runs under systemd (see bootstrap.sh) up to date:
# pull, build, check the playbooks, restart, check that it answers.
#
#   sudo /opt/ziggurat/console/deploy/redeploy.sh [--no-pull] [--no-restart]
#
# A restart cuts off a deploy that is running in the console. Check first.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
ENV_FILE=${CONSOLE_ENV_FILE:-/srv/ziggurat/console.env}
PULL=1; RESTART=1
for a in "$@"; do
  case "$a" in
    --no-pull) PULL=0 ;;
    --no-restart) RESTART=0 ;;
    *) echo "usage: redeploy.sh [--no-pull] [--no-restart]" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "redeploy: run as root" >&2; exit 1; }
export PATH=/opt/ansible/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

cd "$REPO"
if [ $PULL = 1 ]; then
  echo "== pull"
  git pull -q --ff-only
fi
echo "== at $(git log -1 --format='%h %s')"

echo "== build"
cd "$REPO/console"
npm ci --no-audit --no-fund
npm run build
# --no-package-lock: prune would otherwise rewrite package-lock.json, and the
# next `git pull --ff-only` would stop on the changed file.
npm prune --omit=dev --no-package-lock --no-audit --no-fund

echo "== playbooks parse"
# A playbook that does not parse must fail here, not during a deploy.
check=$(mktemp -d)
ANSIBLE_CONFIG=$REPO/console/ansible/ansible.cfg ANSIBLE_HOME=$check \
  ansible-playbook -i 'pve,' --syntax-check "$REPO/sandbox/proxmox/playbooks/create-agent-vm.yml" >/dev/null
ANSIBLE_CONFIG=$REPO/console/ansible/ansible.cfg ANSIBLE_HOME=$check \
  ansible-playbook -i 'agent_vm,' --syntax-check "$REPO/sandbox/install/install-team.yml" >/dev/null
rm -rf "$check"

[ $RESTART = 1 ] || { echo "built, not restarted"; exit 0; }

echo "== restart"
systemctl restart ziggurat-console.service
port=$(sed -n 's/^PORT=//p' "$ENV_FILE" 2>/dev/null | tail -1)
for _ in $(seq 1 20); do
  if curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:${port:-8440}/"; then
    echo "console answers on port ${port:-8440}"
    exit 0
  fi
  sleep 1
done
echo "redeploy: the console does not answer; see: journalctl -u ziggurat-console -n 50" >&2
exit 1
