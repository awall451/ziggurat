#!/bin/bash
# Agent kit installer. Run as root INSIDE an agent sandbox VM:
#   sudo bash install.sh <project-dir>     e.g. sudo bash install.sh ./oakhollow
# Expects: kit files next to this script, the project workspace already at
# $WORKSPACE (owned by `agent`), Claude Code + Node installed for `agent`.
# Idempotent. Leaves the lead timer DISABLED and control=stop: the owner starts it.
#
# Updating a VM that already runs the kit:
#   sudo bash install.sh --upgrade                 kit scripts and units only
#   sudo bash install.sh --upgrade <project-dir>   also the project's prompt and gate files
# An upgrade never touches the workspace repo, the canonical repo, the
# control file, project.env, agent.env or caps.env. Do it while the team is halted.
set -euo pipefail
KIT=$(cd "$(dirname "$0")" && pwd)
UPGRADE=0
if [ "${1:-}" = "--upgrade" ]; then UPGRADE=1; shift; fi
if [ "$UPGRADE" = 1 ]; then
  [ -f /etc/agent-kit/project.env ] || { echo "--upgrade needs an installed kit (/etc/agent-kit/project.env)"; exit 1; }
  PDIR=
  if [ -n "${1:-}" ]; then PDIR=$(cd "$1" && pwd); fi
  source /etc/agent-kit/project.env
else
  PDIR=$(cd "${1:?usage: install.sh [--upgrade] <project-dir>}" && pwd)
  source "$PDIR/project.env"
fi
: "${PROJECT:?}" "${WORKSPACE:?}" "${BARE:?}" "${STATE:?}"

if [ "$UPGRADE" = 0 ]; then
  # The gate takes its first main from here, so this must be a repository with
  # a main branch before anything is installed.
  sudo -u agent -H git -C "$WORKSPACE" rev-parse --verify -q main > /dev/null \
    || { echo "$WORKSPACE must be a git repository owned by agent with a commit on branch main"; exit 1; }
fi

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
dpkg -s python3-pil jq >/dev/null 2>&1 || apt-get install -y -q python3-pil jq >/dev/null

echo "== users"
# gaterun: runs candidate (agent-written) code during gate checks. Owns nothing that matters.
id -u gaterun >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/agent-kit-gaterun --shell /usr/sbin/nologin gaterun
# gatekeeper: owns the canonical bare repo and does all gate git operations.
# Never runs agent code. Reads the agent workspace via the agent group.
id -u gatekeeper >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/agent-kit-gatekeeper --shell /usr/sbin/nologin gatekeeper
usermod -aG agent gatekeeper
chmod 750 /home/agent
# Add (never replace) git safe.directory entries: projects add their own too.
safe_add() { sudo -u "$1" -H git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$2" \
  || sudo -u "$1" -H git config --global --add safe.directory "$2"; }
safe_add gatekeeper "$WORKSPACE/.git"
safe_add gatekeeper "$WORKSPACE"
safe_add gaterun "$BARE"
safe_add agent "$BARE"

echo "== /opt/agent-kit (root-owned, read-only to agents)"
install -d -m 755 /opt/agent-kit/bin /opt/agent-kit/gate/bin /opt/agent-kit/gate/checks
if [ -n "$PDIR" ]; then
  [ -f "$PDIR/gate-checks" ] || { echo "project dir needs a gate-checks script (see examples/)"; exit 1; }
fi
install -m 755 "$KIT"/bin/* /opt/agent-kit/bin/
install -m 755 "$KIT"/gate/bin/* /opt/agent-kit/gate/bin/
install -m 644 "$KIT/VERSION" /opt/agent-kit/VERSION
# Hook settings for the lead's session. A file that is not a JSON object would
# stop the lead from starting, so check it first.
jq -e 'type == "object"' "$KIT/lead-settings.json" >/dev/null || { echo "lead-settings.json is not a JSON object"; exit 1; }
install -m 644 "$KIT/lead-settings.json" /opt/agent-kit/lead-settings.json
if [ -n "$PDIR" ]; then
  # The project defines what "done" means: its gate-checks script.
  install -m 755 "$PDIR/gate-checks" /opt/agent-kit/gate/bin/gate-checks
  if [ -d "$PDIR/checks" ]; then install -m 644 "$PDIR"/checks/* /opt/agent-kit/gate/checks/; fi
  install -m 644 "$PDIR/CHARTER.md" "$PDIR/GATE-CONTRACT.md" "$PDIR/lead-cycle.md" /opt/agent-kit/
fi
for b in gate-status agent-kit-status agent-kit-stop agent-kit-halt agent-kit-resume agent-kit-halt-at \
         agent-kit-caps agent-kit-gate agent-kit-units agent-kit-inbox agent-kit-auth agent-kit-gate-proof owner-inbox; do
  ln -sf /opt/agent-kit/bin/$b /usr/local/bin/$b
done

echo "== state dirs"
install -d -m 755 "$STATE" "$STATE/gate"
install -d -m 755 -o agent -g agent "$STATE/ledger"
# Owner inbox: root-owned, so a file there can only come from the owner.
install -d -m 755 "$STATE/inbox" "$STATE/inbox/.inject" "$STATE/inbox/.closed"
# Outbox: the lead's replies and questions.
install -d -m 755 -o agent -g agent "$STATE/outbox" "$STATE/outbox/.seen"
[ -f "$STATE/control" ] || echo "stop awaiting owner go $(date -Is)" > "$STATE/control"
chmod 644 "$STATE/control"

if [ "$UPGRADE" = 0 ]; then
echo "== /etc/agent-kit"
install -d -m 755 /etc/agent-kit
install -m 644 "$PDIR/project.env" /etc/agent-kit/project.env
install -m 644 "$KIT/agent.env" /etc/agent-kit/agent.env
# Project-specific extra env (toolchain PATH etc.).
# The proxy address, when the sandbox does not use the default one.
if [[ ${AGENT_PROXY_URL:-} =~ ^http://[A-Za-z0-9.-]+:[0-9]{1,5}$ ]]; then
  sed -i -E "s#^(HTTPS?_PROXY|https?_proxy)=.*#\1=$AGENT_PROXY_URL#" /etc/agent-kit/agent.env
fi
if [ -f "$PDIR/agent.env.extra" ]; then cat "$PDIR/agent.env.extra" >> /etc/agent-kit/agent.env; fi
grep -q PLAYWRIGHT_BROWSERS_PATH /etc/environment || echo "PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright" >> /etc/environment
grep -q PLAYWRIGHT_BROWSERS_PATH /etc/profile.d/10-agent-sandbox.sh \
  || echo "export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright" >> /etc/profile.d/10-agent-sandbox.sh

echo "== shared Playwright browsers"
if [ ! -d /opt/ms-playwright ] && [ -d /home/agent/.cache/ms-playwright ]; then
  cp -a /home/agent/.cache/ms-playwright /opt/ms-playwright
  chown -R root:root /opt/ms-playwright; chmod -R a+rX /opt/ms-playwright
fi

echo "== agent workspace: team, docs, settings"
AS="sudo -u agent -H"
$AS mkdir -p "$WORKSPACE/.claude/agents" "$WORKSPACE/docs/agents/issues"
install -m 644 -o agent -g agent "$PDIR"/agents/*.md "$WORKSPACE/.claude/agents/"
if ! grep -q "## Agent team" "$WORKSPACE/CLAUDE.md"; then
  cat >> "$WORKSPACE/CLAUDE.md" <<'EOF'

## Agent team

This repo is developed by an autonomous agent team (a lead, area leads and their
workers;
`.claude/agents/area-lead-*`, `builder`, `scout`). Binding rules live outside the repo, read-only:
`/opt/agent-kit/CHARTER.md` and `/opt/agent-kit/GATE-CONTRACT.md`.
Team notes: `docs/agents/` (STATE.md, JOURNAL.md, ESCALATIONS.md, issues/).
Work reaches main only through the gate: `ready/<topic>` branches, `gate-status`.
Playwright browsers are preinstalled at `$PLAYWRIGHT_BROWSERS_PATH`; do not run `playwright install`.
A job the team installs for itself that runs Claude must load the same sign-in as the lead:
add `EnvironmentFile=-/etc/agent-kit/auth.env` to its unit (the file exists only when a token is stored).
EOF
  chown agent:agent "$WORKSPACE/CLAUDE.md"
fi
for f in STATE JOURNAL ESCALATIONS; do
  [ -f "$WORKSPACE/docs/agents/$f.md" ] || echo "# $f" | $AS tee "$WORKSPACE/docs/agents/$f.md" >/dev/null
done
$AS touch "$WORKSPACE/docs/agents/issues/.gitkeep"
$AS mkdir -p /home/agent/.claude
SET=/home/agent/.claude/settings.json
[ -f "$SET" ] || echo '{}' | $AS tee "$SET" >/dev/null
$AS bash -c "jq '.cleanupPeriodDays = 3650' '$SET' > '$SET.tmp' && mv '$SET.tmp' '$SET'"

echo "== commit team setup in workspace"
# A commit needs an author; a fresh agent user has none.
$AS git config --global user.name > /dev/null 2>&1 || $AS git config --global user.name "agent"
$AS git config --global user.email > /dev/null 2>&1 || $AS git config --global user.email "agent@$PROJECT.invalid"
# Nothing to commit is fine (a second run); a commit that fails is not.
$AS bash -lc "cd '$WORKSPACE' && git add -A .claude/agents CLAUDE.md docs/agents && { git diff --cached --quiet || git commit -qm 'chore(agents): add agent team definitions and notes skeleton'; }"

echo "== canonical bare repo (agents read, gate writes)"
GK="sudo -u gatekeeper -H git"
if [ ! -d "$BARE" ]; then
  install -d -m 755 -o gatekeeper -g gatekeeper "$BARE"
  $GK clone -q --bare "$WORKSPACE" "$BARE"
else
  $GK -C "$BARE" fetch -q "$WORKSPACE" "+refs/heads/main:refs/heads/main"
fi
chmod -R a+rX "$BARE"
$AS bash -lc "cd '$WORKSPACE' && (git remote get-url gate >/dev/null 2>&1 || git remote add gate '$BARE') && git fetch -q gate"
# Test-count baseline: projects may set BASELINE_TESTS in project.env; web
# projects with a package.json fall back to counting Vitest tests.
if [ -n "${BASELINE_TESTS:-}" ]; then
  TESTS=$BASELINE_TESTS
elif [ -f "$WORKSPACE/package.json" ]; then
  TESTS=$($AS bash -lc "cd '$WORKSPACE' && npx vitest run --reporter=json 2>/dev/null" | jq -r '.numPassedTests // 0' || echo 0)
fi
[ -f "$STATE/gate/baseline-tests" ] && [ "$(cat "$STATE/gate/baseline-tests")" != 0 ] || echo "${TESTS:-0}" > "$STATE/gate/baseline-tests"
echo "   main: $($GK -C "$BARE" log --oneline -1 main)   baseline tests: $(cat "$STATE/gate/baseline-tests")"
fi # end of first-install-only steps

echo "== systemd"
install -m 644 "$KIT"/systemd/* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now agent-kit-gate.timer agent-kit-tick.timer >/dev/null
if [ "$UPGRADE" = 1 ]; then
  echo "   kit $(cat "$KIT/VERSION") installed. Lead timer and control file left as they were."
else
  echo "   gate timer enabled. lead timer NOT enabled (owner starts it)."
fi
echo "== done"
