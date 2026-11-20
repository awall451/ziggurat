#!/bin/bash
# Tests for the kit's owner-inbox, hook, caps, schedule, sign-in, one-shot and unit-scan scripts.
# Runs anywhere, as any user, in a temp folder:   bash kit/vm/tests/run.sh
# (agent-kit-resume drives systemd and is only syntax-checked here; it is
# exercised on a real VM. agent-kit-halt, agent-kit-halt-after and
# agent-kit-oneshot run against a stub systemctl.)
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
check "prompt tells the lead about the wrap-up notice" 'grep -q "halt the team when this cycle ends" <<< "$out"'
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

echo "== agent-kit-issues, owner-issues"
I1=20260101T120000Z-i-aaaaaa I2=20260101T120001Z-i-bbbbbb
mkdir -p "$T/work/i1" "$T/work/i2" "$T/work/ibad"
printf '# Names box overlaps the victory box\n\nKind: bug\nScreen: level-up\n\nSee circle. Code word OBSIDIAN.\n' > "$T/work/i1/issue.md"
echo png > "$T/work/i1/markup.png"; echo png > "$T/work/i1/shot.png"
printf '# Brighter candles\n' > "$T/work/i2/issue.md"
tarball i1 | "$BIN/agent-kit-issues" put $I1 bug > /dev/null
tarball i2 | "$BIN/agent-kit-issues" put $I2 polish > /dev/null
check "issue stored with images" '[ -f "$S/issues/$I1/issue.md" ] && [ -f "$S/issues/$I1/markup.png" ]'
check "issue header written by the script" 'grep -q "^Kind: bug$" "$S/issues/$I1/issue.md" && grep -q "^Id: $I1$" "$S/issues/$I1/issue.md"'
refuse "duplicate issue" bash -c "tar -c -C '$T/work/i2' . | '$BIN/agent-kit-issues' put $I2 polish"
refuse "bad issue id" bash -c "tar -c -C '$T/work/i2' . | '$BIN/agent-kit-issues' put ../x bug"
refuse "bad kind" bash -c "tar -c -C '$T/work/i2' . | '$BIN/agent-kit-issues' put 20260101T120002Z-i-cccccc feature"
echo x > "$T/work/ibad/issue.md"; echo x > "$T/work/ibad/evil.sh"
refuse "unexpected file in issue archive" bash -c "tar -c -C '$T/work/ibad' . | '$BIN/agent-kit-issues' put 20260101T120003Z-i-dddddd bug"
check "refused issues left nothing" '[ "$("$BIN/agent-kit-issues" list | wc -l)" = 2 ]'
listed=$("$BIN/owner-issues" list)
check "list shows two new issues" '[ "$(wc -l <<< "$listed")" = 2 ] && grep -q "$I1  bug .*new .*Names box" <<< "$listed"'
out=$("$BIN/owner-issues" prompt)
check "prompt has protocol, issue text and image path" 'grep -q "## Owner issues" <<< "$out" && grep -q OBSIDIAN <<< "$out" && grep -q "issues/$I1/markup.png" <<< "$out"'
echo "Given to the artist." | "$BIN/owner-issues" update $I1 in_progress > /dev/null
check "in_progress keeps it open" 'grep -q "$I1 .*in_progress" <<< "$("$BIN/owner-issues" list)"'
sleep 1
echo "Fixed." | "$BIN/owner-issues" update $I1 done --shot shots/2026-01-02/07-level-up.png > /dev/null
check "done closes it" '! grep -q "$I1" <<< "$("$BIN/owner-issues" list)"'
check "update file is machine readable" '[ "$(head -1 "$S/issues-out/$I1.md")" = "Status: done" ] && grep -q "^Fixed-shot: shots/2026-01-02/07-level-up.png$" "$S/issues-out/$I1.md"'
refuse "update with a bad shot path" bash -c "echo x | '$BIN/owner-issues' update $I2 done --shot ../../etc/passwd"
refuse "update with an unknown status" bash -c "echo x | '$BIN/owner-issues' update $I2 maybe"
sleep 1
"$BIN/agent-kit-issues" set $I1 new > /dev/null
check "owner reopening after the lead wins" 'grep -q "$I1 .*new" <<< "$("$BIN/owner-issues" list)"'
"$BIN/agent-kit-issues" set $I2 wontfix > /dev/null
check "owner can close an issue" '! grep -q "$I2" <<< "$("$BIN/owner-issues" list)"'
refuse "owner set with a bad status" "$BIN/agent-kit-issues" set $I2 closed
I3=20260101T120004Z-i-eeeeee
mkdir -p "$T/work/i3"
{ echo "# A very long issue"; head -c 5000 /dev/zero | tr '\0' a; echo; echo "Last line: ISSUETAIL."; } > "$T/work/i3/issue.md"
echo png > "$T/work/i3/markup.png"
tarball i3 | "$BIN/agent-kit-issues" put $I3 bug > /dev/null
out=$("$BIN/owner-issues" prompt)
check "a cut issue says that it was cut and how to read the rest" '! grep -q ISSUETAIL <<< "$out" && grep -q "cut here.*owner-issues show $I3" <<< "$out"'
check "a short issue is not marked as cut" '[ "$(grep -c "cut here" <<< "$out")" = 1 ]'
whole=$("$BIN/owner-issues" show $I3)
check "the whole issue and its image path are one command away" 'grep -q ISSUETAIL <<< "$whole" && grep -q "issues/$I3/markup.png" <<< "$whole"'
"$BIN/agent-kit-issues" set $I3 wontfix > /dev/null
# Raised on the Issues page (kit 0.7): a picture and plain files in att/.
I4=20260101T120005Z-i-ffffff
mkdir -p "$T/work/i4/att"
printf '# Crash when saving\n\nKind: bug\n\nSee the log. Code word GARNET.\n' > "$T/work/i4/issue.md"
echo png > "$T/work/i4/shot.png"; echo "trace" > "$T/work/i4/att/crash.log"; echo png > "$T/work/i4/att/menu-markup.png"
tarball i4 | "$BIN/agent-kit-issues" put $I4 bug > /dev/null
check "an issue with attachments is stored, att/ readable" '[ -f "$S/issues/$I4/att/crash.log" ] && [ "$(stat -c %a "$S/issues/$I4/att")" = 755 ] && [ "$(stat -c %a "$S/issues/$I4/att/crash.log")" = 644 ]'
whole=$("$BIN/owner-issues" show $I4)
check "the lead sees the attachment paths" 'grep -q "issues/$I4/att/crash.log" <<< "$whole" && grep -q "issues/$I4/att/menu-markup.png" <<< "$whole"'
out=$("$BIN/owner-issues" prompt)
check "the prompt points at the attachments" 'grep -q "issues/$I4/att/crash.log" <<< "$out"'
mkdir -p "$T/work/i5/att/sub"; echo x > "$T/work/i5/issue.md"; echo x > "$T/work/i5/att/sub/f"
refuse "a folder inside att/" bash -c "tar -c -C '$T/work/i5' . | '$BIN/agent-kit-issues' put 20260101T120006Z-i-a00001 bug"
mkdir -p "$T/work/i6/att"; echo x > "$T/work/i6/issue.md"; ln -s /etc/passwd "$T/work/i6/att/passwd"
refuse "a symlink in att/" bash -c "tar -c -C '$T/work/i6' . | '$BIN/agent-kit-issues' put 20260101T120007Z-i-a00002 bug"
mkdir -p "$T/work/i7/att"; echo x > "$T/work/i7/issue.md"; echo x > "$T/work/i7/att/.hidden"
refuse "a hidden attachment name" bash -c "tar -c -C '$T/work/i7' . | '$BIN/agent-kit-issues' put 20260101T120008Z-i-a00003 bug"
mkdir -p "$T/work/i8/att"; echo x > "$T/work/i8/issue.md"; for n in 1 2 3 4 5 6 7 8 9; do echo x > "$T/work/i8/att/f$n.txt"; done
refuse "more than 8 attachments" bash -c "tar -c -C '$T/work/i8' . | '$BIN/agent-kit-issues' put 20260101T120009Z-i-a00004 bug"
check "refused attachments left no issue" '[ ! -e "$S/issues/20260101T120006Z-i-a00001" ] && [ ! -e "$S/issues/20260101T120007Z-i-a00002" ] && [ ! -e "$S/issues/20260101T120009Z-i-a00004" ]'
"$BIN/agent-kit-issues" set $I4 wontfix > /dev/null

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

echo "== agent-kit-oneshot"
# systemctl is replaced by a stub that records its calls. The script sets its
# own PATH (it runs as root), so the stub goes in through AGENT_KIT_PATH.
FB=$T/fakebin
mkdir -p "$FB"
cat > "$FB/systemctl" <<'EOF'
#!/bin/bash
echo "$*" >> "$FAKE_LOG"
case "$1" in
  is-active) echo "${FAKE_ACTIVE:-inactive}" ;;
  start) [ "$2" = --no-block ] && [ "${3:-}" = agent-kit-lead.timer ] || [ -z "${FAKE_START_FAIL:-}" ] ;;
  is-enabled) echo "${FAKE_TIMER:-enabled}" ;;
  show) if [ "${4:-}" = Job ]; then echo "${FAKE_JOB:-}"; else echo "${FAKE_ENDED:-}"; fi ;;
esac
EOF
# Nothing a halt would signal or switch off may reach the real machine.
for tool in pkill pgrep runuser; do printf '#!/bin/bash\nexit 1\n' > "$FB/$tool"; done
chmod 755 "$FB"/*
export AGENT_KIT_LOCK=$T/ctl.lock FAKE_LOG=$T/systemctl.log
shot() { AGENT_KIT_PATH=$FB:$PATH "$BIN/agent-kit-oneshot" "$@"; }
job() { tar -c -C "$T/work/j" . | shot start "$1" owner; }
J=20260101T120000Z-o-job1 J2=20260101T120100Z-o-job2
mkdir -p "$T/work/j"; echo "Fix the menu bug and soften the title music. Code word BASALT." > "$T/work/j/body.md"
echo "run 2026-01-01T00:00:00+00:00" > "$S/control"
FAKE_ACTIVE=active refuse "one-shot while a normal cycle runs" job $J
check "a refused job stores nothing" '[ ! -e "$S/inbox/$J" ] && [ ! -e "$S/oneshot" ]'
check "a refusal on a running team turns its timer back on" 'grep -qx "stop agent-kit-lead.timer" "$FAKE_LOG" && grep -qx "start --no-block agent-kit-lead.timer" "$FAKE_LOG"'
echo "stop owner halt for the night 2026-01-01T00:00:00+00:00" > "$S/control"
FAKE_ACTIVE=active refuse "one-shot while a cycle is still running" job $J
FAKE_JOB=4711 refuse "one-shot while a start of the lead is queued" job $J
refuse "one-shot with a bad id" job ../../etc/x
echo "1000000000 old window" > "$S/halt-at"
: > "$FAKE_LOG"
job $J > /dev/null
check "job stored as an owner message" 'grep -q "^Tier: oneshot$" "$S/inbox/$J/message.md" && grep -q BASALT "$S/inbox/$J/message.md"'
check "marker names the job, and that the team halts after it" '[ "$(cut -d" " -f1 "$S/oneshot")" = "$J" ] && [ "$(cut -d" " -f3 "$S/oneshot")" = halt ]'
check "control lets this one cycle and the gate run" 'grep -q "^run oneshot $J " "$S/control"'
check "one cycle started, timer left alone" 'grep -qx "start --no-block agent-kit-lead.service" "$FAKE_LOG" && ! grep -q "enable" "$FAKE_LOG"'
check "the job is not injected mid-cycle" '[ ! -e "$S/inbox/.inject/$J" ]'
check "a stop time already past is dropped" '[ ! -e "$S/halt-at" ]'
refuse "second job while one is in progress" job $J2
rules=$("$BIN/owner-inbox" oneshot $J)
check "lead gets the one-shot rules with the job id" 'grep -q "## One-shot job" <<< "$rules" && grep -q "owner-inbox reply $J done" <<< "$rules" && grep -q "gate-wait" <<< "$rules"'
check "the rules carry the job itself" 'grep -q BASALT <<< "$rules"'
check "the rules keep open issues for a normal cycle, unless the job names them" 'grep -q "So do open owner issues" <<< "$rules" && grep -q "an issue the job itself names" <<< "$rules" && grep -q "owner-issues update" <<< "$rules"'
headline=$("$BIN/owner-inbox" oneshot $J --head)
check "the notice for the top of the prompt names the job and protects leftover work" 'grep -q "Read this first" <<< "$headline" && grep -q "$J" <<< "$headline" && grep -q "do not resume, finish, rebase or remove" <<< "$headline"'
refuse "one-shot rules with an unknown option" "$BIN/owner-inbox" oneshot $J --tail
listing=$("$BIN/owner-inbox" prompt)
check "the job text is in the lead's prompt" 'grep -q BASALT <<< "$listing"'
refuse "one-shot rules for a message that does not exist" "$BIN/owner-inbox" oneshot 20250101T000000Z-o-nope
NJ=20260101T120200Z-o-midjob
tarball n | "$BIN/agent-kit-inbox" put $NJ note owner > /dev/null
check "a note during a one-shot job is delivered mid-cycle" '[ "$(cat "$S/inbox/.inject/$NJ")" = note ] && hook LEAD null | grep -q "NOTE: weigh it"'
shot finish > /dev/null
check "the end of the job halts the team again" 'grep -q "^stop one-shot job $J ended " "$S/control" && [ ! -e "$S/oneshot" ]'
before=$(cat "$S/control")
shot finish > /dev/null
check "a normal cycle's end changes nothing" '[ "$(cat "$S/control")" = "$before" ]'
FAKE_START_FAIL=1 refuse "cycle that cannot start" job $J2
check "a failed start leaves the team halted" '[ "$(cat "$S/control")" = "$before" ] && [ ! -e "$S/oneshot" ]'
check "a failed start leaves no job in the inbox" '[ ! -e "$S/inbox/$J2" ]'
FAKE_START_FAIL=1 refuse "cycle that cannot start, for a job already stored" job $J
check "a job that was stored before is kept when its restart fails" '[ -f "$S/inbox/$J/message.md" ]'
job $J2 > /dev/null
check "a job that did not start can be retried" 'grep -q "^run oneshot $J2 " "$S/control"'
echo "run 2026-01-01T01:00:00+00:00" > "$S/control"   # what agent-kit-resume writes
shot finish > /dev/null
check "after a resume the job's end does not halt" 'grep -q "^run 2026" "$S/control" && [ ! -e "$S/oneshot" ]'
job $J > /dev/null 2>&1
echo "stop owner halt mid job 2026-01-01T02:00:00+00:00" > "$S/control"   # what agent-kit-halt writes
shot finish > /dev/null
check "after a halt the job's end keeps the owner's reason" 'grep -q "^stop owner halt mid job" "$S/control"'
# A job whose cycle is gone without `finish` (the VM lost power).
job $J > /dev/null 2>&1
FAKE_ACTIVE=active shot reap > /dev/null
check "reap leaves a job with a running cycle alone" '[ -e "$S/oneshot" ]'
shot reap > /dev/null
check "reap gives a job that was only just started time" '[ -e "$S/oneshot" ] && grep -q "^run oneshot $J " "$S/control"'
touch -d "10 minutes ago" "$S/oneshot"
FAKE_ACTIVE=active shot reap > /dev/null
check "reap leaves an old job alone while its cycle runs" '[ -e "$S/oneshot" ]'
shot reap > /dev/null
check "reap halts again when the cycle is gone" '[ ! -e "$S/oneshot" ] && grep -q "^stop one-shot job $J lost its cycle " "$S/control"'
before=$(cat "$S/control")
shot reap > /dev/null
check "reap without a job changes nothing" '[ "$(cat "$S/control")" = "$before" ]'
"$BIN/agent-kit-inbox" close $J2 > /dev/null 2>&1 || { mkdir -p "$T/work/c"; cp "$T/work/j/body.md" "$T/work/c/"; tar -c -C "$T/work/c" . | "$BIN/agent-kit-inbox" put $J2 oneshot owner > /dev/null; "$BIN/agent-kit-inbox" close $J2 > /dev/null; }
refuse "starting a job the owner has closed" job $J2
check "a refused start changes nothing" '[ "$(cat "$S/control")" = "$before" ] && [ ! -e "$S/oneshot" ]'

# The end of every cycle runs `finish` as root, with an environment whose PATH
# starts with a folder the agent can write to. Nothing planted there may run.
mkdir -p "$T/evil"
for tool in dirname readlink date grep rm mv chmod head stat flock systemctl; do
  printf '#!/bin/bash\necho "$0" >> "%s/planted"\nexit 1\n' "$T" > "$T/evil/$tool"
done
chmod 755 "$T/evil"/*
PATH=$T/evil:$PATH "$BIN/agent-kit-oneshot" finish > /dev/null 2>&1
check "finish ignores programs planted in an inherited PATH" '[ ! -e "$T/planted" ]'
check "the unit runs finish with an empty environment" 'grep -q "^ExecStopPost=+/usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin /opt/agent-kit/bin/agent-kit-oneshot finish$" "$HERE/../systemd/agent-kit-lead.service"'
check "the gate keeps its own PATH after reading agent.env" 'sed -n "/source .*agent\.env/,\$p" "$HERE/../gate/bin/gate-run" | grep -qx "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"'
check "a failing reap cannot block the scheduled stop" 'grep -qx "ExecStart=-/opt/agent-kit/bin/agent-kit-oneshot reap" "$HERE/../systemd/agent-kit-tick.service" && grep -qx "ExecStart=/opt/agent-kit/bin/agent-kit-halt --if-due" "$HERE/../systemd/agent-kit-tick.service"'

# A long job: the list of open messages cuts it, and says so; the rules carry all of it.
LJ=20260101T130000Z-o-longjob
mkdir -p "$T/work/long/att"
{ head -c 7000 /dev/zero | tr '\0' a; echo; echo "Last task: TAILWORD."; } > "$T/work/long/body.md"
echo png > "$T/work/long/att/title.png"
tar -c -C "$T/work/long" . | "$BIN/agent-kit-inbox" put $LJ oneshot owner > /dev/null
listing=$("$BIN/owner-inbox" prompt)
check "a cut message says that it was cut and how to read the rest" '! grep -q TAILWORD <<< "$listing" && grep -q "cut here.*owner-inbox show $LJ" <<< "$listing"'
check "a short message is not marked as cut" '[ "$(grep -c "cut here" <<< "$listing")" = 1 ]'
rules=$("$BIN/owner-inbox" oneshot $LJ)
check "a long job reaches the lead whole, with its attachments" 'grep -q TAILWORD <<< "$rules" && grep -q "att/title.png" <<< "$rules"'
"$BIN/agent-kit-inbox" close $LJ > /dev/null

# On an idle team: set to run, no cycle running (between cycles, or the daily cap used up).
echo "== agent-kit-oneshot on an idle team"
IJ=20260101T140000Z-o-idle1 IJ2=20260101T140100Z-o-idle2
rm -f "$S/oneshot" "$S/halt-at"
echo "run 2026-01-01T03:00:00+00:00" > "$S/control"
: > "$FAKE_LOG"
said=$(job $IJ)
check "a job starts on an idle team" 'grep -q "^run oneshot $IJ " "$S/control" && grep -qx "start --no-block agent-kit-lead.service" "$FAKE_LOG"'
check "it says the team runs on afterwards" 'grep -q "runs on when it ends" <<< "$said"'
check "the marker says the team runs on after it" '[ "$(cut -d" " -f3 "$S/oneshot")" = run ]'
check "the timer is stopped for the job, before the cycle is started" '[ "$(grep -n "stop agent-kit-lead.timer" "$FAKE_LOG" | cut -d: -f1)" -lt "$(grep -n "start --no-block agent-kit-lead.service" "$FAKE_LOG" | cut -d: -f1)" ] && ! grep -q "start --no-block agent-kit-lead.timer" "$FAKE_LOG"'
head=$("$BIN/owner-inbox" oneshot $IJ --head)
rules=$("$BIN/owner-inbox" oneshot $IJ)
check "the lead is told the team runs on, not that it is halted" 'grep -q "team between its normal cycles" <<< "$head" && grep -q "goes back to its normal schedule" <<< "$rules" && ! grep -q "team is halted\|paused while the team" <<< "$rules"'
check "a job on a halted team is still told so" 'echo "$J x halt" > "$S/oneshot.j" && grep -q "The team is halted" <<< "$("$BIN/owner-inbox" oneshot $J)"'
rm -f "$S/oneshot.j"
said=$(AGENT_KIT_PATH=$FB:$PATH "$BIN/agent-kit-halt-after" set 'after the job')
check "a halt after the job may be asked for while it runs" 'grep -q "after the job" "$S/halt-after"'
rm -f "$S/halt-after"
: > "$FAKE_LOG"
shot finish > /dev/null
check "the end of the job puts the team back to running" 'grep -q "^run after one-shot job $IJ ended " "$S/control" && [ ! -e "$S/oneshot" ]'
check "and turns the lead timer back on" 'grep -qx "start --no-block agent-kit-lead.timer" "$FAKE_LOG"'
check "the control line after the job is not a stop" '! grep -q "^stop" "$S/control"'
: > "$FAKE_LOG"
FAKE_TIMER=disabled job $IJ2 > /dev/null
FAKE_TIMER=disabled shot finish > /dev/null
check "a timer the owner had off stays off" '! grep -q "start --no-block agent-kit-lead.timer" "$FAKE_LOG"'
echo "run 2026-01-01T04:00:00+00:00" > "$S/control"
echo "1767240000 wrap owner" > "$S/halt-after"
refuse "a job on a team that is about to halt" job 20260101T140200Z-o-idle3
rm -f "$S/halt-after"
: > "$FAKE_LOG"
FAKE_START_FAIL=1 refuse "an idle team's job whose cycle cannot start" job 20260101T140300Z-o-idle4
check "a failed start on an idle team leaves it running, timer back on" 'grep -q "^run 2026-01-01T04" "$S/control" && [ ! -e "$S/oneshot" ] && grep -qx "start --no-block agent-kit-lead.timer" "$FAKE_LOG"'
job 20260101T140400Z-o-idle5 > /dev/null
touch -d "10 minutes ago" "$S/oneshot"
shot reap > /dev/null
check "reap puts an idle team's lost job back to running" 'grep -q "^run after one-shot job 20260101T140400Z-o-idle5 lost its cycle " "$S/control"'
echo "20260101T000000Z-o-old 2026-01-01T00:00:00+00:00" > "$S/oneshot"
echo "run oneshot 20260101T000000Z-o-old 2026-01-01T00:00:00+00:00" > "$S/control"
shot finish > /dev/null
check "a marker from an older kit (no third field) halts, as before" 'grep -q "^stop one-shot job 20260101T000000Z-o-old ended " "$S/control"'

check "halt and resume drop the marker" 'grep -q "rm -f \"\$STATE/oneshot\"" "$BIN/agent-kit-halt" && grep -q "rm -f \"\$STATE/oneshot\"" "$BIN/agent-kit-resume"'

echo "== agent-kit-halt-after"
ha() { AGENT_KIT_PATH=$FB:$PATH "$BIN/agent-kit-halt-after" "$@"; }
halt() { AGENT_KIT_PATH=$FB:$PATH "$BIN/agent-kit-halt" "$@"; }
rm -f "$S/oneshot" "$S/halt-at"
mkdir -p "$S/gate"
echo "stop owner halt 2026-01-01T00:00:00+00:00" > "$S/control"
refuse "halt-after on a team that is already halted" ha set
echo "run 2026-01-01T00:00:00+00:00" > "$S/control"
echo "$J 2026-01-01T00:00:00+00:00" > "$S/oneshot"
refuse "halt-after during a one-shot job" ha set
echo "$J 2026-01-01T00:00:00+00:00 halt" > "$S/oneshot"
refuse "halt-after during a one-shot job that halts anyway" ha set
rm -f "$S/oneshot"
said=$(FAKE_ACTIVE=activating ha set --wrap-up 'weekly; usage $(id)')
check "the note holds when, how and why, with nothing but plain words" 'grep -qE "^[0-9]{10} wrap weekly  usage  \(id\)$" "$S/halt-after" && ! grep -q "[;\$]" "$S/halt-after" && grep -q "wrap up" <<< "$said"'
check "show reports it" 'ha show | grep -q "halt pending since .*(wrap): weekly"'
FAKE_ACTIVE=activating refuse "not due while the cycle is running" ha due
check "a running cycle does not start the wait for the gate" '[ ! -e "$S/halt-after.over" ]'

# The cycle is over (the stub says inactive). Now the gate decides.
rm -f "$S/gate/pass-started" "$S/gate/paused"
refuse "not due before the gate has run" ha due
over=$(cat "$S/halt-after.over")
check "the end of the cycle is noted once" '[[ $over =~ ^[0-9]{10}$ ]] && [ "$over" -le "$(date +%s)" ]'
echo $((over - 30)) > "$S/gate/pass-started"
refuse "a gate pass from before the cycle ended does not count" ha due
echo $((over + 5)) > "$S/gate/pass-started"
why=$(ha due); rc=$?
check "due once a gate pass has started since the cycle ended" '[ "$rc" = 0 ] && grep -q "^after cycle: weekly" <<< "$why"'
rm -f "$S/gate/pass-started"; touch "$S/gate/paused"
why=$(ha due); rc=$?
check "a paused gate is not waited for" '[ "$rc" = 0 ] && grep -q "(gate paused)" <<< "$why"'
rm -f "$S/gate/paused"
echo $(($(date +%s) - 3000)) > "$S/halt-after.over"
why=$(ha due); rc=$?
check "a gate that never runs is not waited for longer than the limit" '[ "$rc" = 0 ] && grep -q "did not run in time" <<< "$why"'
echo $(($(date +%s) - 20)) > "$S/halt-after.over"
refuse "inside the limit the gate is still waited for" ha due
why=$(HALT_AFTER_GATE_WAIT=10 ha due); rc=$?
check "the limit can be set" '[ "$rc" = 0 ]'
HALT_AFTER_GATE_WAIT="10; id" refuse "a limit that is not a number falls back to the default" ha due

# systemd knows when the cycle ended: a pass since then is enough, however long ago.
rm -f "$S/halt-after.over"
date +%s > "$S/gate/pass-started"
why=$(FAKE_ENDED="Thu 2026-01-01 00:00:00 UTC" ha due); rc=$?
check "the cycle's real end time is used when systemd gives it" '[ "$rc" = 0 ] && [ "$(cat "$S/halt-after.over")" = "$(date -d "2026-01-01 00:00:00 UTC" +%s)" ]'
rm -f "$S/halt-after.over" "$S/gate/pass-started"
FAKE_ENDED="Thu 2099-01-01 00:00:00 UTC" refuse "an end time in the future is not believed" ha due
check "then the time of the first look is used" '[ "$(cat "$S/halt-after.over")" -le "$(date +%s)" ]'

# The tick: agent-kit-halt --if-due performs the halt when it is due.
: > "$FAKE_LOG"
before=$(cat "$S/control")
rm -f "$S/halt-after.over" "$S/gate/pass-started" "$S/halt-state"
halt --if-due > /dev/null
check "the tick does nothing while the gate has not run" '[ "$(cat "$S/control")" = "$before" ] && [ -e "$S/halt-after" ] && ! grep -q "disable" "$FAKE_LOG"'
FAKE_ACTIVE=activating halt --if-due > /dev/null
check "the tick does nothing while the cycle runs" '[ "$(cat "$S/control")" = "$before" ]'
date +%s > "$S/gate/pass-started"; sleep 1
echo $(($(date +%s) + 5)) > "$S/gate/pass-started"
halt --if-due > /dev/null
check "the tick halts the team once the gate has run" 'grep -q "^stop after cycle: weekly" "$S/control" && grep -q "disable --now agent-kit-lead.timer" "$FAKE_LOG"'
check "the pending halt is settled" '[ ! -e "$S/halt-after" ] && [ ! -e "$S/halt-after.over" ] && [ -f "$S/halt-state" ]'
before=$(cat "$S/control")
halt --if-due > /dev/null
check "the tick does nothing more afterwards" '[ "$(cat "$S/control")" = "$before" ]'

# A scheduled stop still comes first, and any halt settles a pending one.
echo "run 2026-01-01T00:00:00+00:00" > "$S/control"
FAKE_ACTIVE=activating ha set overnight > /dev/null
check "without --wrap-up the note says plain" 'grep -qE "^[0-9]{10} plain overnight$" "$S/halt-after"'
echo "1000000000 window closed" > "$S/halt-at"
FAKE_ACTIVE=activating halt --if-due > /dev/null
check "a scheduled stop whose time has come halts mid-cycle as before" 'grep -q "^stop scheduled stop: window closed" "$S/control" && [ ! -e "$S/halt-at" ] && [ ! -e "$S/halt-after" ]'
echo "run 2026-01-01T00:00:00+00:00" > "$S/control"
FAKE_ACTIVE=activating ha set > /dev/null
halt because I said so > /dev/null
check "halt now settles a pending halt" 'grep -q "^stop because I said so" "$S/control" && [ ! -e "$S/halt-after" ]'
check "resume drops a pending halt" 'grep -q "rm -f \"\$STATE/halt-after\" \"\$STATE/halt-after.over\"" "$BIN/agent-kit-resume"'

# Halted some other way while it was pending: nothing left to do.
echo "run 2026-01-01T00:00:00+00:00" > "$S/control"
FAKE_ACTIVE=activating ha set > /dev/null
echo "stop by hand 2026-01-01T00:00:00+00:00" > "$S/control"
refuse "not due on a team that is halted already" ha due
check "and the note is dropped" '[ ! -e "$S/halt-after" ]'

# No cycle running: the tick is asked to look at once.
echo "run 2026-01-01T00:00:00+00:00" > "$S/control"
: > "$FAKE_LOG"
said=$(ha set)
check "with no cycle running the tick is started right away" 'grep -qx "start --no-block agent-kit-tick.service" "$FAKE_LOG" && grep -q "no cycle is running" <<< "$said"'
ha clear > /dev/null
check "clear removes the note" '[ ! -e "$S/halt-after" ] && [ ! -e "$S/halt-after.over" ] && ha show | grep -q "no halt pending"'
refuse "unknown command" ha now

# The wrap-up notice, through the hook.
FAKE_ACTIVE=activating ha set > /dev/null
check "a plain pending halt tells nobody" '[ -z "$(hook LEAD null)" ] && [ -z "$(hook LEAD "\"wagent1\"")" ]'
ha clear > /dev/null
FAKE_ACTIVE=activating ha set --wrap-up > /dev/null
check "another session is told nothing" '[ -z "$(hook OTHER null)" ]'
note=$(hook LEAD null | jq -r .hookSpecificOutput.additionalContext)
check "the lead is told to wrap up" 'grep -q "^\[agent-kit owner notice\] The owner has asked for the team to halt when this cycle ends" <<< "$note" && grep -q "start no new work and no new agents" <<< "$note"'
check "the lead is told once" '[ -z "$(hook LEAD null)" ]'
note=$(hook LEAD '"wagent1"' | jq -r .hookSpecificOutput.additionalContext)
check "an agent is told to finish its step and report" 'grep -q "Finish the step you are on and do not start further steps" <<< "$note" && ! grep -q "no new agents" <<< "$note"'
check "each agent is told once" '[ -z "$(hook LEAD "\"wagent1\"")" ] && [ -n "$(hook LEAD "\"wagent2\"")" ]'
ha clear > /dev/null
FAKE_ACTIVE=activating ha set --wrap-up > /dev/null
check "a cleared halt tells nobody any more" 'ha clear > /dev/null; [ -z "$(hook LEAD "\"wagent3\"")" ]'
echo "run 2026-01-01T00:00:00+00:00" > "$S/control"

echo "== upgrade while a cycle runs"
# install.sh puts every file in place with `install` or `ln -sf`. A script that
# is running must keep the version it started with.
printf '#!/bin/bash\necho old-start\nsleep 1\necho old-end\n' > "$T/work/v1"
{ printf '#!/bin/bash\necho NEW\nexit 0\n'; head -c 400 /dev/zero | tr '\0' '#'; } > "$T/work/v2"
install -m 755 "$T/work/v1" "$T/work/live"
"$T/work/live" > "$T/work/live.out" 2>&1 &
sleep 0.3
install -m 755 "$T/work/v2" "$T/work/live"
wait
check "a running script is not disturbed by installing over it" '[ "$(tr "\n" " " < "$T/work/live.out")" = "old-start old-end " ]'
check "the next run is the new version" '[ "$("$T/work/live")" = NEW ]'
check "the installer writes kit files only with install or ln" '! grep -nE "^[^#]*(\bcp\b|\btee\b|>>?) *\"?(/opt/agent-kit|/etc/systemd|/usr/local/bin)" "$HERE/../install.sh"'
# Started from a folder its service users cannot read, the installer must still work.
check "the installer leaves its start folder before it runs anything as another user" '[ "$(grep -n "^cd /$" "$HERE/../install.sh" | head -1 | cut -d: -f1)" -lt "$(grep -n "sudo -u" "$HERE/../install.sh" | grep -v "^[0-9]*:#" | grep -v "rev-parse --verify" | head -1 | cut -d: -f1)" ]'
check "nothing after that depends on the start folder" '! sed -n "/^cd \/$/,\$p" "$HERE/../install.sh" | grep -nE "(^|[ \"=(])\./|\$\(pwd\)|\$PWD"'
check "the installer says so when it finds a cycle running" 'grep -q "A cycle is running: it was not interrupted" "$HERE/../install.sh"'

echo "== gate-wait"
git init -q "$T/ws"
git -C "$T/ws" -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m one
git -C "$T/ws" branch ready/menu
git -C "$T/ws" branch ready/music
sha=$(git -C "$T/ws" rev-parse ready/menu)
mkdir -p "$S/gate/results"
verdict() { jq -n --arg t "$1" --arg s "$2" --arg st "$3" '{topic:$t, sha:$s, status:$st, detail:"detail", log:"/log"}' > "$S/gate/results/$1.json"; }
verdict menu "$sha" merged
echo "run 2026-01-01T03:00:00+00:00" > "$S/control"
out=$("$BIN/gate-wait" menu)
check "verdict for the submitted commit is printed" 'grep -q "MERGED.*menu" <<< "$out"'
"$BIN/gate-wait" --max 0 menu music > /dev/null; rc=$?
check "a missing verdict means: still waiting" '[ "$rc" = 3 ]'
verdict music 0000000000000000000000000000000000000000 failed
"$BIN/gate-wait" --max 0 music > /dev/null; rc=$?
check "a verdict for an older commit does not count" '[ "$rc" = 3 ]'
echo "stop owner 2026-01-01T04:00:00+00:00" > "$S/control"
out=$("$BIN/gate-wait" music); rc=$?
check "no waiting on a paused gate" '[ "$rc" = 3 ] && grep -q "gate is paused" <<< "$out"'
check "one call fits in a default two-minute tool call" '[ "$(sed -n "s/^max=\([0-9]*\)$/\1/p" "$BIN/gate-wait")" -le 100 ]'
refuse "topic that was never submitted" "$BIN/gate-wait" nothing-here
refuse "topic with shell text" "$BIN/gate-wait" 'x; id'

echo "== lead-cycle"
# A stub `claude` keeps the prompt it was given and answers like a finished cycle.
K=$T/kit
mkdir -p "$K"
ln -s "$BIN" "$K/bin"
echo "TEAM-CYCLE-TEXT: step 1, resume or remove leftover worktrees." > "$K/lead-cycle.md"
cat > "$FB/claude" <<'EOF'
#!/bin/bash
while [ $# -gt 0 ]; do [ "$1" = -p ] && { printf '%s' "$2" > "$FAKE_PROMPT"; break; }; shift; done
echo '{"total_cost_usd":0.5,"num_turns":9,"result":"cycle summary","is_error":false}'
EOF
chmod 755 "$FB/claude"
export FAKE_PROMPT=$T/prompt.txt
cycle() { rm -f "$FAKE_PROMPT"; AGENT_KIT_HOME=$K PATH=$FB:$PATH "$BIN/lead-cycle"; }
LC=20260101T140000Z-o-cyclejob
mkdir -p "$T/work/lc"; echo "Make the title louder. Code word GNEISS." > "$T/work/lc/body.md"
echo "stop owner halt 2026-01-01T05:00:00+00:00" > "$S/control"
tar -c -C "$T/work/lc" . | shot start $LC owner > /dev/null
# The daily cap is used up: six counted cycles today.
mkdir -p "$S/ledger"
for i in 1 2 3 4 5 6; do jq -nc --arg d "$(date +%F)" '{date:$d, counted:true}'; done > "$S/ledger/cycles.jsonl"
out=$(cycle 2>&1)
check "a one-shot cycle runs although the daily cap is used up" '[ -s "$FAKE_PROMPT" ] && grep -q "oneshot=$LC" <<< "$out"'
check "its prompt starts with the notice, before the team's own text" '[ "$(head -c 16 "$FAKE_PROMPT")" = "**Read this firs" ] && [ "$(grep -n "Read this first" "$FAKE_PROMPT" | head -1 | cut -d: -f1)" -lt "$(grep -n "TEAM-CYCLE-TEXT" "$FAKE_PROMPT" | cut -d: -f1)" ]'
check "the issues section comes before the job, which stays last" '[ "$(grep -n "^## Owner issues" "$FAKE_PROMPT" | cut -d: -f1)" -gt "$(grep -n "^## Owner inbox" "$FAKE_PROMPT" | cut -d: -f1)" ] && [ "$(grep -n "^## Owner issues" "$FAKE_PROMPT" | cut -d: -f1)" -lt "$(grep -n "^## One-shot job" "$FAKE_PROMPT" | cut -d: -f1)" ]'
check "its prompt ends with the job and the rules" '[ "$(grep -n "## One-shot job" "$FAKE_PROMPT" | cut -d: -f1)" -gt "$(grep -n "## Owner inbox" "$FAKE_PROMPT" | cut -d: -f1)" ] && grep -q GNEISS "$FAKE_PROMPT" && [ "$(tail -1 "$FAKE_PROMPT")" = "Then end the cycle. Do not look for more work." ]'
check "the ledger line names the job" '[ "$(tail -1 "$S/ledger/cycles.jsonl" | jq -r .oneshot)" = "$LC" ] && [ "$(tail -1 "$S/ledger/cycles.jsonl" | jq -r .turns)" = 9 ]'
check "no cycle is left marked as in progress" '[ ! -e "$S/ledger/current" ]'
# A marker that does not agree with the control file must not change a normal cycle.
echo "run 2026-01-01T06:00:00+00:00" > "$S/control"
out=$(cycle 2>&1)
check "a normal cycle still stops at the daily cap" 'grep -q "daily cycle cap reached" <<< "$out" && [ ! -e "$FAKE_PROMPT" ]'
head -3 "$S/ledger/cycles.jsonl" > "$S/ledger/cycles.tmp"; mv "$S/ledger/cycles.tmp" "$S/ledger/cycles.jsonl"
out=$(cycle 2>&1)
check "a stale marker does not make a normal cycle a one-shot" '[ -s "$FAKE_PROMPT" ] && ! grep -q "One-shot job\|Read this first" "$FAKE_PROMPT" && grep -q "oneshot=no" <<< "$out"'
check "a normal cycle's prompt starts with the team's own text" '[ "$(head -c 15 "$FAKE_PROMPT")" = "TEAM-CYCLE-TEXT" ]'
check "a normal cycle's ledger line names no job" '[ "$(tail -1 "$S/ledger/cycles.jsonl" | jq -r .oneshot)" = null ]'
check "no publishing section unless publishing is set up" '! grep -q "^## Publishing" "$FAKE_PROMPT"'
"$BIN/agent-kit-publish" enable git@example.org:team/demo.git > /dev/null
head -3 "$S/ledger/cycles.jsonl" > "$S/ledger/cycles.tmp"; mv "$S/ledger/cycles.tmp" "$S/ledger/cycles.jsonl"
out=$(cycle 2>&1)
check "the publishing section is added once it is set up, after the issues" '[ "$(grep -n "^## Publishing" "$FAKE_PROMPT" | cut -d: -f1)" -gt "$(grep -n "^## Owner issues" "$FAKE_PROMPT" | cut -d: -f1)" ] && grep -q "git@example.org:team/demo.git" "$FAKE_PROMPT" && grep -q "Nothing has been published yet" "$FAKE_PROMPT"'
"$BIN/agent-kit-publish" disable > /dev/null
rm -rf "$S/publish" "$S/publish-out"
echo "stop owner 2026-01-01T07:00:00+00:00" > "$S/control"
out=$(cycle 2>&1)
check "no cycle on a halted team" 'grep -q "control=stop" <<< "$out" && [ ! -e "$FAKE_PROMPT" ]'
# A halt that waits for the gate after the last cycle: no new cycle in between.
echo "run 2026-01-01T08:00:00+00:00" > "$S/control"
echo "$(date +%s) plain overnight" > "$S/halt-after"
out=$(cycle 2>&1)
check "no cycle starts while a halt after the cycle is pending" 'grep -q "a halt after the last cycle is pending" <<< "$out" && [ ! -e "$FAKE_PROMPT" ]'
rm -f "$S/halt-after"
echo "stop owner 2026-01-01T09:00:00+00:00" > "$S/control"
# A one-shot whose job cannot be read must not run as a normal cycle.
rm -f "$S/oneshot"
tar -c -C "$T/work/lc" . | shot start $LC owner > /dev/null
mv "$K/bin" "$K/bin.off"; mkdir "$K/bin"
out=$(cycle 2>&1)
check "a one-shot cycle without its job does not run" 'grep -q "could not build its prompt" <<< "$out" && [ ! -e "$FAKE_PROMPT" ] && [ ! -e "$S/ledger/current" ]'
rmdir "$K/bin"; mv "$K/bin.off" "$K/bin"
shot finish > /dev/null

# The sections below build their own workspace and gate results: leave none behind.
rm -rf "$T/ws" "$S/gate/results"

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

rm -f "$S/gate/pass-started"
"$T/opt/gate/bin/gate-run"
G branch -f ready/work-x main > /dev/null
"$T/opt/gate/bin/gate-run"
check "a halted gate judges nothing" '[ ! -e "$S/gate/results/work-x.json" ]'
check "a halted gate does not count as a pass" '[ ! -e "$S/gate/pass-started" ]'
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

check "a proof run does not count as a pass over all branches" '[ ! -e "$S/gate/pass-started" ]'
echo "run owner resumed" > "$S/control"
t0=$(date +%s)
"$T/opt/gate/bin/gate-run"
check "a real pass says when it started" '[ "$(cat "$S/gate/pass-started")" -ge "$t0" ] && [ -e "$S/gate/results/work-x.json" ]'
touch "$S/gate/paused"; echo 1 > "$S/gate/pass-started"
"$T/opt/gate/bin/gate-run"
check "a paused gate does not count as a pass" '[ "$(cat "$S/gate/pass-started")" = 1 ]'
rm -f "$S/gate/paused"
proof=$("$BIN/agent-kit-gate-proof" run); rc=$?
check "refused while the team is not halted" '[ $rc = 1 ] && grep -q "not halted" <<< "$(jq -r .error <<< "$proof")"'
refuse "unknown command" "$BIN/agent-kit-gate-proof" merge-everything

echo "== agent-kit-publish, owner-publish"
# Same repository as above: $T/ws is the agents' workspace, $T/bare the gate's.
pub() { AGENT_KIT_PATH=$FB:$PATH "$BIN/agent-kit-publish" "$@"; }
op() { "$BIN/owner-publish" "$@"; }
main1=$(git -C "$T/bare" rev-parse main)
st=$(pub status)
check "status before setup: main, nothing published, no remote" '[ "$(jq -r .main <<< "$st")" = "$main1" ] && [ "$(jq -r .published <<< "$st")" = null ] && [ "$(jq -r .remote <<< "$st")" = null ] && [ "$(jq -r .cycle <<< "$st")" = false ]'
check "no prompt and no request before publishing is set up" '[ -z "$(op prompt)" ] && ! echo hi | op request > /dev/null 2>&1'
refuse "an https remote" pub enable https://example.org/team/demo.git
refuse "a remote that is an ssh option" pub enable -oProxyCommand=id
refuse "a remote whose user part is an ssh option" pub enable -oProxyCommand=id@example.org:team/demo.git
refuse "a remote whose path starts with a dash" pub enable git@example.org:-team/demo.git
refuse "a remote with shell characters" pub enable 'git@example.org:team/demo.git;id'
refuse "a remote with a space" pub enable 'git@example.org:team/demo.git --upload-pack=id'
pub enable ssh://git@example.org:2222/team/demo.git > /dev/null
check "an ssh:// remote with a port is accepted" '[ "$(pub status | jq -r .remote)" = "ssh://git@example.org:2222/team/demo.git" ]'
pub enable git@example.org:team/demo.git > /dev/null
check "the prompt names the remote and the rules" 'grep -q "git@example.org:team/demo.git" <<< "$(op prompt)" && grep -q "You cannot push" <<< "$(op prompt)" && grep -q "Nothing has been published yet" <<< "$(op prompt)"'

head -c 9000 /dev/zero | tr '\0' x | op request > /dev/null
check "a request is a header and a capped summary" '[ "$(sed -n 1p "$S/publish-out/request.md")" = "Publish: yes" ] && grep -qE "^Date: [0-9T:-]{19}Z$" "$S/publish-out/request.md" && [ "$(wc -c < "$S/publish-out/request.md")" -lt 4100 ]'
echo "Not this cycle." | op request no > /dev/null
check "a request can be withdrawn" '[ "$(sed -n 1p "$S/publish-out/request.md")" = "Publish: no" ] && grep -q "Publish: no" <<< "$(op status)"'
refuse "a request with an unknown word" bash -c "echo x | '$BIN/owner-publish' request maybe"
check "no work file left behind" '[ ! -e "$S/publish-out/.request.tmp" ]'
echo "Menu fixes." | op request > /dev/null

# What the gate has not judged yet holds a publish back.
G fetch -q gate; G checkout -q -B work-y gate/main; echo y > "$T/ws/y.txt"; G add -A; G commit -q -m "work y"
G branch -f ready/work-y work-y > /dev/null
ysha=$(G rev-parse work-y)
check "a submitted branch without a verdict is counted" '[ "$(pub status | jq -r .unjudged)" = 1 ]'
check "a running cycle is reported" '[ "$(FAKE_ACTIVE=active pub status | jq -r .cycle)" = true ]'
( exec 9> "$T/run/agent-kit-gate.lock"; flock 9; sleep 3 ) &
sleep 0.5
check "a gate pass in progress is reported" '[ "$(pub status | jq -r .gateBusy)" = true ]'
wait
check "an idle gate is reported" '[ "$(pub status | jq -r .gateBusy)" = false ]'
refuse "a commit that is not on main cannot be recorded" pub record "$ysha"
"$T/opt/gate/bin/gate-run"
main2=$(git -C "$T/bare" rev-parse main)
check "after the gate's pass nothing is unjudged and main moved" '[ "$(pub status | jq -r .unjudged)" = 0 ] && [ "$main2" = "$ysha" ]'

# The bundle: main only, the same commits.
pub bundle > "$T/full.bundle"
check "the full bundle holds main and nothing else" '[ "$(git bundle list-heads "$T/full.bundle")" = "$main2 refs/heads/main" ]'
git init -q --bare "$T/mirror.git"
check "the bundle passes git's own checks and gives the same commit" 'git -C "$T/mirror.git" -c transfer.fsckObjects=true fetch -q "$T/full.bundle" "+refs/heads/main:refs/heads/main" && [ "$(git -C "$T/mirror.git" rev-parse main)" = "$main2" ]'
pub bundle "$main1" > "$T/part.bundle"
check "a bundle since an older commit is smaller and fits a repository that has that commit" '[ "$(wc -c < "$T/part.bundle")" -lt "$(wc -c < "$T/full.bundle")" ] && git -C "$T/mirror.git" bundle verify -q "$T/part.bundle" 2> /dev/null '
pub bundle "$main2" > "$T/none.bundle" 2> /dev/null; rc=$?
check "nothing newer: exit 3 and no bundle" '[ $rc = 3 ] && [ ! -s "$T/none.bundle" ]'
pub bundle 0000000000000000000000000000000000000001 > "$T/unknown.bundle" 2> /dev/null
check "a commit main does not contain gives all of main" '[ "$(git bundle list-heads "$T/unknown.bundle")" = "$main2 refs/heads/main" ] && [ "$(wc -c < "$T/unknown.bundle")" = "$(wc -c < "$T/full.bundle")" ]'
refuse "a bundle since something that is not a commit id" pub bundle main
refuse "a bundle since an option" pub bundle --all

pub record "$main1" > /dev/null
st=$(pub status)
check "a publish is recorded, with how far main is ahead" '[ "$(jq -r .published.sha <<< "$st")" = "$main1" ] && [ "$(jq -r .published.ahead <<< "$st")" = 1 ] && grep -q "main is 1 commit(s) ahead" <<< "$(op status)"'
refuse "record needs a commit id" pub record main
printf 'possible secret in commit %s, file config.py (rule generic-api-key) $(id) `id`\nsecond line\n' "${main2:0:9}" | pub blocked > /dev/null
check "a refusal is shown to the lead as plain text" 'grep -q "REFUSED" <<< "$(op status)" && grep -q "rule generic-api-key" <<< "$(op prompt)" && ! grep -q "[\$\`]" "$S/publish/blocked"'
pub record "$main2" > /dev/null
check "the next publish clears the refusal" '[ ! -e "$S/publish/blocked" ] && [ "$(pub status | jq -r .published.ahead)" = 0 ]'
pub disable > /dev/null
check "disabled: no prompt, the record stays" '[ -z "$(op prompt)" ] && [ -f "$S/publish/last" ]'
refuse "unknown command" pub push
refuse "unknown command for the lead" op push

check "lead-settings.json is a JSON object" 'jq -e "type == \"object\"" "$HERE/../lead-settings.json" > /dev/null'

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
