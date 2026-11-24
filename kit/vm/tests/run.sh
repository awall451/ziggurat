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
check "an agent gets the kit's cost rules at its start, before the notice rule" 'jq -r .hookSpecificOutput.additionalContext <<< "$start" | head -1 | grep -q "Team rules from the agent kit, on cost" && grep -q "only the tests that cover what you touched" <<< "$start" && grep -q "agent-kit owner notice" <<< "$start"'
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
check "prompt tells the lead how to close an escalation" 'grep -q "add a line \`Resolved: <date>, <one sentence>\`" <<< "$out" && grep -q "write the id that \`ask\`" <<< "$out"'
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
check "list shows two new issues" '[ "$(wc -l <<< "$listed")" = 2 ] && grep -q "$I1  normal  *bug .*new .*Names box" <<< "$listed"'
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
# A planned issue (kit 0.11): an approved backlog item, done by its own job.
IP=20260101T120010Z-i-a00005
mkdir -p "$T/work/ip"; printf '# 1. Save slots\n\nBacklog item 20260101T000000Z-b-abcdef. Code word JASPER.\n' > "$T/work/ip/issue.md"
tarball ip | "$BIN/agent-kit-issues" put $IP planned > /dev/null
check "a planned issue is stored" 'grep -q "^Kind: planned$" "$S/issues/$IP/issue.md"'
check "a planned issue is listed" 'grep -q "$IP  normal  *planned" <<< "$("$BIN/owner-issues" list)"'
check "normal cycles are not given planned issues" '! grep -q JASPER <<< "$("$BIN/owner-issues" prompt)"'
echo "FREE_TAKE_APPROVED=1" > "$T/etc/caps.env"
check "unless the owner lets them take approved items" 'grep -q JASPER <<< "$("$BIN/owner-issues" prompt)"'
rm -f "$T/etc/caps.env"
echo "Started." | "$BIN/owner-issues" update $IP in_progress > /dev/null
check "the job that names it can update it" 'grep -q "$IP  normal  *planned .*in_progress" <<< "$("$BIN/owner-issues" list)"'
"$BIN/agent-kit-issues" set $IP done > /dev/null

# Kit 0.12: numbers, priority, amend, notes, the commit of a fix.
IN1=20260101T130000Z-i-b00001 IN2=20260101T130001Z-i-b00002
mkdir -p "$T/work/n1" "$T/work/n2" "$T/work/n1b/att" "$T/work/n1c/att" "$T/work/n1d"
printf '# Save menu flickers\n\nCode word TOPAZ.\n' > "$T/work/n1/issue.md"
printf '# Title music too loud\n\nCode word BERYL.\n' > "$T/work/n2/issue.md"
tarball n1 | "$BIN/agent-kit-issues" put $IN1 bug --number 7 --priority low > /dev/null
tarball n2 | "$BIN/agent-kit-issues" put $IN2 polish --number 8 --priority urgent > /dev/null
check "number and priority in the header" 'grep -qx "Number: 7" "$S/issues/$IN1/issue.md" && grep -qx "Priority: low" "$S/issues/$IN1/issue.md"'
refuse "a bad priority" bash -c "tar -c -C '$T/work/n2' . | '$BIN/agent-kit-issues' put 20260101T130002Z-i-b00003 bug --priority now"
refuse "a bad number" bash -c "tar -c -C '$T/work/n2' . | '$BIN/agent-kit-issues' put 20260101T130002Z-i-b00003 bug --number 0"
out=$("$BIN/owner-issues" prompt)
check "the prompt lists urgent first, with the number" '[ "$(grep -n "^--- #8 $IN2 (urgent) ---" <<< "$out" | cut -d: -f1)" -lt "$(grep -n "^--- #7 $IN1 (low) ---" <<< "$out" | cut -d: -f1)" ]'
check "the prompt explains the priorities" 'grep -q "urgent.: handle it before" <<< "$out"'
printf '# Save menu flickers on load\n\nCode word TOPAZ, now also on load.\n' > "$T/work/n1b/issue.md"; echo log > "$T/work/n1b/att/trace.log"
tarball n1b | "$BIN/agent-kit-issues" amend $IN1 --priority high --kind polish > /dev/null
check "amend replaces the text, keeps Raised and the number, sets priority and kind" 'grep -q "now also on load" "$S/issues/$IN1/issue.md" && grep -qx "Number: 7" "$S/issues/$IN1/issue.md" && grep -qx "Priority: high" "$S/issues/$IN1/issue.md" && grep -qx "Kind: polish" "$S/issues/$IN1/issue.md" && grep -q "^Raised: " "$S/issues/$IN1/issue.md" && grep -q "^Amended: " "$S/issues/$IN1/issue.md"'
check "amend adds a file" '[ -f "$S/issues/$IN1/att/trace.log" ] && [ "$(stat -c %a "$S/issues/$IN1/att/trace.log")" = 644 ]'
printf '# x\n' > "$T/work/n1c/issue.md"; echo other > "$T/work/n1c/att/trace.log"
refuse "amend never overwrites a file" bash -c "tar -c -C '$T/work/n1c' . | '$BIN/agent-kit-issues' amend $IN1"
check "the first file is kept" '[ "$(cat "$S/issues/$IN1/att/trace.log")" = log ]'
printf '# x\n' > "$T/work/n1d/issue.md"; echo png > "$T/work/n1d/shot.png"
refuse "amend does not replace the pictures" bash -c "tar -c -C '$T/work/n1d' . | '$BIN/agent-kit-issues' amend $IN1"
refuse "amend of an issue that does not exist" bash -c "tar -c -C '$T/work/n1d' . | '$BIN/agent-kit-issues' amend 20260101T130009Z-i-b00009"
mkdir -p "$T/work/n1e/att"; printf '# x\n' > "$T/work/n1e/issue.md"; for k in 1 2 3 4 5 6 7 8; do echo x > "$T/work/n1e/att/more$k.txt"; done
refuse "amend keeps an issue at 8 files" bash -c "tar -c -C '$T/work/n1e' . | '$BIN/agent-kit-issues' amend $IN1"
echo "Still happens after the update. Code word ONYX." | "$BIN/agent-kit-issues" note $IN1 owner > /dev/null
check "a note is kept root-side and shown" 'grep -q ONYX "$S/issues/$IN1/notes.md" && grep -q ONYX <<< "$("$BIN/owner-issues" show $IN1)"'
refuse "an empty note" bash -c "echo '  ' | '$BIN/agent-kit-issues' note $IN1 owner"
refuse "a note with a bad sender" bash -c "echo hi | '$BIN/agent-kit-issues' note $IN1 'x;id'"
check "an issue changed since the lead's update is marked" 'grep -q "^--- #7 $IN1 (high, changed by the owner since your last update) ---" <<< "$("$BIN/owner-issues" prompt)"'
sleep 1
echo "Fixed the flicker." | "$BIN/owner-issues" update $IN1 done --commit abc1234 > /dev/null
check "done with the commit that fixed it" 'grep -qx "Fixed-in: abc1234" "$S/issues-out/$IN1.md"'
refuse "a bad commit id" bash -c "echo x | '$BIN/owner-issues' update $IN2 done --commit 'zz;id'"
mkdir -p "$T/work/n2q"; printf '# Title music too loud\n\nCode word BERYL.\n' > "$T/work/n2q/issue.md"
echo "Seen." | "$BIN/owner-issues" update $IN2 in_progress > /dev/null; sleep 1
tarball n2q | "$BIN/agent-kit-issues" amend $IN2 --number 8 --quiet > /dev/null
check "a quiet amend (numbers for old issues) is not a change for the lead" '! grep -q "$IN2 (urgent, changed" <<< "$("$BIN/owner-issues" prompt)" && ! grep -q "^Amended: " "$S/issues/$IN2/issue.md"'
long=$(head -c 5000 /dev/zero | tr '\0' a)
mkdir -p "$T/work/n3"; printf '# Long one\n\n%s\n' "$long" > "$T/work/n3/issue.md"; echo png > "$T/work/n3/markup.png"
tarball n3 | "$BIN/agent-kit-issues" put 20260101T130003Z-i-b00004 idea --number 9 > /dev/null
echo "A note at the end. Code word OPAL." | "$BIN/agent-kit-issues" note 20260101T130003Z-i-b00004 owner > /dev/null
out=$("$BIN/owner-issues" prompt)
check "a long issue is cut, but its picture path and notes still follow" 'grep -q "cut here" <<< "$out" && grep -q "issues/20260101T130003Z-i-b00004/markup.png" <<< "$out" && grep -q OPAL <<< "$out"'
for x in $IN1 $IN2 20260101T130003Z-i-b00004; do "$BIN/agent-kit-issues" set $x done > /dev/null; done

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
echo '{"total_cost_usd":0.5,"num_turns":9,"result":"cycle summary","is_error":false,"modelUsage":{"model-a":{"inputTokens":3,"outputTokens":40,"cacheReadInputTokens":500,"cacheCreationInputTokens":60,"thinkingTokens":7,"costUSD":0.4},"model-b":{"inputTokens":1,"outputTokens":10,"cacheReadInputTokens":100,"cacheCreationInputTokens":20,"thinkingTokens":3,"costUSD":0.1}}}'
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
echo "minutes=25" >> "$S/oneshot.meta"
out=$(cycle 2>&1)
check "the ledger line keeps the job's estimate" '[ "$(tail -1 "$S/ledger/cycles.jsonl" | jq -r .est_min)" = 25 ]'
check "the ledger line sums the tokens of all models" 'tail -1 "$S/ledger/cycles.jsonl" | jq -e ".tokens == {in:4, out:50, cr:600, cw:80, think:10}" > /dev/null'
check "the ledger line keeps the tokens per model" 'tail -1 "$S/ledger/cycles.jsonl" | jq -e ".models[\"model-b\"] == {in:1, out:10, cr:100, cw:20, think:3, usd:0.1}" > /dev/null'
check "a one-shot cycle runs although the daily cap is used up" '[ -s "$FAKE_PROMPT" ] && grep -q "oneshot=$LC" <<< "$out"'
check "a one-shot cycle is told its number after the notice, before the team's own text" '[ "$(grep -n "^\*\*This is cycle 1\.\*\*" "$FAKE_PROMPT" | cut -d: -f1)" -gt "$(grep -n "Read this first" "$FAKE_PROMPT" | head -1 | cut -d: -f1)" ] && [ "$(grep -n "^\*\*This is cycle 1\.\*\*" "$FAKE_PROMPT" | cut -d: -f1)" -lt "$(grep -n "TEAM-CYCLE-TEXT" "$FAKE_PROMPT" | cut -d: -f1)" ]'
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
# The cycle's number (kit 0.23): counted as the owner's console counts.
check "a normal cycle's prompt starts with its number, then the team's own text" '[ "$(head -c 20 "$FAKE_PROMPT")" = "**This is cycle 1.**" ] && [ "$(grep -n "TEAM-CYCLE-TEXT" "$FAKE_PROMPT" | cut -d: -f1)" -gt 1 ]'
check "a normal cycle's ledger line names no job" '[ "$(tail -1 "$S/ledger/cycles.jsonl" | jq -r .oneshot)" = null ]'
check "a normal cycle has no estimate" '[ "$(tail -1 "$S/ledger/cycles.jsonl" | jq -r .est_min)" = null ]'
check "no publishing section unless publishing is set up" '! grep -q "^## Publishing" "$FAKE_PROMPT"'
# The kit's cost rules (kit 0.20).
check "a normal cycle's prompt has the cost rules" 'grep -q "^## Cost rules (agent kit)" "$FAKE_PROMPT" && grep -q "Redo on Opus:" "$FAKE_PROMPT" && ! grep -q "A small job" "$FAKE_PROMPT"'
check "no cache notice while the workspace has no agent files" '! grep -q "cacheTtl" "$FAKE_PROMPT"'
check "a one-shot cycle is told how to do a small job, after the team text and before the job" '[ "$(grep -n "A small job" <<< "$("$BIN/agent-kit-rules" lead oneshot)" | wc -l)" = 1 ]'
check "a planning cycle gets no cost rules" '[ -z "$("$BIN/agent-kit-rules" lead plan)" ]'
# The number is the cycle's place among counted cycles with a session: a try
# that hit a usage limit and a line without a session take none.
cp "$S/ledger/cycles.jsonl" "$T/ledger.keep"
{ jq -nc '{date:"2025-12-01", counted:true, session:"s-1"}'; jq -nc '{date:"2025-12-01", counted:false, session:"s-2"}'
  jq -nc '{date:"2025-12-01", counted:true}'; jq -nc '{date:"2025-12-01", counted:true, session:"s-3", kind:"plan"}'; } > "$S/ledger/cycles.jsonl"
out=$(cycle 2>&1)
check "the number counts normal, one-shot and planning cycles, not uncounted tries" '[ "$(head -c 20 "$FAKE_PROMPT")" = "**This is cycle 3.**" ]'
rm -f "$S/ledger/cycles.jsonl"; out=$(cycle 2>&1)
check "a team without a ledger starts at cycle 1" '[ "$(head -c 20 "$FAKE_PROMPT")" = "**This is cycle 1.**" ]'
mv "$T/ledger.keep" "$S/ledger/cycles.jsonl"
RW=$T/rules-ws; mkdir -p "$RW/.claude/agents"
printf -- '---\nname: area-lead-core\nmodel: opus\n---\nYou are a tech lead.\n' > "$RW/.claude/agents/area-lead-core.md"
check "the lead is asked to give its tech leads the one-hour cache" 'WORKSPACE=$RW AGENT_KIT_ETC=$T/none "$BIN/agent-kit-rules" lead normal | grep -q "cacheTtl: 1h"'
check "not in a one-shot cycle" '! WORKSPACE=$RW AGENT_KIT_ETC=$T/none "$BIN/agent-kit-rules" lead oneshot | grep -q "cacheTtl"'
printf -- '---\nname: area-lead-core\nmodel: opus\nexperimental:\n  cacheTtl: 1h\n---\nYou are a tech lead.\n' > "$RW/.claude/agents/area-lead-core.md"
check "and no longer once the lines are there" '! WORKSPACE=$RW AGENT_KIT_ETC=$T/none "$BIN/agent-kit-rules" lead normal | grep -q "cacheTtl"'
refuse "rules for an unknown reader" "$BIN/agent-kit-rules" everyone
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

echo "== agent-kit-schedule"
sch() { AGENT_KIT_PATH=$FB:$PATH "$BIN/agent-kit-schedule" "$@"; }
ny() { TZ=America/New_York date -d "$1" +%s; }      # a local time in the schedule's zone, as unix time
tick_at() { AGENT_KIT_NOW=$1 sch tick; }
starts() { grep -c "^start --no-block agent-kit-lead.service" "$FAKE_LOG" 2> /dev/null || true; }
rm -f "$T/etc/schedule" "$S/slot" "$S/schedule.used" "$S/schedule.log" "$S/oneshot" "$S/halt-after"
echo "run 2026-01-01T00:00:00+00:00" > "$S/control"
: > "$FAKE_LOG"
check "no schedule: nothing to show, a tick does nothing" '[ "$(sch show | jq -c "[.tz, (.slots | length)]")" = "[null,0]" ] && tick_at "$(ny "2026-01-05 13:30")" && [ ! -e "$S/slot" ] && [ "$(starts)" = 0 ]'
bad() { refuse "$1" bash -c "printf '%b' '$2' | AGENT_KIT_PATH='$FB:$PATH' '$BIN/agent-kit-schedule' set"; }
bad "a schedule without a time zone" 'slot daily 01:00\n'
bad "an unknown time zone" 'tz Mars/Phobos\nslot daily 01:00\n'
bad "a time zone that is a path" 'tz ../../etc/passwd\nslot daily 01:00\n'
bad "two time zones" 'tz UTC\ntz Europe/Paris\nslot daily 01:00\n'
bad "an unknown day" 'tz UTC\nslot funday 01:00\n'
bad "a time past midnight" 'tz UTC\nslot daily 24:00\n'
bad "a time without leading zeros" 'tz UTC\nslot daily 7:05\n'
bad "the same slot twice" 'tz UTC\nslot mon,wed 01:00\nslot wed,mon 01:00\n'
bad "a schedule without slots" 'tz UTC\n'
bad "extra words on a slot line" 'tz UTC\nslot daily 01:00 now\n'
bad "a line that is something else" 'tz UTC\nslot daily 01:00\nrun rm\n'
check "a refused schedule leaves no file" '[ ! -e "$T/etc/schedule" ] && [ ! -e "$T/etc/schedule.tmp" ]'
printf '# a team\ntz America/New_York\n\nslot daily 01:00\nslot wed,mon,wed 13:30\n' | AGENT_KIT_NOW=$(ny "2026-01-04 09:00") sch set > /dev/null
check "the stored schedule is in a fixed form" '[ "$(cat "$T/etc/schedule")" = "tz America/New_York
slot daily 01:00
slot mon,wed 13:30" ]'
check "show gives it back as data" '[ "$(sch show | jq -c "[.tz, .slots[1].days, .slots[1].time]")" = "[\"America/New_York\",[\"mon\",\"wed\"],\"13:30\"]" ]'

# 2026-01-05 is a Monday.
tick_at "$(ny "2026-01-05 13:29")"
check "a minute before the slot nothing happens" '[ "$(starts)" = 0 ] && [ ! -e "$S/slot" ] && [ ! -s "$S/schedule.log" ]'
t=$(ny "2026-01-05 13:30"); tick_at "$t"
check "at the slot the cycle is started, with a marker that names the slot" '[ "$(starts)" = 1 ] && [ "$(cat "$S/slot")" = "mon,wed@13:30 $t" ] && grep -q " mon,wed@13:30 2026-01-05 started$" "$S/schedule.log"'
tick_at "$(ny "2026-01-05 13:31")"; tick_at "$(ny "2026-01-05 13:38")"
check "a slot is used once" '[ "$(starts)" = 1 ] && [ "$(wc -l < "$S/schedule.log")" = 1 ]'
tick_at "$(ny "2026-01-06 13:30")"
check "not on a day the slot does not name" '[ "$(starts)" = 1 ]'
tick_at "$(ny "2026-01-07 13:30")"
check "again on the next day it names" '[ "$(starts)" = 2 ]'

FAKE_ACTIVE=active tick_at "$(ny "2026-01-08 01:00")"
check "a slot is skipped while a cycle runs, and not queued" '[ "$(starts)" = 2 ] && grep -q " daily@01:00 2026-01-08 skipped: a cycle is running$" "$S/schedule.log" && tick_at "$(ny "2026-01-08 01:03")" && [ "$(starts)" = 2 ]'
echo "stop owner halt 2026-01-01T00:00:00+00:00" > "$S/control"
tick_at "$(ny "2026-01-09 01:00")"
check "skipped on a halted team" '[ "$(starts)" = 2 ] && grep -q " 2026-01-09 skipped: halted$" "$S/schedule.log"'
echo "run 2026-01-01T00:00:00+00:00" > "$S/control"
FAKE_TIMER=disabled tick_at "$(ny "2026-01-10 01:00")"
check "skipped when the lead timer is off" '[ "$(starts)" = 2 ] && grep -q " 2026-01-10 skipped: timer off$" "$S/schedule.log"'
echo "$J 2026-01-01T00:00:00+00:00 run" > "$S/oneshot"
tick_at "$(ny "2026-01-11 01:00")"
check "skipped during a one-shot job" '[ "$(starts)" = 2 ] && grep -q " 2026-01-11 skipped: a one-shot job is in progress$" "$S/schedule.log"'
rm -f "$S/oneshot"
t=$(ny "2026-01-12 01:00"); cp "$S/ledger/cycles.jsonl" "$T/ledger.keep"
for i in 1 2 3 4 5 6 7; do jq -nc --arg d "$(date -d "@$t" +%F)" '{date:$d, counted:true}'; done >> "$S/ledger/cycles.jsonl"
tick_at "$t"
check "skipped when the daily cap is used up" '[ "$(starts)" = 2 ] && grep -qE " 2026-01-12 skipped: daily cap \(7/[0-9]+\)$" "$S/schedule.log"'
cp "$T/ledger.keep" "$S/ledger/cycles.jsonl"

tick_at "$(ny "2026-01-13 01:07")"
check "a slot a few minutes late is still used" '[ "$(starts)" = 3 ] && grep -q " daily@01:00 2026-01-13 started$" "$S/schedule.log"'
tick_at "$(ny "2026-01-14 01:15")"
check "a slot missed by more than the grace time is not caught up" '[ "$(starts)" = 3 ] && ! grep -q " 2026-01-14 " "$S/schedule.log"'

# Daylight saving in the schedule's zone. 2026-03-08: 02:00 to 03:00 does not exist there.
printf 'tz America/New_York\nslot daily 02:30\nslot daily 01:30\n' | AGENT_KIT_NOW=$(ny "2026-03-07 12:00") sch set > /dev/null
: > "$FAKE_LOG"
for hm in 01:59 03:00 03:05 03:30; do tick_at "$(ny "2026-03-08 $hm")"; done
check "a local time that does not exist that day starts nothing" '[ "$(starts)" = 0 ]'
# 2026-11-01: 01:30 happens twice there (05:30 and 06:30 UTC).
tick_at "$(date -u -d "2026-11-01 05:30" +%s)"; tick_at "$(date -u -d "2026-11-01 06:30" +%s)"
check "a local time that happens twice starts one cycle" '[ "$(starts)" = 1 ] && [ "$(grep -c " daily@01:30 2026-11-01 started$" "$S/schedule.log")" = 1 ]'
# Setting a schedule must not fire a slot whose minute has just passed.
: > "$FAKE_LOG"
printf 'tz America/New_York\nslot daily 09:30\n' | AGENT_KIT_NOW=$(ny "2026-01-20 09:32") sch set > /dev/null
tick_at "$(ny "2026-01-20 09:33")"
check "a slot that passed just before the schedule was set does not fire" '[ "$(starts)" = 0 ]'
tick_at "$(ny "2026-01-21 09:30")"
check "it fires the next day" '[ "$(starts)" = 1 ]'
# Kit 0.14.1: the owner gives one start to a backlog job.
sch skip daily@09:30 2026-01-22 > /dev/null
tick_at "$(ny "2026-01-22 09:30")"
check "a skipped start does not fire, and says why" '[ "$(starts)" = 1 ] && grep -q " daily@09:30 2026-01-22 skipped: the owner gave this time to a backlog job$" "$S/schedule.log"'
tick_at "$(ny "2026-01-23 09:30")"
check "only that once" '[ "$(starts)" = 2 ]'
sch skip daily@09:30 2026-01-24 > /dev/null; sch unskip daily@09:30 2026-01-24 > /dev/null
tick_at "$(ny "2026-01-24 09:30")"
check "a skip can be taken back" '[ "$(starts)" = 3 ]'
# Kit 0.14.1: one day of a slot moved or skipped in the schedule itself (like one event of a recurring entry).
printf 'tz America/New_York\nslot daily 09:30\nmove 2026-01-26 daily@09:30 11:15\nskip 2026-01-27 daily@09:30\n' | AGENT_KIT_NOW=$(ny "2026-01-25 12:00") sch set > /dev/null
check "one-day changes are kept and shown" 'grep -qx "move 2026-01-26 daily@09:30 11:15" "$T/etc/schedule" && [ "$(sch show | jq -r ".changes | length")" = 2 ]'
n0=$(starts)
tick_at "$(ny "2026-01-26 09:30")"
check "a start moved for one day does not fire at its own time" '[ "$(starts)" = "$n0" ]'
tick_at "$(ny "2026-01-26 11:15")"
check "it fires at the new time, under its own name" '[ "$(starts)" = $((n0 + 1)) ] && grep -q " daily@09:30 2026-01-26 started$" "$S/schedule.log"'
tick_at "$(ny "2026-01-27 09:30")"
check "a start skipped for one day does not fire" '[ "$(starts)" = $((n0 + 1)) ]'
tick_at "$(ny "2026-01-28 09:30")"
check "the next day it is back at its own time" '[ "$(starts)" = $((n0 + 2)) ]'
refuse "a bad one-day change" bash -c "printf 'tz America/New_York\\nslot daily 09:30\\nmove tomorrow daily@09:30 11:15\\n' | AGENT_KIT_PATH=$FB:\$PATH '$BIN/agent-kit-schedule' set"
refuse "a skip with a bad slot" sch skip 'x;id' 2026-01-25
refuse "a skip with a bad date" sch skip daily@09:30 tomorrow

# lead-cycle with a schedule: only a fresh marker starts a normal cycle.
head -2 "$S/ledger/cycles.jsonl" > "$S/ledger/cycles.tmp"; mv "$S/ledger/cycles.tmp" "$S/ledger/cycles.jsonl"
rm -f "$S/slot" "$S/ledger/slot-used"
out=$(cycle 2>&1)
check "with a schedule, a start without a slot marker does nothing" 'grep -q "waiting for the next slot" <<< "$out" && [ ! -e "$FAKE_PROMPT" ]'
echo "daily@09:30 $(($(date +%s) - 1000))" > "$S/slot"
out=$(cycle 2>&1)
check "an old marker does not start a cycle" 'grep -q "waiting for the next slot" <<< "$out" && [ ! -e "$FAKE_PROMPT" ]'
echo "daily@09:30;id $(date +%s)" > "$S/slot"
out=$(cycle 2>&1)
check "a marker that is not a slot name does not start a cycle" 'grep -q "waiting for the next slot" <<< "$out" && [ ! -e "$FAKE_PROMPT" ]'
echo "daily@09:30 $(date +%s)" > "$S/slot"
out=$(cycle 2>&1)
check "a fresh marker starts the cycle, and the ledger names the slot" '[ -s "$FAKE_PROMPT" ] && [ "$(tail -1 "$S/ledger/cycles.jsonl" | jq -r .slot)" = "daily@09:30" ] && [ "$(tail -1 "$S/ledger/cycles.jsonl" | jq -r .oneshot)" = null ]'
out=$(cycle 2>&1)
check "one marker starts one cycle" 'grep -q "waiting for the next slot" <<< "$out" && [ ! -e "$FAKE_PROMPT" ]'
# A one-shot job is the owner asking: the schedule does not hold it back.
LS=20260101T150000Z-o-slotjob
echo "stop owner halt 2026-01-01T05:00:00+00:00" > "$S/control"
tar -c -C "$T/work/lc" . | shot start $LS owner > /dev/null
rm -f "$S/slot"
out=$(cycle 2>&1)
check "a one-shot job runs without a slot" '[ -s "$FAKE_PROMPT" ] && grep -q "oneshot=$LS" <<< "$out" && [ "$(tail -1 "$S/ledger/cycles.jsonl" | jq -r .slot)" = null ]'
shot finish > /dev/null
echo "run 2026-01-01T00:00:00+00:00" > "$S/control"
sch clear > /dev/null
check "clear removes the schedule and its marker" '[ ! -e "$T/etc/schedule" ] && [ ! -e "$S/slot" ] && [ "$(sch show | jq -r ".slots | length")" = 0 ]'
head -2 "$S/ledger/cycles.jsonl" > "$S/ledger/cycles.tmp"; mv "$S/ledger/cycles.tmp" "$S/ledger/cycles.jsonl"
out=$(cycle 2>&1)
check "without a schedule cycles start as before" '[ -s "$FAKE_PROMPT" ] && grep -q "oneshot=no" <<< "$out"'
refuse "unknown command" sch start-now
check "the tick unit runs the schedule after the stop check" '[ "$(grep -n "agent-kit-schedule tick" "$HERE/../systemd/agent-kit-tick.service" | cut -d: -f1)" -gt "$(grep -n "agent-kit-halt --if-due" "$HERE/../systemd/agent-kit-tick.service" | cut -d: -f1)" ]'
echo "stop owner 2026-01-01T09:00:00+00:00" > "$S/control"

# The sections below build their own workspace and gate results: leave none behind.
rm -rf "$T/ws" "$S/gate/results"

echo "== a start time that repeats less often, or ends (kit 0.26)"
rm -f "$T/etc/schedule" "$S/slot" "$S/schedule.used" "$S/schedule.log" "$S/oneshot"
echo "run 2026-02-01T00:00:00+00:00" > "$S/control"
bad "every without a first date" 'tz UTC\nslot daily 06:00 every=2\n'
bad "count without a first date" 'tz UTC\nslot daily 06:00 count=3\n'
bad "every 0" 'tz UTC\nslot daily 06:00 every=0 from=2026-02-02\n'
bad "a count over the limit" 'tz UTC\nslot daily 06:00 from=2026-02-02 count=501\n'
bad "a date that does not exist" 'tz UTC\nslot daily 06:00 from=2026-02-30\n'
bad "an end before the start" 'tz UTC\nslot daily 06:00 from=2026-02-10 until=2026-02-01\n'
bad "an unknown field" 'tz UTC\nslot daily 06:00 often=2\n'
# 2026-02-02 is a Monday.
printf 'tz America/New_York\nslot daily 06:00 every=2 from=2026-02-02\nslot tue,thu 09:00 every=2 from=2026-02-02\nslot daily 22:00 from=2026-02-02 count=3\nslot mon,fri 10:00 every=2 from=2026-02-04 count=3\nslot daily 07:00 until=2026-02-01\nslot daily 08:00 from=2026-02-10\n' | sch set > /dev/null
check "a count is stored with the date of its last start" 'grep -qx "slot daily 22:00 from=2026-02-02 until=2026-02-04 count=3" "$T/etc/schedule" && grep -qx "slot mon,fri 10:00 every=2 from=2026-02-04 until=2026-02-20 count=3" "$T/etc/schedule"'
check "every 1 is not written" 'grep -qx "slot daily 07:00 until=2026-02-01" "$T/etc/schedule"'
check "show gives the new fields as data" '[ "$(sch show | jq -c ".slots[] | select(.time == \"22:00\") | [.from, .until, .count, .every]")" = "[\"2026-02-02\",\"2026-02-04\",3,null]" ] && [ "$(sch show | jq -c ".slots[] | select(.time == \"06:00\") | .every")" = 2 ]'
ran() { grep -q " $1 $2 started$" "$S/schedule.log"; }
for d in 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24; do
  for hm in 06:00 07:00 08:00 09:00 10:00 22:00; do tick_at "$(ny "2026-02-$d $hm")"; rm -f "$S/slot"; done
done
check "every other day, from its first date" 'ran daily@06:00 2026-02-02 && ! ran daily@06:00 2026-02-03 && ran daily@06:00 2026-02-04 && ran daily@06:00 2026-02-24'
check "every other week on its days" 'ran tue,thu@09:00 2026-02-03 && ran tue,thu@09:00 2026-02-05 && ! ran tue,thu@09:00 2026-02-10 && ! ran tue,thu@09:00 2026-02-12 && ran tue,thu@09:00 2026-02-17'
check "three times, then no more" 'ran daily@22:00 2026-02-04 && ! ran daily@22:00 2026-02-05 && [ "$(grep -c " daily@22:00 .* started$" "$S/schedule.log")" = 3 ]'
check "every other week, three times, from a Wednesday" '! ran mon,fri@10:00 2026-02-02 && ran mon,fri@10:00 2026-02-06 && ! ran mon,fri@10:00 2026-02-09 && ran mon,fri@10:00 2026-02-16 && ran mon,fri@10:00 2026-02-20 && [ "$(grep -c " mon,fri@10:00 .* started$" "$S/schedule.log")" = 3 ]'
check "not after its last date, not before its first" '! grep -q " daily@07:00 .* started$" "$S/schedule.log" && ! ran daily@08:00 2026-02-09 && ran daily@08:00 2026-02-10'
rm -f "$T/etc/schedule" "$S/slot" "$S/schedule.used" "$S/schedule.log"

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

echo "== gate-run keeps the screenshots of merged builds"
# Checks that write screenshots, including some the gate must not copy.
cat > "$T/opt/gate/bin/gate-checks" <<'STUB'
#!/bin/bash
cd "$1" || exit 2
mkdir -p "$2/shots"
printf 'png' > "$2/shots/01-title.png"; printf 'png' > "$2/shots/02-room.png"
printf 'x' > "$2/shots/bad name.png"; printf 'x' > "$2/shots/notes.txt"
ln -s /etc/hostname "$2/shots/link.png"
[ -f BROKEN ] && { echo "STEP unit FAIL 0s"; exit 1; }
echo "STEP unit ok 0s"
echo "TESTS_PASSED=$(ls tests/test_*.py 2>/dev/null | wc -l)"
STUB
G fetch -q gate; G checkout -q -B shots-a gate/main; echo a > "$T/ws/a.txt"; G add -A; G commit -q -m "shots a"
G branch -f ready/shots-a shots-a > /dev/null
asha=$(G rev-parse shots-a)
"$T/opt/gate/bin/gate-run"
check "a merged build's screenshots are kept by sha" '[ "$(jq -r .status "$S/gate/results/shots-a.json")" = merged ] && [ -f "$S/gate/shots/$asha/01-title.png" ] && [ -f "$S/gate/shots/$asha/02-room.png" ]'
check "links, odd names and other files are not copied" '[ ! -e "$S/gate/shots/$asha/link.png" ] && [ ! -e "$S/gate/shots/$asha/bad name.png" ] && [ ! -e "$S/gate/shots/$asha/notes.txt" ]'
check "the index names the build and its topic" 'grep -qE "^[0-9T:+-]+ $asha shots-a$" "$S/gate/shots/index"'
G fetch -q gate; G checkout -q -B shots-b gate/main; touch "$T/ws/BROKEN"; G add -A; G commit -q -m "shots b"
G branch -f ready/shots-b shots-b > /dev/null
bsha=$(G rev-parse shots-b)
"$T/opt/gate/bin/gate-run"
check "a failed build keeps no screenshots" '[ "$(jq -r .status "$S/gate/results/shots-b.json")" = failed ] && [ ! -e "$S/gate/shots/$bsha" ] && ! grep -q "$bsha" "$S/gate/shots/index"'
G branch -q -D ready/shots-a ready/shots-b; G checkout -q -B main gate/main

echo "== changes to what done means wait for the owner (kit 0.14)"
og() { "$BIN/owner-gate" "$@"; }
kg() { AGENT_KIT_PATH=$FB:$PATH "$BIN/agent-kit-gate" "$@"; }
check "no owner paths: no prompt section" '[ -z "$(og prompt)" ]'
echo 'GATE_OWNER_PATHS=tools/check,tools/check.d,../etc,*' >> "$T/etc/project.env"
G fetch -q gate; G checkout -q -B hold-a gate/main; mkdir -p "$T/ws/tools"; echo 'echo TESTS_PASSED=9' > "$T/ws/tools/check"; G add -A; G commit -q -m "new checks"
G branch -f ready/hold-a hold-a > /dev/null
hsha=$(G rev-parse hold-a); mainh=$(git -C "$T/bare" rev-parse main)
"$T/opt/gate/bin/gate-run"
check "a change to tools/check is held, not merged" '[ "$(jq -r .status "$S/gate/results/hold-a.json")" = held ] && [ "$(git -C "$T/bare" rev-parse main)" = "$mainh" ] && grep -q "tools/check" <<< "$(jq -r .detail "$S/gate/results/hold-a.json")"'
check "a held build keeps no screenshots yet" '[ ! -e "$S/gate/shots/$hsha" ]'
check "the lead sees it is held and not explained" 'grep -q "NOT EXPLAINED" <<< "$(og list)" && grep -q "Held for the owner now" <<< "$(og prompt)" && grep -q "tools/check tools/check.d" <<< "$(og prompt)"'
refuse "an empty explanation" bash -c ": | '$BIN/owner-gate' explain hold-a"
refuse "an explanation for a branch that does not exist" bash -c "echo why | '$BIN/owner-gate' explain nope"
refuse "an explanation that is too long" bash -c "head -c 9000 /dev/zero | tr '\\0' x | '$BIN/owner-gate' explain hold-a"
printf 'Runs the new unit tests.\nNothing is removed.\n' | og explain ready/hold-a > /dev/null
check "the explanation names the topic and the commit" '[ "$(sed -n "s/^Sha: //p" "$S/gate-out/hold-a.md")" = "$hsha" ] && grep -q "^Topic: hold-a$" "$S/gate-out/hold-a.md" && grep -q "Nothing is removed" "$S/gate-out/hold-a.md"'
check "listed as explained" 'grep -q "hold-a  ${hsha:0:9}  explained" <<< "$(og list)"'
n0=$(grep -c " hold-a " "$S/gate/history.log")
"$T/opt/gate/bin/gate-run"
check "a held change is not judged again before the owner decides" '[ "$(grep -c " hold-a " "$S/gate/history.log")" = "$n0" ]'
check "agent-kit-gate held lists it" '[ "$(kg held | jq -r .sha)" = "$hsha" ]'
refuse "approve needs a full sha" kg approve "${hsha:0:9}"
refuse "approve needs a held change" kg approve "$(printf 'a%.0s' {1..40})"
kg approve "$hsha" > /dev/null
check "the approval is root-side state" '[ -f "$S/gate/approved/$hsha" ]'
"$T/opt/gate/bin/gate-run"
check "after approval the gate judges it again and merges it" '[ "$(jq -r .status "$S/gate/results/hold-a.json")" = merged ] && [ "$(git -C "$T/bare" rev-parse main)" = "$hsha" ]'
check "nothing is held any more" '[ -z "$(kg held)" ] && [ -z "$(og prompt | grep "Held for the owner now")" ]'
G fetch -q gate; G checkout -q -B hold-b gate/main; echo 'echo TESTS_PASSED=1' > "$T/ws/tools/check"; G add -A; G commit -q -m "weaker checks"
G branch -f ready/hold-b hold-b > /dev/null
bsha=$(G rev-parse hold-b)
"$T/opt/gate/bin/gate-run"
check "the next change to the checks is held again" '[ "$(jq -r .status "$S/gate/results/hold-b.json")" = held ]'
kg deny "$bsha" > /dev/null
"$T/opt/gate/bin/gate-run"
check "a declined change fails and stays out of main" '[ "$(jq -r .status "$S/gate/results/hold-b.json")" = failed ] && grep -q "declined" <<< "$(jq -r .detail "$S/gate/results/hold-b.json")" && [ "$(git -C "$T/bare" rev-parse main)" = "$hsha" ] && tail -1 "$S/gate/history.log" | grep -q " hold-b $bsha failed "'
refuse "deny of something no longer held" kg deny "$bsha"
G fetch -q gate; G checkout -q -B hold-c gate/main; echo c > "$T/ws/c.txt"; G add -A; G commit -q -m "product work"
G branch -f ready/hold-c hold-c > /dev/null
"$T/opt/gate/bin/gate-run"
check "work that does not touch the checks merges as before" '[ "$(jq -r .status "$S/gate/results/hold-c.json")" = merged ]'
sed -i '/GATE_OWNER_PATHS/d' "$T/etc/project.env"
G branch -q -D ready/hold-a ready/hold-b ready/hold-c; G checkout -q -B main gate/main

echo "== neutral gate-checks"
NG=$HERE/../gate/neutral-gate-checks
mkdir -p "$T/ng/w" "$T/ng/o"
out=$("$NG" "$T/ng/w" "$T/ng/o"); rc=$?
check "no tools/check: a failed step that says why" '[ $rc = 1 ] && grep -q "^STEP check FAIL" <<< "$out" && grep -q "no tools/check" <<< "$out"'
mkdir -p "$T/ng/w/tools"
printf 'echo "STEP unit ok 0s"\nmkdir -p "$1/shots"; printf p > "$1/shots/a.png"\necho TESTS_PASSED=3\n' > "$T/ng/w/tools/check"
out=$("$NG" "$T/ng/w" "$T/ng/o"); rc=$?
check "a passing tools/check: its lines, the count, screenshots in the out folder" '[ $rc = 0 ] && grep -q "^STEP unit ok" <<< "$out" && grep -q "^TESTS_PASSED=3$" <<< "$out" && grep -q "ALL CHECKS PASSED" <<< "$out" && [ -f "$T/ng/o/shots/a.png" ]'
printf 'echo hello; exit 4\n' > "$T/ng/w/tools/check"
out=$("$NG" "$T/ng/w" "$T/ng/o"); rc=$?
check "a failing tools/check without a STEP line still names a failed step" '[ $rc = 1 ] && grep -q "^STEP check FAIL" <<< "$out"'
printf 'echo "STEP unit ok 0s"\n' > "$T/ng/w/tools/check"
out=$("$NG" "$T/ng/w" "$T/ng/o"); rc=$?
check "no TESTS_PASSED line fails" '[ $rc = 1 ] && grep -q "no TESTS_PASSED" <<< "$out"'
rm "$T/ng/w/tools/check"; ln -s /bin/true "$T/ng/w/tools/check"
out=$("$NG" "$T/ng/w" "$T/ng/o"); rc=$?
check "a tools/check that is a link is refused" '[ $rc = 1 ]'

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

echo "== planning cycle, backlog, chat (kit 0.10)"
cat > "$FB/claude" <<'EOF'
#!/bin/bash
printf '%s\n' "$@" > "$FAKE_ARGS"
while [ $# -gt 0 ]; do [ "$1" = -p ] && { printf '%s' "$2" > "$FAKE_PROMPT"; break; }; shift; done
[ -n "${FAKE_TOUCH:-}" ] && echo x > "$FAKE_TOUCH"
sid=$(grep -A1 -x -e --session-id -e --resume "$FAKE_ARGS" | tail -1)
[ -n "${FAKE_JSON:-}" ] && { echo "$FAKE_JSON"; exit 1; }
echo "{\"total_cost_usd\":${FAKE_COST:-0.5},\"num_turns\":3,\"result\":\"${FAKE_RESULT:-plan summary}\",\"is_error\":false,\"session_id\":\"$sid\"}"
EOF
chmod 755 "$FB/claude"
export FAKE_ARGS=$T/args.txt
mkdir -p "$T/ws"; git -C "$T/ws" init -q 2>/dev/null
ob() { "$BIN/owner-backlog" "$@"; }
akb() { "$BIN/agent-kit-backlog" "$@"; }
chat() { AGENT_KIT_PATH=$FB:$PATH "$BIN/agent-kit-chat" "$@"; }
PL=20260102T100000Z-p-plan1 PL2=20260102T110000Z-p-plan2
rm -f "$S/oneshot"; : > "$S/ledger/cycles.jsonl"
echo "stop owner 2026-01-02T00:00:00+00:00" > "$S/control"
refuse "a planning cycle with a job id" shot start $J2 owner --plan
refuse "a job with a plan id" job $PL
: > "$FAKE_LOG"
echo "Focus on the save system. Code word FELDSPAR." | shot start $PL owner --plan > /dev/null
check "a planning request is stored in the backlog, not the inbox" '[ -f "$S/backlog/plans/$PL/request.md" ] && grep -q FELDSPAR "$S/backlog/plans/$PL/request.md" && [ ! -e "$S/inbox/$PL" ]'
check "it is the current plan" '[ "$(cat "$S/backlog/current")" = "$PL" ]'
check "marker and control name the plan" '[ "$(cut -d" " -f1 "$S/oneshot")" = "$PL" ] && grep -q "^run oneshot $PL " "$S/control"'
out=$(cycle 2>&1)
check "the planning cycle runs" '[ -s "$FAKE_PROMPT" ] && grep -q "oneshot=$PL" <<< "$out"'
check "a planning cycle is told its number too" 'grep -q "^\*\*This is cycle [0-9]*\.\*\*" "$FAKE_PROMPT"'
check "its prompt starts with the planning notice" '[ "$(head -c 50 "$FAKE_PROMPT")" = "**Read this first: this cycle is a planning cycle." ]'
check "its prompt holds the focus and the rules, not the one-shot rules" 'grep -q FELDSPAR "$FAKE_PROMPT" && grep -q "^## Planning cycle: this cycle only" "$FAKE_PROMPT" && ! grep -q "^## One-shot job" "$FAKE_PROMPT"'
check "it runs with the planning tools and budget" 'grep -qx -- --tools "$FAKE_ARGS" && grep -qx "Read,Grep,Glob,Bash" "$FAKE_ARGS" && [ "$(grep -A1 -x -- --max-budget-usd "$FAKE_ARGS" | tail -1)" = 2 ]'
L=$(tail -1 "$S/ledger/cycles.jsonl")
check "ledger line: kind plan, the plan id, no code touched" '[ "$(jq -r .kind <<< "$L")" = plan ] && [ "$(jq -r .plan <<< "$L")" = "$PL" ] && [ "$(jq -r .touched_code <<< "$L")" = false ]'
SID=$(cat "$S/ledger/plans/$PL")
check "the session id is kept for the chat" '[[ $SID =~ ^[0-9a-f-]{36}$ ]] && [ "$(jq -r .session <<< "$L")" = "$SID" ]'
shot finish > /dev/null
check "the team is halted again after the planning cycle" 'grep -q "^stop one-shot job $PL ended" "$S/control"'
# A planning cycle that changes the workspace anyway is flagged.
echo "Second plan." | shot start $PL2 owner --plan > /dev/null
FAKE_TOUCH=$T/ws/stray.txt cycle > /dev/null 2>&1
check "a planning cycle that changed the workspace is flagged" '[ "$(tail -1 "$S/ledger/cycles.jsonl" | jq -r .touched_code)" = true ]'
rm -f "$T/ws/stray.txt"; shot finish > /dev/null
check "a normal cycle's prompt has the backlog section" 'echo "run 2026-01-02T01:00:00+00:00" > "$S/control"; cycle > /dev/null 2>&1; grep -q "^## Backlog: proposals to the owner" "$FAKE_PROMPT" && [ "$(tail -1 "$S/ledger/cycles.jsonl" | jq -r .kind)" = normal ]'
echo "stop owner 2026-01-02T02:00:00+00:00" > "$S/control"

# Proposals.
prop() { ob propose --title "Save slots" --minutes 45 --cost 1.20 --confidence medium --areas "save system" "$@"; }
B1=$(echo "Why: players lose progress. Steps: 1. add slots" | prop | awk '{print $2}')
check "a proposal is written with its estimate" '[ -f "$S/backlog-out/$B1.md" ] && grep -qx "Minutes: 45" "$S/backlog-out/$B1.md" && grep -qx "Plan: $PL2" "$S/backlog-out/$B1.md" && grep -qx "Rev: 1" "$S/backlog-out/$B1.md"'
refuse "a proposal over 90 minutes" sh -c "echo x | $BIN/owner-backlog propose --title T --minutes 120 --cost 1 --confidence low"
refuse "a proposal with a bad confidence" sh -c "echo x | $BIN/owner-backlog propose --title T --minutes 30 --cost 1 --confidence sure"
refuse "a proposal with a bad cost" sh -c "echo x | $BIN/owner-backlog propose --title T --minutes 30 --cost '1;id' --confidence low"
refuse "a title on two lines" sh -c "echo x | $BIN/owner-backlog propose --title \"\$(printf 'a\nb')\" --minutes 30 --cost 1 --confidence low"
refuse "a dependency that does not exist" sh -c "echo x | $BIN/owner-backlog propose --title T --minutes 30 --cost 1 --confidence low --depends 20260101T000000Z-b-abcdef"
refuse "a proposal with a model that is not offered" sh -c "echo x | $BIN/owner-backlog propose --title T --minutes 30 --cost 1 --confidence low --model fable"
check "a proposal without a model has no model line" '! grep -q "^Model:" "$S/backlog-out/$B1.md"'
check "the planning rules ask for the model of the job" 'grep -q -- "--model sonnet" <<< "$(ob plan $PL2)" && grep -q "The owner sees it and may choose the other" <<< "$(ob plan $PL2)"'
refuse "a proposal without text" sh -c "$BIN/owner-backlog propose --title T --minutes 30 --cost 1 --confidence low < /dev/null"
refuse "a proposal that is too long" sh -c "head -c 9000 /dev/zero | tr '\0' a | $BIN/owner-backlog propose --title T --minutes 30 --cost 1 --confidence low"
B2=$(echo "Second step" | prop --order 2 --depends "$B1" | awk '{print $2}')
check "a proposal may depend on another" 'grep -qx "Depends: $B1" "$S/backlog-out/$B2.md"'
echo "" | ob revise "$B1" --minutes 60 > /dev/null
check "a revision keeps the rest and counts up" 'grep -qx "Rev: 2" "$S/backlog-out/$B1.md" && grep -qx "Minutes: 60" "$S/backlog-out/$B1.md" && grep -q "players lose progress" "$S/backlog-out/$B1.md"'
refuse "the owner decides on a proposal that does not exist" akb set 20260101T000000Z-b-abcdef approved 1
refuse "a bad decision" akb set "$B1" maybe 2
refuse "a bad revision" akb set "$B1" approved x
akb set "$B1" approved 1 > /dev/null
check "an approval of an older revision does not count" 'grep -q "revised after approved" <<< "$(ob list)"'
akb set "$B1" approved 2 > /dev/null
check "approved" 'grep -q "$B1  approved" <<< "$(ob list)"'
refuse "taking an approved item when the owner has not allowed it" ob taken "$B1"
check "no approved items in the prompt by default" '! grep -q "$B1" <<< "$(ob prompt)"'
"$BIN/agent-kit-caps" set FREE_TAKE_APPROVED 1 > /dev/null
check "allowed: approved items are offered to normal cycles" 'grep -q "$B1" <<< "$(ob prompt)" && ! grep -q "$B2" <<< "$(ob prompt)"'
ob taken "$B1" > /dev/null
check "a taken item is no longer offered" '! grep -q "$B1" <<< "$(ob prompt)" && grep -q "$B1  taken" <<< "$(ob list)"'
"$BIN/agent-kit-caps" set FREE_TAKE_APPROVED 0 > /dev/null
refuse "FREE_TAKE_APPROVED must be 0 or 1" "$BIN/agent-kit-caps" set FREE_TAKE_APPROVED yes
refuse "PLAN_BUDGET_USD must be a small number" "$BIN/agent-kit-caps" set PLAN_BUDGET_USD 500
"$BIN/agent-kit-caps" set CHAT_BUDGET_USD 0.5 > /dev/null
check "the chat budget is kept" 'grep -qx "CHAT_BUDGET_USD=0.5" "$T/etc/caps.env" && grep -qx "FREE_TAKE_APPROVED=0" "$T/etc/caps.env"'

# Chat.
M1=20260102T120000Z-c-aaaaaa M2=20260102T120100Z-c-bbbbbb M3=20260102T120200Z-c-cccccc
refuse "a chat about a plan that was replaced" sh -c "echo hi | AGENT_KIT_PATH=$FB:\$PATH $BIN/agent-kit-chat say $PL $M1 owner"
echo "$PL2 2026-01-02T05:00:00+00:00 halt" > "$S/oneshot"
refuse "no chat while this session's own planning cycle runs" sh -c "echo hi | AGENT_KIT_PATH=$FB:\$PATH $BIN/agent-kit-chat say $PL2 $M1 owner"
rm -f "$S/oneshot"
refuse "an empty chat message" sh -c "echo '  ' | AGENT_KIT_PATH=$FB:\$PATH $BIN/agent-kit-chat say $PL2 $M1 owner"
refuse "a chat with a bad message id" sh -c "echo hi | AGENT_KIT_PATH=$FB:\$PATH $BIN/agent-kit-chat say $PL2 'x;id' owner"
: > "$FAKE_LOG"
echo "Make the first one smaller. Code word MICA." | chat say $PL2 $M1 owner > /dev/null
check "a chat message is stored root-side and starts one turn" 'grep -q MICA "$S/backlog/chat/$PL2/$M1.md" && [ -f "$S/chat" ] && grep -qx "start --no-block agent-kit-chat.service" "$FAKE_LOG"'
refuse "a second message while the lead answers" sh -c "echo again | AGENT_KIT_PATH=$FB:\$PATH $BIN/agent-kit-chat say $PL2 $M2 owner"
SID2=$(cat "$S/ledger/plans/$PL2")
prev=$(jq -s --arg s "$SID2" '[.[] | select(.session == $s) | .cost_usd] | add' "$S/ledger/cycles.jsonl")
rm -f "$FAKE_PROMPT"
FAKE_COST=0.8 FAKE_RESULT="Made it smaller" AGENT_KIT_HOME=$K PATH=$FB:$PATH "$BIN/lead-chat" > /dev/null 2>&1
check "the turn resumes the planning session" '[ "$(grep -A1 -x -- --resume "$FAKE_ARGS" | tail -1)" = "$SID2" ] && ! grep -qx -- --session-id "$FAKE_ARGS"'
check "the turn passes the tool limits and the chat budget again" 'grep -qx "Read,Grep,Glob,Bash" "$FAKE_ARGS" && [ "$(grep -A1 -x -- --max-budget-usd "$FAKE_ARGS" | tail -1)" = 0.5 ]'
check "the turn gets the chat notice and the message" 'grep -q "agent-kit owner chat" "$FAKE_PROMPT" && grep -q MICA "$FAKE_PROMPT"'
check "the answer is written for the console" 'grep -qx "Status: ok" "$S/backlog-out/chat/$PL2/$M1.md" && grep -q "Made it smaller" "$S/backlog-out/chat/$PL2/$M1.md"'
L=$(tail -1 "$S/ledger/cycles.jsonl")
check "ledger: a chat line with this turn's cost only, not counted" '[ "$(jq -r .kind <<< "$L")" = chat ] && [ "$(jq -r .counted <<< "$L")" = false ] && [ "$(jq -r ".cost_usd * 100 | round" <<< "$L")" = "$(jq -n "(0.8 - $prev) * 100 | round")" ]'
chat finish
check "finish drops the chat marker" '[ ! -e "$S/chat" ]'
# Kit 0.12: an answer stopped at the chat budget says why (it was empty before).
M5=20260102T125000Z-c-eeeeee
echo "After a long pause." | chat say $PL2 $M5 owner > /dev/null
FAKE_JSON='{"type":"result","subtype":"error_max_budget_usd","is_error":true,"num_turns":1,"total_cost_usd":9.99,"errors":["Reached maximum budget ($3)"]}' \
  AGENT_KIT_HOME=$K PATH=$FB:$PATH "$BIN/lead-chat" > /dev/null 2>&1
check "a stopped answer says it hit the chat budget" 'grep -qx "Status: error" "$S/backlog-out/chat/$PL2/$M5.md" && grep -q "Stopped at the chat budget (\$0.5)" "$S/backlog-out/chat/$PL2/$M5.md" && grep -q "send it again" "$S/backlog-out/chat/$PL2/$M5.md"'
chat finish
# From 0.10.1 a chat turn runs next to a one-shot job, and is told about it.
JX=20260102T130000Z-o-backlogjob
mkdir -p "$T/work/bx"; printf 'Backlog item %s (revision 2), approved by the owner: Save slots\n\nDo it.\n' "$B1" > "$T/work/bx/body.md"
tar -c -C "$T/work/bx" . | shot start $JX owner > /dev/null
M4=20260102T130100Z-c-dddddd
FAKE_ACTIVE=active sh -c "echo 'Is the save work going well? Code word OPAL.' | AGENT_KIT_PATH=$FB:\$PATH $BIN/agent-kit-chat say $PL2 $M4 owner" > /dev/null
check "a chat message is taken while a one-shot job runs" '[ -f "$S/backlog/chat/$PL2/$M4.md" ] && [ -f "$S/chat" ]'
echo "11111111-2222-3333-4444-555555555555 2026-01-02T13:00:00+00:00" > "$S/ledger/current"
rm -f "$FAKE_PROMPT"
AGENT_KIT_HOME=$K PATH=$FB:$PATH "$BIN/lead-chat" > /dev/null 2>&1
check "the chat turn is told which backlog item is running" 'grep -q "one-shot job is running" "$FAKE_PROMPT" && grep -q "$B1" "$FAKE_PROMPT" && grep -q "Save slots" "$FAKE_PROMPT" && grep -q OPAL "$FAKE_PROMPT"'
check "with a cycle running next to it, a chat turn does not claim the workspace" '[ "$(tail -1 "$S/ledger/cycles.jsonl" | jq -r .touched_code)" = null ]'
check "a chat turn does not pose as the cycle's lead session" '! grep -q ZIGGURAT_LEAD_SESSION=  "$BIN/lead-chat" || grep -q "unset ZIGGURAT_LEAD_SESSION" "$BIN/lead-chat"'
rm -f "$S/ledger/current"
chat finish
# Kit 0.21: after a long pause a chat turn starts a new session from the proposals and the chat so far.
check "a chat turn asks for medium effort unless the owner set another" '[ "$(grep -A1 -x -- --effort "$FAKE_ARGS" | tail -1)" = medium ]'
M6=20260102T140000Z-c-ffffff
echo "Back after a break. Code word JADE." | chat say $PL2 $M6 owner > /dev/null
rm -f "$FAKE_PROMPT"
AGENT_KIT_CHAT_FRESH_SECS=-1 FAKE_COST=0.3 FAKE_RESULT="Welcome back" AGENT_KIT_HOME=$K PATH=$FB:$PATH "$BIN/lead-chat" > /dev/null 2>&1
SID3=$(cat "$S/ledger/plans/$PL2")
check "after a long pause the turn starts a new session" '[ "$SID3" != "$SID2" ] && [ "$(grep -A1 -x -- --session-id "$FAKE_ARGS" | tail -1)" = "$SID3" ] && ! grep -qx -- --resume "$FAKE_ARGS"'
check "the new session is told what the old one knew" 'grep -q "no longer" "$FAKE_PROMPT" && grep -q "^## Your proposals" "$FAKE_PROMPT" && grep -q MICA "$FAKE_PROMPT" && grep -q "Made it smaller" "$FAKE_PROMPT"'
check "the new message comes last, once" '[ "$(grep -c JADE "$FAKE_PROMPT")" = 1 ] && [ "$(grep -n JADE "$FAKE_PROMPT" | cut -d: -f1)" -gt "$(grep -n "Made it smaller" "$FAKE_PROMPT" | tail -1 | cut -d: -f1)" ]'
check "it still starts with the chat notice" '[ "$(head -c 22 "$FAKE_PROMPT")" = "[agent-kit owner chat]" ]'
L=$(tail -1 "$S/ledger/cycles.jsonl")
check "ledger: the new session, with its whole cost" '[ "$(jq -r .session <<< "$L")" = "$SID3" ] && [ "$(jq -r ".cost_usd * 100 | round" <<< "$L")" = 30 ] && [ "$(jq -r .plan <<< "$L")" = "$PL2" ]'
check "the answer is written as for any turn" 'grep -q "Welcome back" "$S/backlog-out/chat/$PL2/$M6.md"'
chat finish
"$BIN/agent-kit-caps" set CHAT_EFFORT low > /dev/null
M7=20260102T140100Z-c-abcdef
echo "And one more." | chat say $PL2 $M7 owner > /dev/null
FAKE_COST=0.4 FAKE_RESULT="Sure" AGENT_KIT_HOME=$K PATH=$FB:$PATH "$BIN/lead-chat" > /dev/null 2>&1
check "the next turn resumes the new session" '[ "$(grep -A1 -x -- --resume "$FAKE_ARGS" | tail -1)" = "$SID3" ] && [ "$(cat "$S/ledger/plans/$PL2")" = "$SID3" ]'
check "with the effort the owner set" '[ "$(grep -A1 -x -- --effort "$FAKE_ARGS" | tail -1)" = low ]'
check "ledger: only this turn's cost of the new session" '[ "$(tail -1 "$S/ledger/cycles.jsonl" | jq -r ".cost_usd * 100 | round")" = 10 ]'
chat finish
refuse "CHAT_EFFORT must be a known level" "$BIN/agent-kit-caps" set CHAT_EFFORT tiny
check "the effort is listed with the other settings" '"$BIN/agent-kit-caps" show | grep -qx "CHAT_EFFORT=low"'
shot finish > /dev/null
check "a cycle starts while a chat turn is answering" 'echo "$PL2 $M4 2026-01-02T13:01:00+00:00" > "$S/chat"; echo "run 2026-01-02T13:02:00+00:00" > "$S/control"; : > "$S/ledger/cycles.jsonl"; cycle > /dev/null 2>&1; [ -s "$FAKE_PROMPT" ]'
rm -f "$S/chat"; echo "stop owner 2026-01-02T13:03:00+00:00" > "$S/control"
chat end $PL2 > /dev/null
refuse "no chat after the owner ended it" sh -c "echo hi | AGENT_KIT_PATH=$FB:\$PATH $BIN/agent-kit-chat say $PL2 $M3 owner"
echo "$PL2 $M3 2026-01-01T00:00:00+00:00" > "$S/chat"; touch -d '-10 min' "$S/chat"
chat reap
check "a chat turn that is gone is reaped" '[ ! -e "$S/chat" ]'

# A one-shot job set for a time.
JA=20260103T100000Z-o-atjob JB=20260103T100100Z-o-missed
now=$(date +%s)
refuse "a time in the past" sh -c "tar -c -C $T/work/j . | AGENT_KIT_PATH=$FB:\$PATH $BIN/agent-kit-oneshot at $((now - 60)) $JA owner"
tar -c -C "$T/work/j" . | shot at $((now + 3600)) $JA owner > /dev/null
check "a timed job waits outside the inbox" '[ -f "$S/oneshot-at/$JA" ] && [ ! -e "$S/inbox/$JA" ] && grep -q "$JA" <<< "$(shot list-at)"'
shot due
check "not before its time" '[ -f "$S/oneshot-at/$JA" ] && [ ! -e "$S/oneshot" ]'
echo "$((now - 30)) owner" > "$S/oneshot-at/$JA"
: > "$FAKE_LOG"
shot due
check "at its time it starts as a one-shot job" '[ ! -e "$S/oneshot-at/$JA" ] && grep -q BASALT "$S/inbox/$JA/message.md" && grep -q "^run oneshot $JA " "$S/control" && grep -q "job:$JA .* started" "$S/schedule.log"'
shot finish > /dev/null
tar -c -C "$T/work/j" . | shot at $((now + 3600)) $JB owner > /dev/null
echo "$((now - 2400)) owner" > "$S/oneshot-at/$JB"
FAKE_ACTIVE=active shot due
check "a job waits (up to 4 hours) for a cycle that started at the same time" '[ -f "$S/oneshot-at/$JB" ] && ! grep -q "job:$JB .* missed" "$S/schedule.log"'
echo "$((now - 15000)) owner" > "$S/oneshot-at/$JB"
shot due
check "a job the team was too busy for is dropped and logged" '[ ! -e "$S/oneshot-at/$JB" ] && [ ! -e "$S/inbox/$JB" ] && grep -q "job:$JB .* missed" "$S/schedule.log"'
echo "Plan later." | shot at $((now + 600)) 20260103T110000Z-p-later owner --plan > /dev/null
shot unat 20260103T110000Z-p-later > /dev/null
check "a timed job can be cancelled" '[ ! -e "$S/oneshot-at/20260103T110000Z-p-later" ]'

echo "== jobs that build on each other, and the overrun brake (kit 0.18)"
JD=20260105T100000Z-o-first JE=20260105T100100Z-o-second JF=20260105T100200Z-o-orphan JG=20260105T100300Z-o-free
now=$(date +%s)
rm -f "$S/oneshot" "$S/oneshot.meta" "$S/halt-after"; echo "run 2026-01-05T00:00:00+00:00" > "$S/control"
atjob() { tar -c -C "$T/work/j" . | shot at "$@" > /dev/null; }
for bad in "--minutes 0" "--minutes 1441" "--minutes x" "--after not-a-job" "--after $JE" "--speed fast"; do
  refuse "a timed job with $bad" sh -c "tar -c -C $T/work/j . | AGENT_KIT_PATH=$FB:\$PATH $BIN/agent-kit-oneshot at $((now + 3600)) $JE owner $bad"
done
atjob $((now + 3600)) $JE owner --minutes 30 --after "$JD"
check "a timed job keeps its estimate and what it builds on" 'grep -qx "minutes=30" "$S/oneshot-at/$JE.meta" && grep -qx "after=$JD" "$S/oneshot-at/$JE.meta" && grep -q "^$JE [0-9]* owner - - -$" <<< "$(shot list-at)"'
due_at() { echo "$((now - ${2:-30})) owner" > "$S/oneshot-at/$1"; }
due_at $JE; shot due
check "it does not start when the job it builds on never ran" '[ -f "$S/oneshot-at/$JE" ] && [ ! -e "$S/oneshot" ] && grep -q "^$JE [0-9]* owner failed $JD -$" <<< "$(shot list-at)"'
atjob $((now + 3600)) $JD owner --minutes 20
shot due
check "nor while that job is itself still set for a time" 'grep -q "^pending $JD " "$S/oneshot-at/$JE.wait"'
# A job with nothing to wait for is not held up by one that waits.
atjob $((now + 3600)) $JG owner; due_at $JG
: > "$FAKE_LOG"; shot due
check "a job behind a waiting one starts" 'grep -q "^run oneshot $JG " "$S/control" && [ -f "$S/oneshot-at/$JE" ]'
check "a job without an estimate has no brake" '[ "$(cat "$S/oneshot.meta")" = "id=$JG" ]'
shot finish > /dev/null
shot unat $JD > /dev/null
echo "$JD 2026-01-05T10:00:00+00:00 run" > "$S/oneshot"; shot due
check "nor while that job runs" 'grep -q "^running $JD " "$S/oneshot-at/$JE.wait"'
rm -f "$S/oneshot"
ledger() { jq -nc --arg id "$1" --arg end "$(date -Is -d "${3:-5 minutes ago}")" --argjson o "$2" '{oneshot:$id, kind:"oneshot", rc:0, halted:false, limited:false, is_error:false, end:$end} + $o' >> "$S/ledger/cycles.jsonl"; }
mkdir -p "$S/ledger" "$S/gate/results"; rm -f "$S"/gate/results/*.json "$S/gate/paused"
git -C "$T/ws" for-each-ref --format='%(refname)' refs/heads/ready/ 2> /dev/null | xargs -r -n1 git -C "$T/ws" update-ref -d
ledger $JD '{"halted":true}'; shot due
check "a job that was halted is not built on" 'grep -q "^failed $JD " "$S/oneshot-at/$JE.wait"'
ledger $JD '{"overrun":true,"halted":true}'; shot due
check "nor one the brake stopped" 'grep -q "^failed $JD " "$S/oneshot-at/$JE.wait"'
ledger $JD '{}'
echo $((now - 3600)) > "$S/gate/pass-started"; shot due
check "it ended well, but the gate has not made a pass since: it waits for the merge" 'grep -q "^merge $JD " "$S/oneshot-at/$JE.wait" && [ ! -e "$S/oneshot" ]'
echo "$now" > "$S/gate/pass-started"
git -C "$T/ws" branch ready/from-first 2> /dev/null; shot due
check "a branch the gate has not judged yet: it still waits" 'grep -q "^merge $JD " "$S/oneshot-at/$JE.wait"'
fsha=$(git -C "$T/ws" rev-parse ready/from-first)
jq -nc --arg sha "$fsha" '{topic:"from-first", sha:$sha, status:"held", detail:"changes what done means", at:"x"}' | sed 's/"status":"held"/"status": "held"/' > "$S/gate/results/from-first.json"
shot due
check "a change held for the owner: it waits for the approval" 'grep -q "^held $JD " "$S/oneshot-at/$JE.wait"'
# Hours pass while it waits for the owner: they do not count against the job.
due_at $JE 15000; echo "held $JD $((now - 14900)) 0" > "$S/oneshot-at/$JE.wait"; shot due
check "time spent waiting for the owner does not get it dropped" '[ -f "$S/oneshot-at/$JE" ] && ! grep -q "job:$JE .* missed" "$S/schedule.log" && [ "$(cut -d" " -f4 "$S/oneshot-at/$JE.wait")" -ge 14900 ]'
jq -c '.status = "merged"' "$S/gate/results/from-first.json" > "$S/gate/results/from-first.json.n" && mv "$S/gate/results/from-first.json.n" "$S/gate/results/from-first.json"
: > "$FAKE_LOG"; shot due
check "merged, gate quiet, nothing held: it starts, with its estimate" 'grep -q "^run oneshot $JE " "$S/control" && grep -qx "minutes=30" "$S/oneshot.meta" && grep -qx "id=$JE" "$S/oneshot.meta" && [ ! -e "$S/oneshot-at/$JE.meta" ] && [ ! -e "$S/oneshot-at/$JE.wait" ] && grep -q "job:$JE .* started" "$S/schedule.log"'
atjob $((now + 3600)) $JF owner --after 20260105T090000Z-o-never; due_at $JF 15000; shot due
check "a job whose base never comes is dropped after four hours, with the reason" '[ ! -e "$S/oneshot-at/$JF" ] && [ ! -e "$S/oneshot-at/$JF.meta" ] && grep -q "job:$JF .* missed: the job it builds on (20260105T090000Z-o-never) did not finish" "$S/schedule.log"'

# The brake. $JE runs with an estimate of 30 minutes: wrap up at 45, stop at 60.
running_since() { echo "$JE $(date -Is -d "$1") run" > "$S/oneshot"; }
running_since "40 minutes ago"; : > "$FAKE_LOG"; FAKE_ACTIVE=active shot brake
check "within its estimate and a half: nothing" '[ ! -e "$S/oneshot.wrap" ] && ! grep -q "stop agent-kit-lead.service" "$FAKE_LOG"'
running_since "46 minutes ago"; FAKE_ACTIVE=active shot brake > /dev/null
check "at one and a half times the estimate the lead is to be told" '[ "$(cat "$S/oneshot.wrap")" = "$JE 30 46 60" ] && ! grep -q "stop agent-kit-lead.service" "$FAKE_LOG"'
rm -rf "$S/outbox/.seen"/overrun-*
note=$(hook LEAD null)
check "the lead gets the wrap-up notice once, with the numbers" 'grep -q "\[agent-kit owner notice\] This job has run 46 minutes against an estimate of 30" <<< "$note" && grep -q "At 60 minutes" <<< "$note" && [ -z "$(hook LEAD null)" ]'
check "each agent gets a short one, once" 'grep -q "well past its estimate" <<< "$(hook LEAD \"agentx\")" && [ -z "$(hook LEAD \"agentx\")" ]'
check "nobody outside the lead session gets it" '[ -z "$(hook OTHER null)" ]'
running_since "61 minutes ago"; FAKE_ACTIVE=active shot brake > /dev/null
check "at twice the estimate the cycle is stopped, and it is written down" 'grep -qx "stop agent-kit-lead.service" "$FAKE_LOG" && [ "$(cat "$S/oneshot.overrun")" = "$JE" ] && grep -q "job:$JE .* stopped: it ran 61 minutes against an estimate of 30" "$S/schedule.log"'
# The cycle's own end writes the ledger line and puts the team back.
shot finish > /dev/null
check "ending the job clears what the brake left" '[ ! -e "$S/oneshot.meta" ] && [ ! -e "$S/oneshot.wrap" ] && [ ! -e "$S/oneshot.overrun" ] && grep -q "^run after one-shot job $JE ended" "$S/control"'
# A short job: never told sooner than its estimate plus 10 minutes, never stopped sooner than plus 20.
JS=20260105T110000Z-o-short
tar -c -C "$T/work/j" . | shot start $JS owner --minutes 5 > /dev/null
echo "$JS $(date -Is -d "9 minutes ago") run" > "$S/oneshot"; : > "$FAKE_LOG"; FAKE_ACTIVE=active shot brake
check "a 5 minute job is left alone at 9 minutes" '[ ! -e "$S/oneshot.wrap" ]'
echo "$JS $(date -Is -d "16 minutes ago") run" > "$S/oneshot"; FAKE_ACTIVE=active shot brake > /dev/null
check "told to wrap up at 15" '[ "$(cat "$S/oneshot.wrap")" = "$JS 5 16 25" ] && ! grep -q "stop agent-kit-lead.service" "$FAKE_LOG"'
echo "$JS $(date -Is -d "26 minutes ago") run" > "$S/oneshot"; FAKE_ACTIVE=active shot brake > /dev/null
check "stopped at 25" 'grep -qx "stop agent-kit-lead.service" "$FAKE_LOG"'
shot finish > /dev/null
JN=20260105T120000Z-o-nobrake
tar -c -C "$T/work/j" . | shot start $JN owner --minutes 5 --no-brake > /dev/null
echo "$JN $(date -Is -d "5 hours ago") run" > "$S/oneshot"; : > "$FAKE_LOG"; FAKE_ACTIVE=active shot brake
check "the owner switched the brake off for a job: it runs on" 'grep -qx "brake=off" "$S/oneshot.meta" && [ ! -e "$S/oneshot.wrap" ] && ! grep -q "stop agent-kit-lead.service" "$FAKE_LOG"'
shot finish > /dev/null
# A marker without the kit 0.18 file (a job started by an older kit) is left alone.
echo "$JN $(date -Is -d "5 hours ago") run" > "$S/oneshot"; : > "$FAKE_LOG"; FAKE_ACTIVE=active shot brake
check "a job without an estimate on the VM is never braked" '! grep -q "stop agent-kit-lead.service" "$FAKE_LOG"'
rm -f "$S/oneshot"
# The ledger says which job the brake stopped: nothing may be built on it.
JO=20260105T130000Z-o-ledger
echo "stop owner halt 2026-01-05T05:00:00+00:00" > "$S/control"
tar -c -C "$T/work/j" . | shot start $JO owner --minutes 10 > /dev/null
out=$(cycle 2>&1)
check "a job that ended by itself is not marked as overrun" '[ "$(tail -1 "$S/ledger/cycles.jsonl" | jq -c "[.oneshot, .overrun]")" = "[\"$JO\",false]" ]'
echo "$JO" > "$S/oneshot.overrun"; out=$(cycle 2>&1)
check "a job the brake stopped is" '[ "$(tail -1 "$S/ledger/cycles.jsonl" | jq -c "[.oneshot, .overrun]")" = "[\"$JO\",true]" ]'
shot finish > /dev/null
check "the tick runs the brake" 'grep -q "agent-kit-oneshot brake" "$HERE/../systemd/agent-kit-tick.service"'
git -C "$T/ws" update-ref -d refs/heads/ready/from-first 2> /dev/null; rm -f "$S"/gate/results/from-first.json

echo "== a stalled session, and the brake not counting the wait (kit 0.24)"
stall() { AGENT_KIT_PATH=$FB:$PATH "$BIN/agent-kit-stall"; }
SID=11111111-2222-4333-8444-555555555555
PD=$T/home/.claude/projects/-ws
mkdir -p "$PD/$SID/subagents" "$S/ledger"
rm -f "$S/ledger/current" "$S/chat.keep"; [ -f "$S/chat" ] && mv "$S/chat" "$S/chat.keep"
iso() { date -u -d "$1" +%FT%T.123Z; }
said() { jq -nc --arg t "$(iso "$1")" '{type:"assistant", timestamp:$t, message:{content:"working"}}'; }
limit() { jq -nc --arg t "$(iso "$1")" '{type:"system", subtype:"api_error", level:"error", timestamp:$t, retryInMs:30000, retryAttempt:1,
  error:{status:429, message:"429 rate_limit_error", rateLimits:{rateLimitType:"five_hour", resetsAt:1795422000}}}'; }
overloaded() { jq -nc --arg t "$(iso "$1")" --argjson n "$2" '{type:"system", subtype:"api_error", level:"error", timestamp:$t, retryInMs:9000, retryAttempt:$n,
  error:{status:529, message:"529 overloaded_error", rateLimits:null}}'; }
check "no session in progress: not stalled" '[ "$(stall)" = "{\"stalled\":false}" ]'
echo "$SID $(date -Is -d '2 minutes ago')" > "$S/ledger/current"
check "a session that has written nothing yet, two minutes in: not stalled" '[ "$(stall)" = "{\"stalled\":false}" ]'
echo "$SID $(date -Is -d '40 minutes ago')" > "$S/ledger/current"
check "nothing written forty minutes in: no progress" '[ "$(stall | jq -r "[.reason, .minutes] | join(\" \")")" = "no-progress 40" ]'
echo "$SID $(date -Is -d '30 minutes ago')" > "$S/ledger/current"
{ said '20 minutes ago'; limit '10 minutes ago'; limit '9 minutes ago'; limit '30 seconds ago'; } > "$PD/$SID.jsonl"
out=$(stall)
check "waiting on the usage window: usage limit, with the reset time" '[ "$(jq -r "[.stalled, .reason, .resetsAt, .limit, .session] | join(\" \")" <<< "$out")" = "true usage-limit 1795422000 five_hour $SID" ]'
check "the wait counts from its first line" 'd=$(( $(jq -r .since <<< "$out") - $(date -d "10 minutes ago" +%s) )); [ "${d#-}" -le 3 ]'
said 'now' > "$PD/$SID/subagents/agent-a1.jsonl"; touch -d "@$(($(date +%s) + 5))" "$PD/$SID/subagents/agent-a1.jsonl"
check "a sub-agent that wrote after it: not stalled" '[ "$(stall)" = "{\"stalled\":false}" ]'
rm -f "$PD/$SID/subagents/agent-a1.jsonl"
{ said '5 minutes ago'; overloaded '2 minutes ago' 1; overloaded '1 minute ago' 4; } > "$PD/$SID.jsonl"
check "other API errors: api-error, with the attempt" '[ "$(stall | jq -r "[.reason, .status, .attempt] | join(\" \")")" = "api-error 529 4" ]'
{ said '50 minutes ago'; } > "$PD/$SID.jsonl"; touch -d '45 minutes ago' "$PD/$SID.jsonl"
check "no line for 45 minutes: no progress" '[ "$(stall | jq -r "[.reason, .minutes] | join(\" \")")" = "no-progress 45" ]'
{ limit '41 minutes ago'; } > "$PD/$SID.jsonl"; touch -d '40 minutes ago' "$PD/$SID.jsonl"
check "an old error line is no retry in progress: no progress" '[ "$(stall | jq -r .reason)" = no-progress ]'
said 'now' > "$PD/$SID.jsonl"
check "a session that is writing: not stalled" '[ "$(stall)" = "{\"stalled\":false}" ]'
check "a half-written last line does not break it" 'printf "{\"type\":\"assi" >> "$PD/$SID.jsonl"; [ "$(stall)" = "{\"stalled\":false}" ]'
# The brake: a job with an estimate of 30 minutes (stop at 60) that has run 70,
# 25 of them waiting on the usage window, is not stopped; once it has worked 60 it is.
JW=20260105T140000Z-o-waiting
tar -c -C "$T/work/j" . | shot start $JW owner --minutes 30 > /dev/null
echo "$JW $(date -Is -d '70 minutes ago') halt" > "$S/oneshot"
echo "$JW 1500 $(($(date +%s) - 60))" > "$S/oneshot.stall"
{ limit '25 minutes ago'; limit 'now'; } > "$PD/$SID.jsonl"
: > "$FAKE_LOG"; FAKE_ACTIVE=active shot brake > /dev/null
check "time waiting on the usage window does not count against the estimate" '! grep -q "stop agent-kit-lead.service" "$FAKE_LOG" && w=$(cut -d" " -f2 "$S/oneshot.stall") && [ "$w" -ge 1555 ] && [ "$w" -le 1565 ]'
check "nor is the job told to wrap up yet" '[ ! -e "$S/oneshot.wrap" ]'
said 'now' > "$PD/$SID.jsonl"
echo "$JW 0 $(date +%s)" > "$S/oneshot.stall"
: > "$FAKE_LOG"; FAKE_ACTIVE=active shot brake > /dev/null
check "working time past the stop is stopped as before" 'grep -q "stop agent-kit-lead.service" "$FAKE_LOG"'
echo "$JW 1500 $(date +%s)" > "$S/oneshot.stall"
shot finish > /dev/null
check "the end of the job clears its waiting time" '[ ! -e "$S/oneshot.stall" ]'
rm -f "$S/ledger/current" "$PD/$SID.jsonl"; [ -f "$S/chat.keep" ] && mv "$S/chat.keep" "$S/chat"
echo "stop owner halt 2026-01-05T05:00:00+00:00" > "$S/control"

echo "== a normal cycle started by the owner, no job (kit 0.25)"
cp "$S/ledger/cycles.jsonl" "$T/cycles.free.keep" 2> /dev/null || : > "$T/cycles.free.keep"
: > "$S/ledger/cycles.jsonl"
[ -f "$T/etc/schedule" ] && mv "$T/etc/schedule" "$T/schedule.free.keep"
rm -f "$S/oneshot" "$S/oneshot.meta" "$S/halt-after" "$S/halt-at"
F1=20260106T100000Z-f-run-now
refuse "a cycle with no job needs an -f- id" shot start 20260106T100000Z-o-run-now owner --free
refuse "an -f- id is no job" bash -c "tar -c -C '$T/work/j' . | AGENT_KIT_PATH=$FB:$PATH '$BIN/agent-kit-oneshot' start $F1 owner"
refuse "past the cap is only for a cycle with no job" bash -c "tar -c -C '$T/work/j' . | AGENT_KIT_PATH=$FB:$PATH '$BIN/agent-kit-oneshot' start 20260106T100000Z-o-capjob owner --past-cap"
echo "stop owner halt 2026-01-06T05:00:00+00:00" > "$S/control"
: > "$FAKE_LOG"
out=$(shot start $F1 owner --free < /dev/null)
check "it starts on a halted team, with nothing stored as a job" 'grep -q "cycle $F1 started. The team halts again" <<< "$out" && [ ! -e "$S/inbox/$F1" ] && grep -q "^run oneshot $F1 " "$S/control" && grep -qx "kind=free" "$S/oneshot.meta" && grep -q "start --no-block agent-kit-lead.service" "$FAKE_LOG"'
check "show says what runs" 'grep -q "cycle started by the owner in progress: $F1" <<< "$(shot show)"'
out=$(cycle 2>&1)
check "the lead gets the normal prompt, with a note that the team halts again" 'grep -q "TEAM-CYCLE-TEXT" "$FAKE_PROMPT" && grep -q "started by the owner on a halted team" "$FAKE_PROMPT" && ! grep -q "Read this first\|One-shot job: this cycle only" "$FAKE_PROMPT" && grep -q "^\*\*This is cycle 1\.\*\*" "$FAKE_PROMPT"'
check "the ledger counts it as a normal cycle the owner started" '[ "$(tail -1 "$S/ledger/cycles.jsonl" | jq -c "[.kind, .free, .oneshot, .counted]")" = "[\"normal\",true,\"$F1\",true]" ]'
shot finish > /dev/null
check "then the team is halted again" 'grep -q "^stop one-shot job $F1 ended" "$S/control" && [ ! -e "$S/oneshot" ]'
# On an idle team, with a schedule: no slot is needed, and no halted note.
printf 'tz UTC\nslot daily 03:00\n' > "$T/etc/schedule"
F2=20260106T110000Z-f-run-now
echo "run 2026-01-06T06:00:00+00:00" > "$S/control"
out=$(shot start $F2 owner --free < /dev/null)
check "on a team set to run it runs on afterwards" 'grep -q "The team runs on when it ends" <<< "$out"'
out=$(cycle 2>&1)
check "a schedule does not hold it back, and the lead is not told of a halt" '[ -s "$FAKE_PROMPT" ] && ! grep -q "halted team" "$FAKE_PROMPT" && grep -q "TEAM-CYCLE-TEXT" "$FAKE_PROMPT"'
shot finish > /dev/null
check "then the team runs on" 'grep -q "^run after one-shot job $F2 ended" "$S/control"'
# The daily cap (6 in project.env): refused, unless started past it.
for i in 1 2 3 4; do jq -nc --arg d "$(date +%F)" '{date:$d, counted:true, kind:"normal"}'; done >> "$S/ledger/cycles.jsonl"
F3=20260106T120000Z-f-run-now
out=$(shot start $F3 owner --free < /dev/null 2>&1); rc=$?
check "at the daily cap it is refused, with the count" '[ "$rc" != 0 ] && grep -q "daily cycle cap is reached (6/" <<< "$out" && [ ! -e "$S/oneshot" ] && grep -q "^run after one-shot job $F2" "$S/control"'
out=$(shot start $F3 owner --free --past-cap < /dev/null)
check "past the cap when the owner says so" 'grep -q "cycle $F3 started" <<< "$out" && grep -qx "pastcap=1" "$S/oneshot.meta"'
out=$(cycle 2>&1)
check "and lead-cycle does not stop it at the cap" '[ -s "$FAKE_PROMPT" ] && [ "$(tail -1 "$S/ledger/cycles.jsonl" | jq -r .oneshot)" = "$F3" ]'
shot finish > /dev/null
check "no brake for a cycle with no job" '! grep -q "^minutes=" "$S/oneshot.meta" 2> /dev/null'
# Set for a time: no job on stdin; at the cap it is dropped and logged, not queued.
F4=20260106T130000Z-f-later F5=20260106T130100Z-f-later-past
shot at $(($(date +%s) + 60)) $F4 owner --free < /dev/null > /dev/null
shot at $(($(date +%s) + 60)) $F5 owner --free --past-cap < /dev/null > /dev/null
check "a cycle set for a time keeps an empty job" '[ -f "$S/oneshot-at/$F4" ] && [ ! -s "$S/oneshot-at/$F4.job" ] && grep -q "^$F4 " <<< "$(shot list-at)"'
sed -i "s/^[0-9]* /$(($(date +%s) - 5)) /" "$S/oneshot-at/$F4" "$S/oneshot-at/$F5"
: > "$FAKE_LOG"; shot due
check "at the cap a cycle set for a time is dropped and logged as missed" '[ ! -e "$S/oneshot-at/$F4" ] && grep -q "job:$F4 .* missed: daily cap (7/" "$S/schedule.log"'
check "one set past the cap starts" '[ ! -e "$S/oneshot-at/$F5" ] && grep -q "^run oneshot $F5 " "$S/control" && grep -qx "pastcap=1" "$S/oneshot.meta"'
shot finish > /dev/null
rm -f "$T/etc/schedule"; [ -f "$T/schedule.free.keep" ] && mv "$T/schedule.free.keep" "$T/etc/schedule"
cp "$T/cycles.free.keep" "$S/ledger/cycles.jsonl"
echo "stop owner halt 2026-01-06T05:00:00+00:00" > "$S/control"

echo "== focus mode (kit 0.27)"
foc() { AGENT_KIT_PATH=$FB:$PATH "$BIN/agent-kit-focus" "$@"; }
cp "$S/ledger/cycles.jsonl" "$T/cycles.focus.keep"
[ -f "$T/etc/schedule" ] && mv "$T/etc/schedule" "$T/schedule.focus.keep"
rm -f "$S/oneshot" "$S/oneshot.meta" "$S/halt-after" "$S/focus" "$S/paused" "$S/focus.ended"
mkdir -p "$S/focus-out"
echo "stop owner halt 2026-01-07T05:00:00+00:00" > "$S/control"
refuse "no focus on a halted team" foc set --open --per-day 10
echo "run 2026-01-07T06:00:00+00:00" > "$S/control"
refuse "focus needs one end" foc set --per-day 10
refuse "focus takes one end only" foc set --open --cycles 3 --per-day 10
refuse "focus needs its cycles a day" foc set --open
refuse "an end in the past" foc set --until $(($(date +%s) - 60)) --per-day 10
FAKE_TIMER=disabled refuse "no focus with the lead timer off" foc set --open --per-day 10
out=$(foc set --cycles 2 --per-day 50)
check "focus is set, with what it is" 'grep -q "focus on" <<< "$out" && [ "$(foc show | jq -c "[.focus.cycles, .focus.perDay, .focus.done, .focus.until]")" = "[2,50,0,null]" ]'
# A schedule is set aside, and the focus's own cycles a day replace the cap.
printf 'tz UTC\nslot daily 03:00\n' > "$T/etc/schedule"
for i in 1 2 3 4 5 6 7; do jq -nc --arg d "$(date +%F)" '{date:$d, counted:true, kind:"normal"}'; done >> "$S/ledger/cycles.jsonl"
out=$(cycle 2>&1)
check "in focus a cycle runs without a slot and past the usual cap" '[ -s "$FAKE_PROMPT" ] && [ "$(tail -1 "$S/ledger/cycles.jsonl" | jq -r .focus_since)" = "$(foc show | jq -r .focus.since)" ]'
check "the lead is told about focus and how to say it is blocked" 'grep -q "^## Focus" "$FAKE_PROMPT" && grep -q "owner-focus blocked" "$FAKE_PROMPT"'
check "a focus cycle says whether it changed only notes" '[ "$(tail -1 "$S/ledger/cycles.jsonl" | jq -r .notes_only)" = true ]'
: > "$FAKE_LOG"; tick_at "$(TZ=UTC date -d "$(TZ=UTC date +%F) 03:00" +%s)" 2> /dev/null
check "the schedule's slot is skipped while in focus" 'grep -q "skipped: in focus" "$S/schedule.log"'
out=$(cycle 2>&1); foc check
check "after its cycles the focus ends by itself, with the reason" '[ ! -e "$S/focus" ] && [ "$(foc show | jq -r .ended.reason)" = "it ran its 2 cycles" ] && grep -q "focus .* ended: it ran its 2 cycles" "$S/schedule.log"'
out=$(cycle 2>&1)
check "then the schedule holds again" 'grep -q "waiting for the next slot" <<< "$out"'
# Blocked on the owner: the lead says so.
foc set --open --per-day 50 > /dev/null
check "owner-focus blocked needs a reason" '! "$BIN/owner-focus" blocked > /dev/null 2>&1'
out=$("$BIN/owner-focus" blocked "waiting for the owner to test on the device")
foc check
check "the lead saying it is blocked ends the focus" '[ ! -e "$S/focus" ] && grep -q "blocked on the owner: waiting for the owner to test on the device" <<< "$(foc show | jq -r .ended.reason)" && [ ! -e "$S/focus-out/blocked" ]'
check "owner-focus says nothing when no focus is on" '[ -z "$("$BIN/owner-focus" prompt)" ] && ! "$BIN/owner-focus" blocked "x" > /dev/null 2>&1'
# Blocked on the owner: two cycles in a row that changed only notes.
foc set --open --per-day 50 > /dev/null
out=$(cycle 2>&1); foc check
check "one cycle with only notes is not enough" '[ -e "$S/focus" ]'
out=$(cycle 2>&1); foc check
check "two in a row end the focus" '[ ! -e "$S/focus" ] && grep -q "two cycles in a row changed only" <<< "$(foc show | jq -r .ended.reason)"'
foc set --until $(($(date +%s) + 120)) --per-day 50 > /dev/null
AGENT_KIT_NOW=$(($(date +%s) + 200)) foc check
check "a focus ends at its time" '[ ! -e "$S/focus" ] && [ "$(foc show | jq -r .ended.reason)" = "its time has come" ]'
foc set --open --per-day 50 > /dev/null
foc clear owner > /dev/null
check "switched off" '[ ! -e "$S/focus" ] && [ "$(foc show | jq -r .ended.reason)" = "switched off: owner" ]'
# Planned jobs go first (kit 0.28).
rm -rf "$S/oneshot-at"; rm -f "$S/focus.hold"
foc set --open --per-day 50 > /dev/null
foc check
check "no planned job: no hold" '[ ! -e "$S/focus.hold" ] && [ "$(foc show | jq -c .hold)" = null ]'
JH=20260108T100000Z-o-soon
tar -c -C "$T/work/j" . | shot at $(($(date +%s) + 600)) $JH owner > /dev/null
foc check
check "a planned job due within a cycle's length holds the focus" '[ "$(cut -d" " -f1 "$S/focus.hold")" = "$JH" ] && [ "$(foc show | jq -r .hold.id)" = "$JH" ] && grep -q "waiting for planned job $JH" "$S/schedule.log"'
foc check
check "it is logged once" '[ "$(grep -c "waiting for planned job $JH" "$S/schedule.log")" = 1 ]'
out=$(cycle 2>&1)
check "no focus cycle starts in its way, and nothing is counted" 'grep -q "holding for planned job $JH" <<< "$out" && [ ! -e "$FAKE_PROMPT" ]'
FH=20260108T100100Z-f-owner
shot start $FH owner --free --past-cap < /dev/null > /dev/null; out=$(cycle 2>&1)
check "a cycle the owner starts is not held" '[ -s "$FAKE_PROMPT" ]'
shot finish > /dev/null
touch -d "10 minutes ago" "$S/focus.hold"; out=$(cycle 2>&1)
check "a stale hold is ignored" '[ -s "$FAKE_PROMPT" ]'
shot unat $JH > /dev/null
# Those two cycles changed only notes, which ends a focus: a new one for the rest.
foc clear > /dev/null; foc set --open --per-day 50 > /dev/null
JL=20260108T110000Z-o-later JX=20260108T110100Z-o-builds
tar -c -C "$T/work/j" . | shot at $(($(date +%s) + 5 * 3600)) $JL owner > /dev/null
tar -c -C "$T/work/j" . | shot at $(($(date +%s) + 600)) $JX owner --after $JL > /dev/null
foc check
check "a job hours away, or one that builds on a job not done yet, does not hold" '[ -e "$S/focus" ] && [ ! -e "$S/focus.hold" ]'
shot unat $JX > /dev/null
JB=20260108T120000Z-o-late
tar -c -C "$T/work/j" . | shot at $(($(date +%s) + 60)) $JB owner > /dev/null
sed -i "s/^[0-9]* /$(($(date +%s) - 120)) /" "$S/oneshot-at/$JB"; printf 'busy - %s 0\n' "$(date +%s)" > "$S/oneshot-at/$JB.wait"
foc check
check "a job whose time has come and that waits for the team holds" '[ "$(cut -d" " -f1 "$S/focus.hold")" = "$JB" ]'
printf 'merge %s %s 0\n' "$JL" "$(date +%s)" > "$S/oneshot-at/$JB.wait"; foc check
check "not one held back by the job it builds on" '[ ! -e "$S/focus.hold" ]'
printf 'busy - %s 0\n' "$(date +%s)" > "$S/oneshot-at/$JB.wait"; foc check
foc clear > /dev/null
check "the end of the focus ends the hold" '[ ! -e "$S/focus.hold" ]'
foc check
check "without focus there is no hold" '[ ! -e "$S/focus.hold" ]'
rm -rf "$S/oneshot-at"

# Paused for another team's focus.
refuse "a pause needs whose focus" foc pause --open
foc pause --open --for nocturne > /dev/null
check "an open pause ends after seven days at most" 'u=$(foc show | jq -r .paused.until); [ "$u" -le $(($(date +%s) + 7 * 86400)) ] && [ "$u" -ge $(($(date +%s) + 7 * 86400 - 5)) ]'
refuse "a paused team cannot be put in focus" foc set --open --per-day 10
rm -f "$S/schedule.used"; : > "$S/schedule.log"
out=$(cycle 2>&1)
check "a paused team starts no cycle from its timer" 'grep -q "paused for focus on nocturne: not running" <<< "$out"'
tick_at "$(TZ=UTC date -d "$(TZ=UTC date +%F) 03:00" +%s)" 2> /dev/null
check "nor from its schedule, and says why" 'grep -q "skipped: paused for focus on nocturne" "$S/schedule.log"'
F9=20260107T100000Z-f-in-pause
shot start $F9 owner --free --past-cap < /dev/null > /dev/null; out=$(cycle 2>&1)
check "a cycle the owner starts still runs on a paused team" '[ -s "$FAKE_PROMPT" ] && [ "$(tail -1 "$S/ledger/cycles.jsonl" | jq -r .oneshot)" = "$F9" ]'
shot finish > /dev/null
AGENT_KIT_NOW=$(($(date +%s) + 8 * 86400)) foc check
check "the pause ends by itself" '[ ! -e "$S/paused" ]'
foc pause --open --for nocturne > /dev/null; foc unpause > /dev/null
check "or when the console ends it" '[ ! -e "$S/paused" ]'
check "the tick checks focus every minute" 'grep -q "agent-kit-focus check" "$HERE/../systemd/agent-kit-tick.service"'
rm -f "$T/etc/schedule" "$S/focus.ended"; [ -f "$T/schedule.focus.keep" ] && mv "$T/schedule.focus.keep" "$T/etc/schedule"
cp "$T/cycles.focus.keep" "$S/ledger/cycles.jsonl"
echo "stop owner halt 2026-01-07T05:00:00+00:00" > "$S/control"

echo "== the owner's cap on proposals (kit 0.15)"
PL3=20260104T100000Z-p-capped
printf 'Max-proposals: 2\nRead docs/ and propose the first jobs.\n' | akb plan $PL3 owner > /dev/null
check "the cap is a header, not part of the focus" 'grep -qx "Max-proposals: 2" <<< "$(sed -n "1,/^---$/p" "$S/backlog/plans/$PL3/request.md")" && [ "$(sed "1,/^---$/d" "$S/backlog/plans/$PL3/request.md")" = "Read docs/ and propose the first jobs." ]'
check "the planning rules name the cap" 'grep -q "At most 2 proposals" <<< "$(ob plan $PL3)" && grep -q "Read docs/" <<< "$(ob plan $PL3)"'
echo "Why: a. Steps: 1." | prop > /dev/null; echo "Why: b. Steps: 1." | prop > /dev/null
refuse "a proposal over the owner's cap" sh -c "echo 'Why: c.' | $BIN/owner-backlog propose --title C --minutes 30 --cost 1 --confidence low"
check "without a cap the usual range" 'grep -q "Three to eight proposals" <<< "$(ob plan $PL)"'
# How the estimates held up: only with three or more finished jobs that had one.
cp "$S/ledger/cycles.jsonl" "$T/cycles.keep"
for r in 600:10 1800:10 1200:10 9000:10; do jq -nc --argjson s "${r%%:*}" --argjson e "${r##*:}" '{start:"2026-01-01T00:00:00+00:00", kind:"oneshot", secs:$s, est_min:$e, halted:($s == 9000)}'; done > "$S/ledger/cycles.jsonl"
check "the lead is told how its estimates held up" 'grep -q "The last 3 jobs with an estimate ran 2 times their estimate" <<< "$(ob plan $PL)"'
cp "$T/cycles.keep" "$S/ledger/cycles.jsonl"
check "nothing is said about estimates without enough jobs" '! grep -q "times their estimate" <<< "$(ob plan $PL)"'
printf 'Max-proposals: 9\nNine is too many.\n' | akb plan 20260104T110000Z-p-nine owner > /dev/null
check "a cap out of range stays in the focus text and caps nothing" '! grep -q "^Max-proposals" <<< "$(sed -n "1,/^---$/p" "$S/backlog/plans/20260104T110000Z-p-nine/request.md")"'
printf 'Max-proposals: 3' | akb plan 20260104T120000Z-p-only owner > /dev/null
check "a cap with no focus leaves the focus empty" 'grep -qx "Max-proposals: 3" "$S/backlog/plans/20260104T120000Z-p-only/request.md" && [ -z "$(sed "1,/^---$/d" "$S/backlog/plans/20260104T120000Z-p-only/request.md")" ]'

echo "== package requests (kit 0.16)"
mkdir -p "$T/opt/recipes"; cp "$HERE"/../recipes/*.sh "$T/opt/recipes/"
cat > "$T/opt/recipes/hello.sh" <<'EOF'
#!/bin/bash
# Domains: example.org
# Version: required (any)
# A test recipe: writes its version.
set -euo pipefail
echo "hello $1" > "$HELLO_OUT"
EOF
cat > "$FB/apt-get" <<'EOF'
#!/bin/bash
echo "apt-get $* proxy=$https_proxy" >> "$APT_LOG"
[ -z "${APT_FAIL:-}" ] || { echo "E: Unable to locate package"; exit 100; }
EOF
chmod 755 "$FB/apt-get"
export APT_LOG=$T/apt.log HELLO_OUT=$T/hello.out
op() { "$BIN/owner-packages" "$@"; }
kp() { AGENT_KIT_PATH=$FB:$PATH "$BIN/agent-kit-packages" "$@"; }
rid_of() { grep -o '[0-9]\{8\}T[0-9]\{6\}Z-k-[a-f0-9]\{6\}' <<< "$1" | head -1; }
rm -f "$S/oneshot"; : > "$APT_LOG"
echo "AGENT_PROXY_URL=http://10.66.0.1:3128" >> "$T/etc/project.env"
refuse "an apt name with shell text" sh -c "echo why | $BIN/owner-packages request 'apt:libsdl2;id'"
refuse "a recipe that does not exist" sh -c "echo why | $BIN/owner-packages request recipe:nope"
refuse "a recipe that needs a version, without one" sh -c "echo why | $BIN/owner-packages request recipe:hello"
refuse "a request without a reason" sh -c "$BIN/owner-packages request apt:libsdl2-dev < /dev/null"
refuse "something that is not a package, recipe or domain" sh -c "echo why | $BIN/owner-packages request pip:requests"
R1=$(rid_of "$(echo "The renderer needs SDL2 headers." | op request apt:libsdl2-dev)")
R2=$(rid_of "$(echo "Python packages come from PyPI." | op request domain:pypi.org)")
R3=$(rid_of "$(echo "Screenshots in the emulator." | op request recipe:hello@1.2.3)")
R4=$(rid_of "$(echo "A typo." | op request apt:libfoo-dev)")
check "requests are stored for the owner" '[ -f "$S/packages-out/$R1.md" ] && grep -q "^Request: apt:libsdl2-dev$" "$S/packages-out/$R1.md" && [ -n "$R2" ] && [ -n "$R3" ]'
refuse "the same request twice" sh -c "echo again | $BIN/owner-packages request apt:libsdl2-dev"
check "the lead sees them waiting" '[ "$(op list | grep -c " waiting ")" = 4 ] && grep -q "^## System packages and domains" <<< "$(op prompt)"'
check "recipes are listed with their domains" 'grep -q "hello  version: required (any)  domains: example.org" <<< "$(op recipes)" && grep -q "playwright-browsers" <<< "$(op recipes)"'
check "status: every request, no decision yet" '[ "$(kp status | jq -r "select(.rid == \"$R1\") | .decision")" = null ]'
kp approve "$R1" > /dev/null; kp approve "$R2" > /dev/null; kp approve "$R3" > /dev/null; kp deny "$R4" > /dev/null
refuse "a second decision" kp approve "$R1"
refuse "a request that does not exist" kp approve 20260101T000000Z-k-abcdef
check "the decision keeps the request as approved" 'grep -q "^approved .* apt:libsdl2-dev$" "$S/packages/.owner/$R1" && grep -q "^denied " "$S/packages/.owner/$R4"'
# The agent rewrites its request after the approval: the approved one is what gets installed.
sed -i 's/^Request: apt:libsdl2-dev$/Request: apt:something-else/' "$S/packages-out/$R1.md"
FAKE_ACTIVE=active kp due
check "nothing is installed while a cycle runs" '[ ! -s "$APT_LOG" ] && [ ! -e "$S/packages/results/$R1" ]'
touch "$S/oneshot"; kp due; rm -f "$S/oneshot"
check "nor when a one-shot job is about to start" '[ ! -s "$APT_LOG" ]'
kp due
check "between cycles: the approved package, through the proxy, one per tick" 'grep -q "install -y -q --no-install-recommends libsdl2-dev proxy=http://10.66.0.1:3128" "$APT_LOG" && ! grep -q something-else "$APT_LOG" && grep -q "^ok " "$S/packages/results/$R1" && [ ! -e "$S/packages/results/$R2" ]'
kp due; kp due
check "a domain needs no install; a recipe gets its version" 'grep -q "^ok " "$S/packages/results/$R2" && grep -q "^ok " "$S/packages/results/$R3" && [ "$(cat "$HELLO_OUT")" = "hello 1.2.3" ]'
check "a declined request is never installed" '[ ! -e "$S/packages/results/$R4" ] && grep -q "$R4  declined" <<< "$(op list)"'
R5=$(rid_of "$(echo "Another one." | op request apt:libbar-dev)")
kp approve "$R5" > /dev/null
APT_FAIL=1 kp due
check "a failed install is recorded, and the lead sees the end of its log" 'grep -q "^failed " "$S/packages/results/$R5" && grep -q "$R5 failed" <<< "$(op prompt)" && grep -q "Unable to locate" <<< "$(op prompt)"'
check "the status shows results" '[ "$(kp status | jq -r "select(.rid == \"$R1\") | .result")" = ok ] && [ "$(kp status | jq -r "select(.rid == \"$R1\") | .request")" = apt:libsdl2-dev ]'

echo "== files the console fetches for a recipe (kit 0.17)"
cat > "$T/opt/recipes/fetchy.sh" <<'EOF'
#!/bin/bash
# Domains: example.org
# Fetch: files.example.org cdn.example.org/builds/
# Version: required (any)
# A test recipe whose files the console brings.
set -euo pipefail
case "$1" in
  needs) [ -z "${NEEDS_FAIL:-}" ] || exit 3; printf '%s\n' "${NEEDS_OUT:-https://files.example.org/a/tool-$2.zip tool.zip
https://cdn.example.org/builds/$2/lib.zip builds/lib.zip}" ;;
  install) cat "$AGENT_KIT_FILES/tool.zip" "$AGENT_KIT_FILES/builds/lib.zip" > "$HELLO_OUT"; echo "installed $2 proxy=$https_proxy" ;;
esac
EOF
# The console's side: a tar with the files and their checksums.
drop() { # dir -> tar on stdout
  (cd "$1" && find . -type f ! -name SHA256SUMS -printf '%P\n' | LC_ALL=C sort | xargs -r sha256sum > SHA256SUMS && tar -c --owner=0 --group=0 .)
}
mkdir -p "$T/drop/builds"; echo TOOL > "$T/drop/tool.zip"; echo LIB > "$T/drop/builds/lib.zip"
F1=$(rid_of "$(echo "The emulator needs it." | op request recipe:fetchy@2.0)")
kp approve "$F1" > /dev/null
refuse "files for a request that is not waiting for any" sh -c "tar -c -C $T/drop . | AGENT_KIT_PATH=$FB:$PATH $BIN/agent-kit-packages files $F1"
: > "$HELLO_OUT"; kp due
check "first the recipe says which files it needs; nothing is installed yet" 'grep -q "^fetching " "$S/packages/results/$F1" && [ "$(cat "$S/packages/needs/$F1")" = "https://files.example.org/a/tool-2.0.zip tool.zip
https://cdn.example.org/builds/2.0/lib.zip builds/lib.zip" ] && [ ! -s "$HELLO_OUT" ]'
check "the status carries what a fetching request waits for" '[ "$(kp status | jq -c "select(.rid == \"$F1\") | [.result, .ready, (.needs | length), .needs[1].name]")" = "[\"fetching\",false,2,\"builds/lib.zip\"]" ]'
check "the lead sees it as installing" 'grep -q "$F1  installing" <<< "$(op list)"'
kp due
check "it waits for the console: no install without the files" 'grep -q "^fetching " "$S/packages/results/$F1" && [ ! -s "$HELLO_OUT" ]'
# A later request is not held up by one that waits for files.
R6=$(rid_of "$(echo "Unrelated." | op request apt:libbaz-dev)"); kp approve "$R6" > /dev/null; kp due
check "a request behind it is installed meanwhile" 'grep -q "^ok " "$S/packages/results/$R6"'
mkdir -p "$T/bad"; cp -r "$T/drop/." "$T/bad/"; echo EXTRA > "$T/bad/extra.sh"
refuse "an archive with a file nobody asked for" sh -c "$(declare -f drop); drop $T/bad | AGENT_KIT_PATH=$FB:$PATH $BIN/agent-kit-packages files $F1"
rm "$T/bad/extra.sh" "$T/bad/builds/lib.zip"
refuse "an archive with a file missing" sh -c "$(declare -f drop); drop $T/bad | AGENT_KIT_PATH=$FB:$PATH $BIN/agent-kit-packages files $F1"
rm -rf "$T/bad"; cp -r "$T/drop" "$T/bad"; (cd "$T/bad" && sha256sum tool.zip builds/lib.zip > SHA256SUMS && echo CHANGED > tool.zip)
refuse "a file that does not match its checksum" sh -c "tar -c -C $T/bad . | AGENT_KIT_PATH=$FB:$PATH $BIN/agent-kit-packages files $F1"
rm -rf "$T/bad"; cp -r "$T/drop" "$T/bad"; rm "$T/bad/tool.zip"; ln -s /etc/passwd "$T/bad/tool.zip"; (cd "$T/bad" && echo "$(sha256sum < /etc/passwd | cut -d' ' -f1)  tool.zip" > SHA256SUMS && sha256sum builds/lib.zip >> SHA256SUMS)
refuse "an archive with a link" sh -c "tar -c -C $T/bad . | AGENT_KIT_PATH=$FB:$PATH $BIN/agent-kit-packages files $F1"
rm -rf "$T/bad"; cp -r "$T/drop" "$T/bad"; ln "$T/bad/tool.zip" "$T/bad/builds/lib.zip.2"; rm "$T/bad/builds/lib.zip"; mv "$T/bad/builds/lib.zip.2" "$T/bad/builds/lib.zip"; (cd "$T/bad" && sha256sum tool.zip builds/lib.zip > SHA256SUMS)
refuse "an archive with a hard link" sh -c "tar -c -C $T/bad . | AGENT_KIT_PATH=$FB:$PATH $BIN/agent-kit-packages files $F1"
check "a refused archive leaves nothing behind" '[ ! -e "$S/packages/files/$F1" ] && [ -z "$(ls -A "$S/packages/files")" ]'
drop "$T/drop" | kp files "$F1" > /dev/null
check "the files are taken, root-owned and checked" '[ -e "$S/packages/files/$F1/.ready" ] && [ "$(cat "$S/packages/files/$F1/builds/lib.zip")" = LIB ] && [ "$(kp status | jq -r "select(.rid == \"$F1\") | .ready")" = true ]'
refuse "the files a second time" sh -c "$(declare -f drop); drop $T/drop | AGENT_KIT_PATH=$FB:$PATH $BIN/agent-kit-packages files $F1"
FAKE_ACTIVE=active kp due
check "the install still waits for the cycle to end" 'grep -q "^fetching " "$S/packages/results/$F1"'
kp due
check "then the recipe installs from the folder, and the folder is cleared" 'grep -q "^ok " "$S/packages/results/$F1" && [ "$(cat "$HELLO_OUT")" = "TOOL
LIB" ] && grep -q "installed 2.0 proxy=http://10.66.0.1:3128" "$S/packages/logs/$F1.log" && [ ! -e "$S/packages/files/$F1" ]'
# What a recipe may ask for.
nbad=0
for bad in "http://files.example.org/x.zip x.zip" "https://files.example.org/x.zip ../x.zip" "https://files.example.org/x.zip /etc/x" "https://files.example.org/x.zip .hidden" "https://user@files.example.org/x.zip x.zip" "https://files.example.org/x.zip a b"; do
  Fb=$(rid_of "$(echo "why" | op request "recipe:fetchy@9.$((++nbad))")"); kp approve "$Fb" > /dev/null
  NEEDS_OUT=$bad kp due
  check "a recipe may not ask for: $bad" 'grep -q "^failed " "$S/packages/results/$Fb" && [ ! -e "$S/packages/needs/$Fb" ]'
done
F2=$(rid_of "$(echo "why" | op request recipe:fetchy@3.0)"); kp approve "$F2" > /dev/null
NEEDS_FAIL=1 kp due
check "a recipe that cannot say what it needs fails" 'grep -q "^failed " "$S/packages/results/$F2" && [ "$(kp status | jq -r "select(.rid == \"$F2\") | .log" | grep -c "could not say")" = 1 ]'
refuse "a retry of a request that was installed" kp retry "$F1"
refuse "a retry of a request that was declined" kp retry "$R4"
kp retry "$F2" > /dev/null; kp due
check "a failed request is tried again from the start" 'grep -q "^fetching " "$S/packages/results/$F2" && [ -f "$S/packages/needs/$F2" ]'
echo "the address storage.example.org is not on the recipe's list" | kp fetch-failed "$F2" > /dev/null
check "the console can say it could not bring the files" 'grep -q "^failed " "$S/packages/results/$F2" && grep -q "not on the recipe" <<< "$(kp status | jq -r "select(.rid == \"$F2\") | .log")" && grep -q "$F2 failed" <<< "$(op prompt)"'
refuse "fetch-failed for a request that is not fetching" sh -c "echo x | AGENT_KIT_PATH=$FB:$PATH $BIN/agent-kit-packages fetch-failed $F1"
check "the Playwright recipe has the console fetch its browsers, and asks the proxy for npm only" 'grep -q "^# Fetch: .*storage.googleapis.com/chrome-for-testing-public/" "$HERE/../recipes/playwright-browsers.sh" && grep -qx "# Domains: registry.npmjs.org" "$HERE/../recipes/playwright-browsers.sh"'
check "the tick starts installs in their own unit" 'grep -q "systemctl start --no-block agent-kit-packages.service" "$HERE/../systemd/agent-kit-tick.service" && grep -q "env -i" "$HERE/../systemd/agent-kit-packages.service"'
sed -i '/AGENT_PROXY_URL/d' "$T/etc/project.env"

check "lead-settings.json is a JSON object" 'jq -e "type == \"object\"" "$HERE/../lead-settings.json" > /dev/null'

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
