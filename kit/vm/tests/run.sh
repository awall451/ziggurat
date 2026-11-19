#!/bin/bash
# Tests for the kit's owner-inbox, hook, caps, schedule, sign-in and unit-scan scripts.
# Runs anywhere, as any user, in a temp folder:   bash kit/vm/tests/run.sh
# (Scripts that drive systemd, agent-kit-halt and agent-kit-resume, are only
# syntax-checked here; they are exercised on a real VM.)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
BIN=$HERE/../bin
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export AGENT_KIT_ETC=$T/etc AGENT_KIT_STATE=$T/state AGENT_KIT_AGENT_HOME=$T/home
mkdir -p "$T/etc" "$T/state/gate" "$T/state/outbox" "$T/home/.config/systemd/user" "$T/work"
printf 'PROJECT=demo\nWORKSPACE=%s/ws\nBARE=%s/bare\nSTATE=%s/state\nMAX_CYCLES_PER_DAY=6\nCYCLE_BUDGET_USD=40\nLEAD_MODEL=fable\nFALLBACK_MODEL=opus\n' "$T" "$T" "$T" > "$T/etc/project.env"
S=$T/state

pass=0 fail=0
ok() { pass=$((pass + 1)); }
no() { fail=$((fail + 1)); echo "FAIL: $1"; }
check() { if eval "$2"; then ok; else no "$1"; fi; }           # check "name" 'shell test'
refuse() { if "${@:2}" > /dev/null 2>&1; then no "$1 (should be refused)"; else ok; fi; }

# A message archive is a tar of a folder holding body.md and, optionally, att/.
tarball() { tar -c -C "$T/work/$1" .; }

echo "== agent-kit-inbox"
U=20260101T100000Z-o-urgent1 P=20260101T100001Z-o-prio1 N=20260101T100002Z-o-note1
mkdir -p "$T/work/u/att"; echo "Fix the save bug. Code word QUARTZ." > "$T/work/u/body.md"; echo png > "$T/work/u/att/shot.png"
tarball u | "$BIN/agent-kit-inbox" put $U urgent owner > /dev/null
check "urgent message stored" '[ -f "$S/inbox/$U/message.md" ] && [ -f "$S/inbox/$U/att/shot.png" ]'
check "header written by the script" 'grep -q "^Tier: urgent$" "$S/inbox/$U/message.md" && grep -q "^From: owner$" "$S/inbox/$U/message.md" && grep -q "^Id: $U$" "$S/inbox/$U/message.md"'
check "urgent is marked for injection" '[ "$(cat "$S/inbox/.inject/$U")" = urgent ]'
check "no work folder left behind" '! ls -d "$S"/inbox/.tmp-* > /dev/null 2>&1'
mkdir -p "$T/work/p"; echo "Prefer smaller rooms." > "$T/work/p/body.md"
tarball p | "$BIN/agent-kit-inbox" put $P priority owner > /dev/null
mkdir -p "$T/work/n"; echo "Nice work on the menu." > "$T/work/n/body.md"
tarball n | "$BIN/agent-kit-inbox" put $N note owner > /dev/null
check "note is not marked for injection" '[ ! -e "$S/inbox/.inject/$N" ] && [ -e "$S/inbox/.inject/$P" ]'

refuse "duplicate id" bash -c "tar -c -C '$T/work/n' . | '$BIN/agent-kit-inbox' put $N note owner"
refuse "bad id" bash -c "tar -c -C '$T/work/n' . | '$BIN/agent-kit-inbox' put ../../etc/x note owner"
refuse "bad tier" bash -c "tar -c -C '$T/work/n' . | '$BIN/agent-kit-inbox' put 20260101T100003Z-o-x now owner"
refuse "bad sender" bash -c "tar -c -C '$T/work/n' . | '$BIN/agent-kit-inbox' put 20260101T100003Z-o-x note 'me; rm -rf /'"
mkdir -p "$T/work/sym/att"; echo hi > "$T/work/sym/body.md"; ln -s /etc/passwd "$T/work/sym/att/passwd"
refuse "symlink in archive" bash -c "tar -c -C '$T/work/sym' . | '$BIN/agent-kit-inbox' put 20260101T100004Z-o-sym note owner"
mkdir -p "$T/work/deep/att/sub"; echo hi > "$T/work/deep/body.md"; echo x > "$T/work/deep/att/sub/f"
refuse "nested folder in att" bash -c "tar -c -C '$T/work/deep' . | '$BIN/agent-kit-inbox' put 20260101T100005Z-o-deep note owner"
mkdir -p "$T/work/extra"; echo hi > "$T/work/extra/body.md"; echo x > "$T/work/extra/evil.sh"
refuse "file outside att" bash -c "tar -c -C '$T/work/extra' . | '$BIN/agent-kit-inbox' put 20260101T100006Z-o-extra note owner"
mkdir -p "$T/work/big"; head -c 70000 /dev/zero | tr '\0' a > "$T/work/big/body.md"
refuse "oversized text" bash -c "tar -c -C '$T/work/big' . | '$BIN/agent-kit-inbox' put 20260101T100007Z-o-big note owner"
mkdir -p "$T/work/nobody"; echo x > "$T/work/nobody/other.md"
refuse "archive without body" bash -c "tar -c -C '$T/work/nobody' . | '$BIN/agent-kit-inbox' put 20260101T100008Z-o-nobody note owner"
check "refused messages left nothing" '[ "$("$BIN/agent-kit-inbox" list | wc -l)" = 3 ]'

echo "== owner-inbox-hook"
hook() { ZIGGURAT_LEAD_SESSION=${3-LEAD} "$BIN/owner-inbox-hook" <<< "{\"session_id\":\"$1\",\"agent_id\":$2}"; }
check "another session gets nothing" '[ -z "$(hook OTHER null)" ]'
check "no lead session set: nothing" '[ -z "$(hook LEAD null "")" ]'
sub=$(hook LEAD '"agent1"')
check "agent gets the urgent nudge" 'grep -q "urgent message ($U)" <<< "$sub" && grep -q "agent-kit owner notice" <<< "$sub"'
start=$(ZIGGURAT_LEAD_SESSION=LEAD "$BIN/owner-inbox-hook" subagent-start <<< '{"session_id":"LEAD","agent_id":"agent1"}')
check "agents are told at start that the notice is genuine" 'jq -e ".hookSpecificOutput.hookEventName == \"SubagentStart\"" <<< "$start" > /dev/null && grep -q "agent-kit owner notice" <<< "$start"'
check "no start notice outside the lead session" '[ -z "$(ZIGGURAT_LEAD_SESSION=LEAD "$BIN/owner-inbox-hook" subagent-start <<< "{\"session_id\":\"OTHER\"}")" ]'
check "nudge never carries the message text" '! grep -q QUARTZ <<< "$sub"'
check "nudge does not mention the priority message" '! grep -q "$P" <<< "$sub"'
check "nudge is given once per agent" '[ -z "$(hook LEAD "\"agent1\"")" ] && [ -n "$(hook LEAD "\"agent2\"")" ]'
lead=$(hook LEAD null)
check "lead gets valid hook JSON" 'jq -e ".hookSpecificOutput.hookEventName == \"PostToolUse\"" <<< "$lead" > /dev/null'
check "lead gets both messages with text" 'jq -r .hookSpecificOutput.additionalContext <<< "$lead" | grep -q QUARTZ && jq -r .hookSpecificOutput.additionalContext <<< "$lead" | grep -q "$P"'
check "note is never injected" '! grep -q "$N" <<< "$lead"'
check "lead gets each message once" '[ -z "$(hook LEAD null)" ]'
check "no nudge once the lead has seen it" '[ -z "$(hook LEAD "\"agent3\"")" ]'

echo "== owner-inbox"
check "list shows three open messages" '[ "$("$BIN/owner-inbox" list | wc -l)" = 3 ]'
shown=$("$BIN/owner-inbox" show $U)
check "show prints text and attachment path" 'grep -q QUARTZ <<< "$shown" && grep -q "att/shot.png" <<< "$shown"'
refuse "show with a path instead of an id" "$BIN/owner-inbox" show ../../etc/passwd
rm -rf "$S/outbox/.seen"
out=$("$BIN/owner-inbox" prompt)
check "prompt has the protocol and all open messages" 'grep -q "## Owner inbox" <<< "$out" && grep -q QUARTZ <<< "$out" && grep -q "smaller rooms" <<< "$out" && grep -q "Nice work" <<< "$out"'
check "prompt marks messages as seen" '[ -e "$S/outbox/.seen/$U" ] && [ -e "$S/outbox/.seen/$P" ]'
check "hook stays quiet for messages shown in the prompt" '[ -z "$(hook LEAD null)" ]'
echo "Planned for cycle 12, see STATE.md" | "$BIN/owner-inbox" reply $P planned > /dev/null
listed=$("$BIN/owner-inbox" list)
check "planned keeps the message open" 'grep -q "$P.*planned" <<< "$listed"'
echo "evidence" > "$T/work/proof.png"
echo "Fixed in work/save-bug." | "$BIN/owner-inbox" reply $U done --attach "$T/work/proof.png" > /dev/null
listed=$("$BIN/owner-inbox" list)
check "done closes the message" '! grep -q "$U" <<< "$listed"'
check "reply file is machine readable" '[ "$(head -1 "$S/outbox/$U.md")" = "Status: done" ] && grep -q "^Re: $U$" "$S/outbox/$U.md"'
check "reply attachment copied" '[ -f "$S/outbox/$U.d/proof.png" ]'
refuse "reply with an unknown status" bash -c "echo x | '$BIN/owner-inbox' reply $N maybe"
refuse "reply to a message that does not exist" bash -c "echo x | '$BIN/owner-inbox' reply 20250101T000000Z-o-nope done"
"$BIN/agent-kit-inbox" close $N > /dev/null
listed=$("$BIN/owner-inbox" list)
check "owner can close a message" '! grep -q "$N" <<< "$listed" && [ -e "$S/inbox/.closed/$N" ]'

refuse "ask without a default" bash -c "echo q | '$BIN/owner-inbox' ask menu-style"
ask=$(echo "Grid or list for the field menu?" | "$BIN/owner-inbox" ask menu-style --default "Go with a list" | sed -n 's/^asked: \([^.]*\)\..*/\1/p')
check "ask is written with its default" '[ -f "$S/outbox/$ask.md" ] && grep -q "^Default: Go with a list$" "$S/outbox/$ask.md"'
asks=$("$BIN/owner-inbox" asks)
check "ask shows as unanswered" 'grep -q "$ask  no answer yet" <<< "$asks"'
mkdir -p "$T/work/a"; echo "List is fine." > "$T/work/a/body.md"
tarball a | "$BIN/agent-kit-inbox" put 20260101T110000Z-o-answer1 note owner "$ask" > /dev/null
asks=$("$BIN/owner-inbox" asks)
check "owner's answer links to the ask" 'grep -q "$ask  answered in 20260101T110000Z-o-answer1" <<< "$asks"'
refuse "answer with a bad ask id" bash -c "tar -c -C '$T/work/a' . | '$BIN/agent-kit-inbox' put 20260101T110001Z-o-answer2 note owner 'x; id'"

echo "== agent-kit-caps"
"$BIN/agent-kit-caps" set MAX_CYCLES_PER_DAY 3 > /dev/null
"$BIN/agent-kit-caps" set LEAD_MODEL opus > /dev/null
"$BIN/agent-kit-caps" set MAX_CYCLES_PER_DAY 4 > /dev/null
check "caps are stored, last value wins" '[ "$(sort "$T/etc/caps.env" | tr "\n" " ")" = "LEAD_MODEL=opus MAX_CYCLES_PER_DAY=4 " ]'
caps=$("$BIN/agent-kit-caps" show)
check "show merges caps over the defaults" 'grep -qx "MAX_CYCLES_PER_DAY=4" <<< "$caps" && grep -qx "CYCLE_BUDGET_USD=40" <<< "$caps"'
refuse "unknown key" "$BIN/agent-kit-caps" set PATH /tmp
refuse "command in a value" "$BIN/agent-kit-caps" set LEAD_MODEL 'opus; id'
refuse "budget out of range" "$BIN/agent-kit-caps" set CYCLE_BUDGET_USD 9999
refuse "negative cap" "$BIN/agent-kit-caps" set MAX_CYCLES_PER_DAY -1
check "caps.env holds only KEY=VALUE lines" '! grep -qvE "^[A-Z_]+=[A-Za-z0-9.-]+$" "$T/etc/caps.env"'

echo "== agent-kit-halt-at, agent-kit-gate"
"$BIN/agent-kit-halt-at" set $(($(date +%s) + 3600)) weekly usage > /dev/null
check "stop time stored with its reason" 'grep -qE "^[0-9]+ weekly usage$" "$S/halt-at"'
refuse "stop time in the past" "$BIN/agent-kit-halt-at" set 1000000000
refuse "stop time that is not a number" "$BIN/agent-kit-halt-at" set tomorrow
"$BIN/agent-kit-halt-at" clear > /dev/null
check "stop time cleared" '[ ! -e "$S/halt-at" ]'
"$BIN/agent-kit-gate" pause waiting for review > /dev/null
gate=$("$BIN/agent-kit-gate" show)
check "gate pause flag set" '[ -f "$S/gate/paused" ] && grep -q "gate paused" <<< "$gate"'
"$BIN/agent-kit-gate" resume > /dev/null
check "gate pause flag removed" '[ ! -e "$S/gate/paused" ]'

echo "== agent-kit-units"
UD=$T/home/.config/systemd/user
printf '[Service]\nExecStart=/usr/bin/claude -p "plan"\n' > "$UD/direct.service"
printf '#!/bin/bash\nexec claude -p "$(cat plan.md)"\n' > "$T/home/run-strategist.sh"
printf '[Service]\nExecStart=%%h/run-strategist.sh\n' > "$UD/strategist.service"
printf '[Service]\nExecStart=/usr/bin/python3 -m bot\n' > "$UD/bot.service"
printf '[Service]\nExecStart=/usr/bin/claude -p "report"\n' > "$UD/report.service"
printf '[Service]\nExecStart=/usr/bin/sleep 1\n' > "$UD/listed.service"
echo "report.service" > "$T/etc/keep-units"
printf '# units that spend tokens\nlisted.service\n' > "$T/etc/token-units"
units=$("$BIN/agent-kit-units")
check "unit that runs claude directly" 'grep -q "^direct.service token " <<< "$units"'
check "unit whose script runs claude" 'grep -q "^strategist.service token " <<< "$units"'
check "plain service is left alone" 'grep -q "^bot.service other " <<< "$units"'
check "keep list wins" 'grep -q "^report.service keep " <<< "$units"'
check "token list adds a unit" 'grep -q "^listed.service token " <<< "$units"'

echo "== syntax"
for f in "$BIN"/* "$HERE/../install.sh" "$HERE/../gate/bin/gate-run"; do
  check "bash -n $(basename "$f")" 'bash -n "$f"'
done
echo "== agent-kit-auth"
printf 'HTTPS_PROXY=http://10.66.0.1:3128\nPATH=/usr/bin:/bin\n' > "$T/etc/agent.env"
# A stand-in for `claude auth status`: logged in only when the token reaches it.
cat > "$T/claude" <<'STUB'
#!/bin/bash
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then echo '{"loggedIn":true,"authMethod":"api_key"}'; exit 0; fi
if [ "${CLAUDE_CODE_OAUTH_TOKEN:-}" = "sk-ant-oat01-TESTTOKENTESTTOKEN_abc-123" ]; then
  echo '{"loggedIn":true,"authMethod":"oauth_token","subscriptionType":"max","email":"someone@example.com","orgName":"Private Org"}'
else
  echo '{"loggedIn":false,"authMethod":"none"}'; exit 1
fi
STUB
chmod +x "$T/claude"
export AGENT_KIT_CLAUDE=$T/claude
st=$("$BIN/agent-kit-auth" status); rc=$?
check "no token: not signed in, exit 1" '[ $rc = 1 ] && [ "$(jq -r ".loggedIn" <<< "$st")" = false ] && [ "$(jq -r ".tokenStored" <<< "$st")" = false ]'
set_out=$(printf '  sk-ant-oat01-TESTTOKENTESTTOKEN_abc-123 \r\n' | "$BIN/agent-kit-auth" set-token 2>&1)
check "set-token stores one checked line" '[ "$(cat "$T/etc/auth.env")" = "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-TESTTOKENTESTTOKEN_abc-123" ]'
check "set-token never prints the token" '! grep -q "TESTTOKEN" <<< "$set_out"'
check "auth.env is not readable by others" '[ "$(stat -c %a "$T/etc/auth.env")" = 640 ]'
st=$("$BIN/agent-kit-auth" status); rc=$?
check "token: signed in, exit 0" '[ $rc = 0 ] && [ "$(jq -r ".authMethod" <<< "$st")" = oauth_token ] && [ "$(jq -r ".tokenStored" <<< "$st")" = true ]'
check "status shows no account details and no token" '! grep -qE "example.com|Private Org|TESTTOKEN" <<< "$st"'
refuse "token with shell text" bash -c "printf 'abc\$(id)defghijklmnopqrstuvwxyz\n' | '$BIN/agent-kit-auth' set-token"
refuse "token with a newline trick" bash -c "printf 'short\n' | '$BIN/agent-kit-auth' set-token"
refuse "empty token" bash -c ": | '$BIN/agent-kit-auth' set-token"
check "a refused token leaves the stored one" 'grep -q "TESTTOKENTESTTOKEN_abc-123" "$T/etc/auth.env"'
echo 'ANTHROPIC_API_KEY=sk-ant-api-xyz' >> "$T/etc/agent.env"
st=$("$BIN/agent-kit-auth" status); rc=$?
check "an API key is reported and never used" '[ $rc = 1 ] && [ "$(jq -r ".apiKeySet" <<< "$st")" = true ] && [ "$(jq -r ".authMethod" <<< "$st")" = oauth_token ]'
refuse "set-token while an API key is configured" bash -c "printf 'sk-ant-oat01-TESTTOKENTESTTOKEN_abc-123\n' | '$BIN/agent-kit-auth' set-token"
sed -i '/ANTHROPIC_API_KEY/d' "$T/etc/agent.env"
"$BIN/agent-kit-auth" clear > /dev/null
check "clear removes the token" '[ ! -e "$T/etc/auth.env" ]'
refuse "unknown command" "$BIN/agent-kit-auth" print-token
check "the lead unit loads the token file only if it exists" 'grep -qx "EnvironmentFile=-/etc/agent-kit/auth.env" "$HERE/../systemd/agent-kit-lead.service"'

echo "== gate-run --proof, agent-kit-gate-proof"
# The real gate runner and proof script against a small repository; only the
# project's checks are a stand-in (they count the test files).
export AGENT_KIT_OPT=$T/opt AGENT_KIT_RUN=$T/run
mkdir -p "$T/opt/gate/bin" "$T/run"
cp "$HERE/../gate/bin/gate-run" "$T/opt/gate/bin/gate-run"
cat > "$T/opt/gate/bin/gate-checks" <<'STUB'
#!/bin/bash
cd "$1" || exit 2
[ -f BROKEN ] && { echo "STEP unit FAIL 0s"; exit 1; }
echo "STEP unit ok 0s"
echo "TESTS_PASSED=$(ls tests/test_*.py 2>/dev/null | wc -l)"
STUB
chmod +x "$T/opt/gate/bin/gate-checks"
G() { git -C "$T/ws" -c user.name=t -c user.email=t@t.invalid "$@"; }
git init -q -b main "$T/ws"
mkdir -p "$T/ws/tests"; echo a > "$T/ws/tests/test_a.py"; echo b > "$T/ws/tests/test_b.py"
G add -A; G commit -q -m seed
git clone -q --bare "$T/ws" "$T/bare"
G remote add gate "$T/bare"; G fetch -q gate
echo 2 > "$S/gate/baseline-tests"
echo "stop owner halt for the test" > "$S/control"
main0=$(git -C "$T/bare" rev-parse main)

"$T/opt/gate/bin/gate-run"
G branch -f ready/work-x main > /dev/null
"$T/opt/gate/bin/gate-run"
check "a halted gate judges nothing" '[ ! -e "$S/gate/results/work-x.json" ]'
refuse "proof mode takes only a gate-proof topic" "$T/opt/gate/bin/gate-run" --proof work-x
refuse "proof mode needs a topic" "$T/opt/gate/bin/gate-run" --proof

echo "GATE_PROOF_DELETE=tests/test_b.py" >> "$T/etc/project.env"
proof=$("$BIN/agent-kit-gate-proof" run); rc=$?
check "proof passes on a working gate" '[ $rc = 0 ] && [ "$(jq -r .ok <<< "$proof")" = true ]'
check "the good change was merged" '[ "$(jq -r .good.status <<< "$proof")" = merged ] && git -C "$T/bare" cat-file -e main:docs/agents/GATE-PROOF.md'
check "main moved by exactly one commit" '[ "$(git -C "$T/bare" rev-parse main~1)" = "$main0" ]'
check "deleting a test was refused, for the right reason" '[ "$(jq -r .drop.status <<< "$proof")" = failed ] && grep -q "dropped from 2 to 1" <<< "$(jq -r .drop.detail <<< "$proof")"'
check "the test file is still on main" 'git -C "$T/bare" cat-file -e main:tests/test_b.py'
check "the proof branches are gone, other work is untouched" '[ -z "$(G branch --list "ready/gate-proof-*")" ] && [ -n "$(G branch --list ready/work-x)" ]'
check "the team is still halted and its own branch was not judged" 'grep -q "^stop owner halt for the test" "$S/control" && [ ! -e "$S/gate/results/work-x.json" ]'
check "no worktree left behind" '[ "$(G worktree list | wc -l)" = 1 ]'
check "status repeats the last result" '[ "$("$BIN/agent-kit-gate-proof" status | jq -r .ok)" = true ]'

# A gate that lets a test deletion through must fail the proof.
cat > "$T/opt/gate/bin/gate-checks" <<'STUB'
#!/bin/bash
echo "STEP unit ok 0s"; echo "TESTS_PASSED=99"
STUB
proof=$("$BIN/agent-kit-gate-proof" run); rc=$?
check "proof fails when the gate merges a test deletion" '[ $rc = 1 ] && [ "$(jq -r .ok <<< "$proof")" = false ] && [ "$(jq -r .drop.status <<< "$proof")" = merged ]'

# A gate whose checks fail on everything cannot merge the good change.
G fetch -q gate; G checkout -q -B main gate/main; touch "$T/ws/BROKEN"; G add -A; G commit -q -m broken
git -C "$T/bare" fetch -q "$T/ws" "+main:main"; G fetch -q gate
cat > "$T/opt/gate/bin/gate-checks" <<'STUB'
#!/bin/bash
cd "$1" || exit 2
[ -f BROKEN ] && { echo "STEP unit FAIL 0s"; exit 1; }
echo "TESTS_PASSED=1"
STUB
proof=$("$BIN/agent-kit-gate-proof" run); rc=$?
check "proof fails when a good change is not merged" '[ $rc = 1 ] && [ "$(jq -r .good.status <<< "$proof")" = failed ] && [ "$(jq -r .drop <<< "$proof")" = null ]'

sed -i '/GATE_PROOF_DELETE/d' "$T/etc/project.env"
git -C "$T/ws" rm -q BROKEN; G commit -q -m fixed; git -C "$T/bare" fetch -q "$T/ws" "+main:main"; G fetch -q gate
echo 1 > "$S/gate/baseline-tests"
proof=$("$BIN/agent-kit-gate-proof" run); rc=$?
check "without GATE_PROOF_DELETE only the first part runs" '[ $rc = 0 ] && [ "$(jq -r .drop <<< "$proof")" = null ] && grep -q "skipped" <<< "$(jq -r .note <<< "$proof")"'
echo "GATE_PROOF_DELETE=../../etc/passwd" >> "$T/etc/project.env"
proof=$("$BIN/agent-kit-gate-proof" run); rc=$?
check "a path outside the repository is not accepted" '[ $rc = 1 ] && grep -q "plain path" <<< "$(jq -r .note <<< "$proof")"'
sed -i '/GATE_PROOF_DELETE/d' "$T/etc/project.env"

echo "run owner resumed" > "$S/control"
proof=$("$BIN/agent-kit-gate-proof" run); rc=$?
check "refused while the team is not halted" '[ $rc = 1 ] && grep -q "not halted" <<< "$(jq -r .error <<< "$proof")"'
refuse "unknown command" "$BIN/agent-kit-gate-proof" merge-everything

check "lead-settings.json is a JSON object" 'jq -e "type == \"object\"" "$HERE/../lead-settings.json" > /dev/null'

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
