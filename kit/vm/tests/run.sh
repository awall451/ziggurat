#!/bin/bash
# Tests for the kit's owner-inbox, hook, caps, schedule, sign-in, one-shot and unit-scan scripts.
# Runs anywhere, as any user, in a temp folder:   bash kit/vm/tests/run.sh
# (Scripts that drive systemd, agent-kit-halt and agent-kit-resume, are only
# syntax-checked here; they are exercised on a real VM. agent-kit-oneshot runs
# against a stub systemctl.)
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
  start) [ -z "${FAKE_START_FAIL:-}" ] ;;
esac
EOF
chmod 755 "$FB/systemctl"
export AGENT_KIT_LOCK=$T/ctl.lock FAKE_LOG=$T/systemctl.log
shot() { AGENT_KIT_PATH=$FB:$PATH "$BIN/agent-kit-oneshot" "$@"; }
job() { tar -c -C "$T/work/j" . | shot start "$1" owner; }
J=20260101T120000Z-o-job1 J2=20260101T120100Z-o-job2
mkdir -p "$T/work/j"; echo "Fix the menu bug and soften the title music. Code word BASALT." > "$T/work/j/body.md"
echo "run 2026-01-01T00:00:00+00:00" > "$S/control"
refuse "one-shot on a team that is not halted" job $J
check "a refused job stores nothing" '[ ! -e "$S/inbox/$J" ] && [ ! -e "$S/oneshot" ]'
echo "stop owner halt for the night 2026-01-01T00:00:00+00:00" > "$S/control"
FAKE_ACTIVE=active refuse "one-shot while a cycle is still running" job $J
refuse "one-shot with a bad id" job ../../etc/x
echo "1000000000 old window" > "$S/halt-at"
job $J > /dev/null
check "job stored as an owner message" 'grep -q "^Tier: oneshot$" "$S/inbox/$J/message.md" && grep -q BASALT "$S/inbox/$J/message.md"'
check "marker names the job" '[ "$(cut -d" " -f1 "$S/oneshot")" = "$J" ]'
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

check "halt and resume drop the marker" 'grep -q "rm -f \"\$STATE/oneshot\"" "$BIN/agent-kit-halt" && grep -q "rm -f \"\$STATE/oneshot\"" "$BIN/agent-kit-resume"'

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
echo "stop owner 2026-01-01T07:00:00+00:00" > "$S/control"
out=$(cycle 2>&1)
check "no cycle on a halted team" 'grep -q "control=stop" <<< "$out" && [ ! -e "$FAKE_PROMPT" ]'
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
