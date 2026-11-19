#!/bin/bash
# agent-wall-check: prove the sandbox wall from INSIDE an agent VM.
# Run as the agent user:  sudo -u agent -H /usr/local/bin/agent-wall-check
# Exit 0 only if every "must fail" really fails and every "must work" works.
# Installed by create-agent-vm.yml (cloud-init) and run before the
# "provisioned" snapshot. Re-run any time the proxy allow-list changes.

# Addresses written at provisioning: what the agent must never reach (LAN
# router, Proxmox host, other agent VMs) and where the gateway is.
[ -f /etc/agent-sandbox.env ] && . /etc/agent-sandbox.env
LAN_GW=${LAN_GW:-192.168.1.1}
PVE_IP=${PVE_IP:-192.168.1.10}
GW_IP=${GW_IP:-10.66.0.1}
PROXY="${HTTPS_PROXY:-${PROXY_URL:-http://$GW_IP:3128}}"
fail=0
T=6

pass() { printf '  ok    %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }

# must_fail <label> <cmd...>: the command must NOT succeed
must_fail() { local l=$1; shift; if "$@" >/dev/null 2>&1; then bad "$l (was reachable)"; else pass "$l blocked"; fi; }
# must_work <label> <cmd...>
must_work() { local l=$1; shift; if "$@" >/dev/null 2>&1; then pass "$l"; else bad "$l (unreachable)"; fi; }

direct() { curl -s -o /dev/null --noproxy '*' --max-time "$T" "$@"; }
# https:// via proxy: a squid denial fails the CONNECT -> nonzero exit, while
# any real HTTP answer from the site (even 404) is exit 0 = reachable.
# http:// via proxy: squid answers 403 itself, so those calls add -f.
viaproxy() { curl -s -o /dev/null -x "$PROXY" --max-time "$T" "$@"; }
tcp() { timeout "$T" bash -c "exec 3<>/dev/tcp/$1/$2" ; }

echo "== identity"
[ "$(id -u)" != 0 ] && pass "not root ($(id -un))" || bad "running as root"
sudo -n true 2>/dev/null && bad "agent has passwordless sudo" || pass "no sudo"
[ -z "${ANTHROPIC_API_KEY:-}" ] && pass "no ANTHROPIC_API_KEY (no API billing)" || bad "ANTHROPIC_API_KEY is set"
if ls ~/.ssh/id_* >/dev/null 2>&1; then bad "private SSH keys present in ~/.ssh"; else pass "no SSH private keys"; fi

echo "== direct network (no proxy) must be dead"
must_fail "internet 1.1.1.1:443"        direct https://1.1.1.1
must_fail "internet by name"            direct https://example.com
must_fail "home router $LAN_GW"         tcp "$LAN_GW" 80
must_fail "PVE web $PVE_IP:8006"       tcp "$PVE_IP" 8006
must_fail "PVE ssh $PVE_IP:22"         tcp "$PVE_IP" 22
must_fail "gateway ssh $GW_IP:22"       tcp "$GW_IP" 22
must_fail "tailscale 100.100.100.100"   tcp 100.100.100.100 80
must_fail "DNS to 1.1.1.1"              tcp 1.1.1.1 53

echo "== other agent VMs on the bridge must be out of reach"
# A peer that is switched off also looks blocked: the playbook reads the
# loaded firewall rules as root as well.
if [ -n "${PEER_IPS:-}" ]; then
  for ip in $PEER_IPS; do must_fail "agent VM $ip:22" tcp "$ip" 22; done
else
  pass "no other agent VMs were known at provisioning"
fi

echo "== proxy must refuse non-allowed targets"
must_fail "proxy -> example.com"        viaproxy https://example.com
must_fail "proxy -> github.com"         viaproxy https://github.com
must_fail "proxy -> PVE $PVE_IP"       viaproxy -k "https://$PVE_IP:8006"
must_fail "proxy -> router $LAN_GW"     viaproxy -f "http://$LAN_GW/"
must_fail "proxy -> plain-http port 8080" viaproxy -f http://registry.npmjs.org:8080/

echo "== proxy must allow what agents need"
must_work "api.anthropic.com"           viaproxy https://api.anthropic.com
must_work "claude.ai"                   viaproxy https://claude.ai
must_work "registry.npmjs.org"          viaproxy -f https://registry.npmjs.org/
must_work "nodejs.org"                  viaproxy -f https://nodejs.org/dist/index.json

echo "== tools"
command -v node >/dev/null && pass "node $(node --version)" || bad "node missing"
command -v claude >/dev/null || [ -x ~/.local/bin/claude ] && pass "claude installed" || bad "claude missing"

echo
if [ $fail = 0 ]; then echo "WALL OK"; else echo "WALL CHECK FAILED"; fi
exit $fail
