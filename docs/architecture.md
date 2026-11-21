# Architecture

## Inside one sandbox VM

| Path | Owner | Purpose |
|---|---|---|
| `/opt/agent-kit/CHARTER.md`, `GATE-CONTRACT.md`, `lead-cycle.md` | root (read-only) | the goal and boundaries, the gate rules, the lead's per-cycle prompt |
| `/opt/agent-kit/gate/` | root | `gate-run` (orchestrator) and the project's `gate-checks` |
| `/srv/<project>.git` | `gatekeeper` | canonical repo; `main` moves only through the gate |
| `/home/agent/<project>` | `agent` | workspace; `.claude/agents/` = the team; `docs/agents/` = notes |
| `/var/lib/agent-kit/control` | root | `run` / `stop` kill switch |
| `/var/lib/agent-kit/ledger/cycles.jsonl` | `agent` | one line per lead cycle (cost estimate, turns, summary) |
| `/var/lib/agent-kit/gate/` | root | verdicts, logs, screenshots |

Three users keep the agents away from the definition of done:

- `agent` runs Claude Code (no sudo).
- `gatekeeper` owns the canonical repo and does all gate git operations. It never runs agent-written code.
- `gaterun` runs candidate code during checks and owns nothing that matters.

## A cycle

1. `agent-kit-lead.timer` starts `lead-cycle` 15 minutes after the previous cycle ended (and only if `control` says `run` and the daily cap allows). A project with a schedule starts its cycles at set times instead: see "Cycle slots" below.
2. The lead (a fresh headless session) reads the charter, the gate contract, `STATE.md`, the journal tail and `gate-status`.
3. It picks 1–3 goals and spawns one **area lead** per goal, choosing Opus for real engineering and Sonnet for small goals.
4. Each area lead works in its own git worktree: plans steps, spawns **builders** (Sonnet) per step and **scouts** (Haiku) for searches and test runs, reviews each builder's diff and commits it, runs the final checks, reports.
5. The lead reviews lightly (report, commit list, diff stat, a spot-check). Risky branches (core rules, save formats, tests, very large diffs) also get an independent **reviewer** in a fresh context.
6. Good branches become `ready/<topic>`. The lead updates `STATE.md` and the journal, submits them the same way, and ends.
7. `agent-kit-gate.timer` (every 2 minutes) fetches `ready/*`, tests each candidate on a fresh checkout as `gaterun`, and fast-forwards `main` only if all checks pass and the test count did not drop. Stacked branches merge together.

Headless rule: a cycle ends when the lead's final message is sent and **everything still running is killed**, so every subagent runs in the foreground.

## Limits and budgets

- `CLAUDE_CODE_RETRY_WATCHDOG=1` lets a cycle wait out a usage-limit reset. Attempts that hit a limit are logged `limited` and do not count toward `MAX_CYCLES_PER_DAY`, so the team resumes on its own after a reset.
- `--max-budget-usd` per cycle is a runaway brake on Claude Code's API-equivalent estimate (not a bill).
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` backs up the foreground rule.

## Network

One isolated bridge with no uplink and no host address. The VMs on it have no default route. A small gateway container sits on both networks and runs squid with a domain allow-list; it does not forward packets and its SSH listens on the LAN side only. See [sandbox/proxmox/README.md](../sandbox/proxmox/README.md).

The console can run in a container of its own on the LAN side (`create-console-ct.yml`). It is not on the
isolated bridge: it reaches the VMs by ssh through the gateway, like a workstation does, and its firewall
accepts connections only from the addresses the owner lists. No VM can reach it; `agent-wall-check` proves
that from inside a VM.

## Getting data out

The owner's side pulls; the VM never pushes and holds no credentials for anything else (publishing to a
remote repository is also done by the console: see below). The
[console](../console/README.md) copies transcripts, the ledger, gate history, notes and screenshots every 15
minutes (and the cycle in progress every 15 seconds while someone is watching it), append-only and without
following symlinks. Agent-owned folders are read as the `agent` user, so a path an agent swapped for a link
cannot make a root process read something else.

## Publishing to a remote repository

A project can have a remote git repository (GitHub, Gitea, GitLab: anything that takes a per-repository deploy
key over ssh). The remote is a one-way mirror of the gate's `main`, with the same commits. The VM still holds
no credentials and still cannot reach the forge: the console publishes, from outside.

| Path | Owner | Purpose |
|---|---|---|
| `/var/lib/agent-kit/publish/enabled` | root | The remote's address, once the owner has verified it. While it exists the lead is told about publishing each cycle |
| `/var/lib/agent-kit/publish/last`, `blocked` | root | What was published last; why the last attempt was refused |
| `/var/lib/agent-kit/publish-out/request.md` | `agent` | The lead's request: `Publish: yes` or `no`, a date and a short summary |
| `DATA_DIR/publish/<project>/key`, `key.pub` | console | The project's deploy key. It is made on the console and never leaves it; only the public half is shown |
| `DATA_DIR/publish/<project>/mirror.git` | console | A bare copy of `main`, what the checks run on and what is pushed from |

1. The lead ends a cycle with `owner-publish request` (a summary on stdin). All agents share one Unix user, so
   a key "only the lead can use" cannot exist inside the VM; the request is all the lead needs.
2. The console pulls the note with the cycle's other files. From then on it asks `agent-kit-publish status` once
   a minute and waits until no cycle runs, the gate is idle and every submitted branch has its verdict.
3. `agent-kit-publish bundle` writes a git bundle of `refs/heads/main` to stdout, as `gatekeeper`: only `main`,
   never a candidate branch. A bundle carries commits and nothing else: no hooks, no config.
4. The console fetches the bundle into its mirror with object checks on, then checks what the remote does not
   have yet:
   - the remote's `main` must be an ancestor of the new one. There is no forced push anywhere in the console;
   - no secrets: `gitleaks` over the new commits, and an exact match against the stored Claude token;
   - no CI files (`.github/workflows/`, `.gitea/workflows/`, `.forgejo/workflows/`, `.gitlab-ci.yml`,
     `azure-pipelines.yml`, `.circleci/`): an agent must not be able to make a forge run code.
   Without the scanner nothing is published.
5. It pushes that one commit to `refs/heads/main` with the project's key only, to a host whose key the owner
   confirmed once by its fingerprint, ignoring any ssh config.
6. It records the result (`agent-kit-publish record` or `blocked`), so the lead reads next cycle what is
   public, or why the publish was refused. A refused publish pushes nothing.

"Publish now" on the Controls tab does the same on the owner's word, without the lead's request. It still
waits for a gate pass in progress and it skips no check.

Nothing comes back: the console never fetches from the remote into a VM, so a pull request or a comment on the
forge cannot reach the agents. Protect `main` on the remote so that only the deploy key can push, and turn off
what the project does not use there (issues, wiki, CI).

## Talking to the lead

| Path | Owner | Purpose |
|---|---|---|
| `/var/lib/agent-kit/inbox/<id>/message.md`, `att/` | root | Messages from the owner. Agents cannot write here, which is what makes a message genuine |
| `/var/lib/agent-kit/inbox/.inject/<id>` | root | Marks a `priority` or `urgent` message for delivery mid-cycle |
| `/var/lib/agent-kit/outbox/<id>.md`, `<id>.d/` | `agent` | The lead's reply (`Status: done`, `planned` or `declined`) and its attachments |
| `/var/lib/agent-kit/outbox/<stamp>-a-<slug>.md` | `agent` | A question from the lead, with the default it takes if unanswered |

- `agent-kit-inbox put` (root, called by the console) checks a message before it becomes visible: id, tier,
  file names and sizes, plain files only.
- Every cycle, `lead-cycle` appends the output of `owner-inbox prompt` to the lead's prompt: the protocol and
  all open messages. Team bundles need no change, and the wording works for every theme.
- Mid-cycle, a `PostToolUse` hook (`owner-inbox-hook`, registered only for the lead's session through
  `lead-settings.json`) hands a new `priority` or `urgent` message to the lead once. For `urgent`, agents that
  are working get a fixed notice, never the message text, asking them to reach a safe point and report back;
  every agent is told at start that this notice is genuine.
- A message stays open, and is shown again each cycle, until the lead replies `done` or `declined` or the
  owner closes it. Owner messages rank above the lead's roadmap and below the charter and gate contract.
- The lead never waits for the owner: a question must state its default, and work goes on with it.

## Owner issues

Tickets for the lead, separate from the inbox. The owner raises one from a Gallery screenshot (tile menu ☰ →
"Leave a note"), drawing boxes, ellipses or freehand marks on it, or with **New issue** on the Issues tab: a
title, kind and description, with no picture, one picture of the owner's own (marked up the same way), and
from kit 0.7 up to 8 more files (logs, more pictures; a marked-up extra picture goes along as
`<name>-markup.png`). The console's Issues tab shows them as a board: New, In progress, Done (won't fix sits
in Done), with a filter by kind and a search.

| Path | Owner | Purpose |
|---|---|---|
| `/var/lib/agent-kit/issues/<id>/issue.md`, `shot.png`, `markup.png` | root | The issue, the screenshot (or the owner's picture), and the same with the owner's markup flattened on it |
| `/var/lib/agent-kit/issues/<id>/att/<file>` | root | Files the owner attached on the Issues page (kit 0.7): plain files, at most 8, 20 MB each |
| `/var/lib/agent-kit/issues/.owner/<id>` | root | `<status> <date>` when the owner moved the issue on the board |
| `/var/lib/agent-kit/issues-out/<id>.md` | `agent` | The lead's latest update: `Status: in_progress`, `done` or `wontfix`, optional `Fixed-shot:` |

- `agent-kit-issues put` (root, called by the console) accepts only `issue.md`, `shot.png`, `markup.png` and
  plain files directly in `att/` with plain names (the same rules as inbox attachments). `owner-issues show`
  and the prompt list the attachment paths for the lead.
  `agent-kit-issues set` records an owner move.
- Every cycle, `lead-cycle` appends `owner-issues prompt` after the inbox: the protocol and all open issues.
  Issues are never injected mid-cycle; they weigh like a `note`.
- The lead always triages: assigns the issue to the team (`in_progress`), reports `done` with an optional newer
  gallery shot (the console shows before and after), or `wontfix` with a reason.
- The newer of the owner's move and the lead's update wins, on the VM and in the console.
- In the console an issue is tied to its gallery *screen* (the file name without its number prefix), not to
  one day's file, so a tile keeps its dot after screenshots are regenerated: amber while any issue for that
  screen is open, green once all are resolved. Console copies live in `DATA_DIR/issues/<project>/`.

## Controls

All root-owned, all run from outside by the owner (or the console):

| Command | Does |
|---|---|
| `agent-kit-halt [reason]` | Kill switch, lead timer off, the cycle in progress stopped, and the team's own units that run Claude stopped. Other team services keep running. Records what it turned off |
| `agent-kit-resume [--no-timer]` | Clears the stop, restores exactly what the halt turned off, enables the lead timer |
| `agent-kit-halt-after set [--wrap-up] [reason]` / `clear` | Halt when the cycle in progress has ended, and the gate has judged what it submitted, instead of cutting it short (see below) |
| `agent-kit-oneshot start <id> <from>` | On a halted or idle team: one cycle for one job from the owner, then back to what it was (see below) |
| `agent-kit-halt-at set <unix-seconds>` | A halt at a fixed time (checked every minute, survives a reboot). The daily cap counts cycles, not hours |
| `agent-kit-caps set <KEY> <VALUE>` | Cycle cap, budget and models, kept in `/etc/agent-kit/caps.env` |
| `agent-kit-schedule set` / `clear` / `show` | Start cycles at set times instead of back to back (see below) |
| `agent-kit-gate pause` / `resume` | Pause the merge gate on its own |
| `agent-kit-units` | The team's own systemd user units and whether a halt stops them |

### Cycle slots

Without a schedule a team runs its cycles back to back until the daily cap is used up, which puts them all in
one block and lets two teams use up the same usage window together. A schedule spreads them out.

```
tz Europe/Amsterdam
slot daily 01:00
slot mon,wed,fri 13:30
```

That is `/etc/agent-kit/schedule` (root-owned), written by `agent-kit-schedule set` after it has checked
every line. Times are local to `tz`; daylight saving is the VM's `date` doing its job.

1. Every minute `agent-kit-tick` runs `agent-kit-schedule tick` (after the check for a due halt). A slot is due
   in its own minute, or up to 10 minutes late if the VM was busy or had just booted.
2. For a due slot the script decides once and writes one line to `/var/lib/agent-kit/schedule.log`:
   `started`, or `skipped:` with the reason (halted, lead timer off, a cycle is still running, a one-shot job, a
   pending halt, the daily cap). A skipped slot is not queued and a missed one is not caught up.
3. To start, it leaves a root-owned marker, `/var/lib/agent-kit/slot` (`<slot> <unix time>`), and starts the
   lead's unit. `lead-cycle` runs a normal cycle only with a marker younger than five minutes, and uses each
   marker once; the ledger line of that cycle carries `slot`.
4. The 15-minute lead timer keeps firing and finds nothing to do ("waiting for the next slot"). It stays the
   switch that says the team is on, so halt, resume, halt after the cycle and one-shot jobs work exactly as
   without a schedule. A one-shot job ignores the schedule, as it ignores the cap.

The schedule lives on the VM and the VM starts the cycles: a team keeps its times when the console is off.
The console's Schedule page reads the file with the status, shows all projects on one timeline and replaces a
project's schedule through `agent-kit-schedule set`. `clear` returns a team to back-to-back cycles.

### Halt after the cycle

`agent-kit-halt` stops a cycle where it stands. `agent-kit-halt-after set` lets it finish first.

1. `set` writes a note, `/var/lib/agent-kit/halt-after`. Nothing else changes: the cycle runs on.
2. While the note is there `lead-cycle` starts no new cycle.
3. Every minute `agent-kit-tick` runs `agent-kit-halt --if-due`, which asks `agent-kit-halt-after due`. It is due
   once the lead's unit is no longer running **and** the gate has started a pass since the cycle ended
   (`gate-run` writes `gate/pass-started`). That pass judges everything the cycle submitted and finishes on its
   own after the stop, so the last cycle's work still reaches main. A paused gate is not waited for, and a gate
   that starts no pass within 45 minutes (`HALT_AFTER_GATE_WAIT`, seconds, in `project.env`) is not either.
4. Then it is an ordinary halt: timer off, the team's own units that run Claude stopped, control `stop after
   cycle: <reason>`.

With no cycle running there is only the gate to wait for, so the halt comes within a few minutes.

`--wrap-up` also tells the lead and each agent, once, to wind down: finish the step in hand, start nothing new,
submit and record. It travels the same way as an owner message (`owner-inbox-hook`, after the next tool call),
so an agent that makes no tool calls, such as a lead that is only waiting for a usage limit to lift, does not
get it. Without `--wrap-up` nobody is told and the cycle takes its usual length.

`clear`, a resume or any halt drops the note. A scheduled stop still applies, whichever comes first. During a
one-shot job it is refused: that team halts at the end of its cycle anyway.

### Upgrading the kit while a cycle runs

`install.sh --upgrade` does not have to wait for a halt. It puts every file in place as a new file (`install`,
`ln -sf`), so a script that is running keeps the version it started with, and `systemctl daemon-reload` does
not restart a running unit. The cycle in progress finishes with the `lead-cycle` it began with; the helper
scripts it calls, the hook, the gate's next pass and every later cycle use the new kit at once. The kit's tests
cover the file replacement; the rest is how systemd behaves and has not been tried on a live team by these
tests. New controls that work through the tick or the hook (halt after the cycle, the wrap-up notice) apply to
a cycle that was already running when the kit was upgraded.

### One-shot job

For feedback and fixes the owner wants now. On a halted team, without letting it run on; on an idle team
(set to run, but no cycle running: between cycles, or the daily cycle cap used up), without waiting for the
next cycle. Not while a cycle runs: that cycle takes inbox messages.

1. `agent-kit-oneshot start` stores the job as an owner message (tier `oneshot`, same checks as any message),
   writes the marker `/var/lib/agent-kit/oneshot`, sets `control` to `run oneshot <id>` so that the gate runs,
   and starts `agent-kit-lead.service` once. The marker is `<id> <since> <after>`: `after` is `halt` on a
   halted team and `run` on an idle one. On a halted team the lead timer stays off and the team's own units stay
   stopped. On an idle team the lead timer is stopped first, so no timer cycle can start in the job's place
   (a start the timer has already queued counts as a running cycle and refuses the job).
   If the cycle cannot be started, all of it is undone, the stored message included, and the timer is back on.
2. `lead-cycle` sees the marker (it must agree with the control line) and builds a different prompt:
   `owner-inbox oneshot <id> --head` (a notice that this is a one-shot cycle), then the team's own
   `lead-cycle.md`, then `owner-inbox prompt`, then `owner-inbox oneshot <id>`: the job in full and the rules.
   The notice comes first because the team's instructions say the opposite in their first steps (pick roadmap
   work, resume or remove leftover worktrees). The rules: do this job and nothing else, leave interrupted work
   alone, plan, delegate as usual, ask with a default if unsure, wait for the gate with `gate-wait`, reply to
   the message, end. The team's own `lead-cycle.md` is not changed, and a normal cycle's prompt is the same
   as before.
3. When the cycle ends for any reason, the unit's `ExecStopPost` runs `agent-kit-oneshot finish`. On a halted
   team it writes `stop` again and no second cycle starts. On an idle team it writes `run after one-shot job
   <id> ...` and starts the lead timer again (if it is enabled): the next normal cycle comes 15 minutes later,
   if the daily cap allows. If the VM loses power mid-job, `finish` never runs: `agent-kit-tick` calls
   `agent-kit-oneshot reap` every minute, which does the same once a job has no cycle. A marker without the
   third field (from kit 0.5) means `halt`.

`finish` runs as root at the end of every cycle. The lead's unit reads `agent.env`, whose `PATH` starts with a
folder the agent can write to, so the unit starts `finish` with an empty environment and the script sets its
own `PATH`. `gate-run` reads `agent.env` too and resets its `PATH` after that, for the same reason.

- The cycle budget applies. The daily cycle cap does not block a one-shot job (the owner asked for it), but the
  cycle is counted. The ledger line of the cycle carries `oneshot: <id>`.
- During the job every owner message, notes included, is delivered mid-cycle, since no later cycle would read it.
- Open owner issues wait for a normal cycle, like other open messages, unless the job names them. Naming
  issues in a job is how to get them fixed now without resuming the team; the lead reports on those with
  `owner-issues update` as usual.
- The gate runs for the length of the job. Branches that were submitted before the halt and not yet judged are
  tested and merged then, as they would be on a resume. Unfinished work (worktrees, `work/*` branches) is not
  touched.
- `gate-wait <topic>...` is for the lead: it waits for the verdict on the commits it submitted. One call waits
  90 seconds at most, so that it fits in a tool call, and says when to call it again.
- A halt stops the job like any cycle; a resume during the job turns it into a normal run. A halt after the
  cycle (`agent-kit-halt-after`) can be asked for during a job on an idle team, and applies when it ends.
- The lead is told which of the two it is (`owner-inbox oneshot` reads the marker): halted again after the
  job, or back to the normal schedule.
- If the job's cycle ends before the lead answered `done` or `declined` (a halt, a usage limit, the budget),
  the message stays open. The owner can start the job again from the Inbox (`agent-kit-oneshot start` with
  the same id), or resume the team: a normal cycle treats an open `oneshot` message as `priority`.

### Planning cycle and backlog

From kit 0.10. An extra lane next to the normal cycles, not a replacement: the owner asks the lead to
"find what to do next", the lead writes proposals with estimates and no code, and the owner decides.
Normal cycles keep choosing and doing their own work as before.

- A planning cycle is a one-shot job with a `-p-` id: `agent-kit-oneshot start <id> <from> --plan`, with an
  optional focus text on stdin. The request goes to `backlog/plans/<id>/request.md` (root-owned) through
  `agent-kit-backlog plan`, not to the inbox, so normal cycles never see it as an open owner message.
  `backlog/current` names the newest plan. Same rules as a one-shot job otherwise: on a halted or idle
  team, not while a cycle runs, counted in the ledger, not blocked by the daily cap.
- `lead-cycle` builds its prompt from `owner-backlog plan <id> --head`, the team's `lead-cycle.md`, the
  usual sections, and `owner-backlog plan <id>`: the request, the rules (read notes before code, no code,
  at most 90 minutes per proposal, split and order larger work, 3 to 8 proposals) and the last 10 ledger
  lines as numbers to estimate from. It runs with `--tools Read,Grep,Glob,Bash` (no Edit, Write, agents or
  scheduling tools) and `PLAN_BUDGET_USD` (default 2). The shell stays, for `owner-backlog`, so the kit
  also hashes the workspace (HEAD, status, worktrees, branches) before and after: a change sets
  `touched_code: true` on the ledger line, and the console shows it.
- The session id goes to `ledger/plans/<id>`, for the chat.
- `owner-backlog propose` writes `backlog-out/<pid>.md` (agent): `Plan`, `Rev`, `Date`, `Title`, `Minutes`
  (1-90), `Cost-usd`, `Confidence` (low, medium, high), `Areas`, `Depends`, `Order`, `Risk`, `---`, then why
  and steps (at most 8000 bytes). `owner-backlog revise <pid>` writes the next revision.
- The owner's decision is root-owned: `agent-kit-backlog set <pid> approved|rejected|new <rev>` writes
  `backlog/.owner/<pid>`. It counts only for the revision the owner saw; a later revision needs a new one.
- An approved item runs as a one-shot job the owner starts, now or at a set time (below). Nothing runs by
  itself, unless the owner sets `FREE_TAKE_APPROVED=1` (`agent-kit-caps`, off by default): then a normal
  cycle's prompt offers the approved items, and the lead marks the one it takes with `owner-backlog taken`.
- Every normal cycle's prompt has a short "Backlog" section that says the lane exists.

| Path | Owner | What |
|---|---|---|
| `/var/lib/agent-kit/backlog/plans/<id>/request.md` | root | What the owner asked the lead to plan |
| `/var/lib/agent-kit/backlog/current` | root | The newest plan id: the only one a chat can resume |
| `/var/lib/agent-kit/backlog/.owner/<pid>` | root | `<status> <rev> <utc>` |
| `/var/lib/agent-kit/backlog/chat/<id>/<msgid>.md` | root | The owner's chat messages; `.ended` when the owner ended the chat |
| `/var/lib/agent-kit/backlog-out/<pid>.md` | agent | The lead's proposals, data to check |
| `/var/lib/agent-kit/backlog-out/chat/<id>/<msgid>.md` | agent | The lead's answers (`Re`, `Status: ok|error`, `Date`, `---`, text) |
| `/var/lib/agent-kit/ledger/plans/<id>` | agent | The planning cycle's session id |

### Chat with the lead

After a planning cycle the owner can talk with the lead about its proposals. There is no process waiting
for the owner: each message resumes the planning cycle's own session for one answer, so the lead keeps
what it read.

1. `agent-kit-chat say <plan-id> <msgid> <from>` (text on stdin, at most 20 KB) stores the message
   root-side, writes the marker `/var/lib/agent-kit/chat` and starts `agent-kit-chat.service`. It refuses
   while that plan's own planning cycle runs, while a turn is still answering, for any plan but the newest,
   and after the owner ended the chat (`agent-kit-chat end`). From kit 0.10.1 a turn may run next to a
   normal cycle or a one-shot job (a Run now from the backlog): the chat notice names the job that is
   running (and its backlog item), so the lead keeps it in mind. The chat process does not set
   `ZIGGURAT_LEAD_SESSION`, so owner messages are never delivered into it.
2. `lead-chat` (as `agent`, in the workspace like a cycle) runs `claude -p --resume <session id>` with the
   chat notice and the message. Tool limits and the permission mode are not kept by a resumed session, so
   it passes them every turn: the same tools as a planning cycle, `CHAT_BUDGET_USD` (default 1). The lead
   may revise or add proposals; still no code. The answer goes to `backlog-out/chat/`.
3. The ledger line has `kind: chat`, `counted: false` and this turn's cost only: a resumed run reports the
   whole session's total, so `lead-chat` subtracts what the ledger already holds for that session.
4. `ExecStopPost` runs `agent-kit-chat finish`, which drops the marker; `agent-kit-tick` reaps a marker whose
   turn is gone. A cycle may start while a turn answers. A halt stops a turn too. With a cycle running
   next to a turn, its `touched_code` is null: the workspace changes for the cycle's own reasons.

On a subscription the prompt cache lasts an hour. A turn later than that reads the whole session again at
the full rate, so the first answer after a long pause costs more than the next ones.

### Scheduled one-shot job

From kit 0.10. `agent-kit-oneshot at <unix> <id> <from> [--plan]` keeps a job (or a planning request) in
`oneshot-at/` (root, 700), not in the inbox, until its time: from 30 seconds to 31 days ahead. `unat <id>`
cancels it, `list-at` lists them. Every minute `agent-kit-tick` runs `agent-kit-oneshot due`, after the
slots: a job whose time has come goes through the normal `start`. If the team is busy (a cycle, another job,
a chat turn) it tries again each minute; after 30 minutes it drops the job and writes `missed` to
`schedule.log` (`job:<id>` in the slot field), so nothing starts hours late. One start per tick.

### Planned issues and jobs on the timeline

From kit 0.11. Approving a proposal on the Backlog also raises an owner issue of kind `planned` (made by the
console, not by the owner's own forms). It holds the job's text and a link to the proposal. Normal cycles do
not see planned issues (`owner-issues prompt` leaves them out) unless the owner allows them to take approved
items (`FREE_TAKE_APPROVED=1`). The one-shot job of that item names the issue, so the lead sets it
`in_progress` and `done` as usual. A later revision approved again replaces the issue (the old one becomes
`wontfix`); rejecting closes it. Planned issues are not counted in the Issues tab's badge.

The Schedule page draws backlog jobs from the console's own run records, the VM's status (jobs set for a
time, the job running) and the ledger: the estimate dashed, what ran hatched, hover for the title, click for
the proposal. Run now shows a running bar at once. A job set for a time can be moved (`unat`, then `at` again
with the stored job) or cancelled there. On the Backlog, "Schedule ▾ → On the timeline…" opens a day of all
teams in a pop-up: the job's estimate follows the pointer in its team's row and a click picks the start.

### Ledger kinds

From kit 0.10 every ledger line has `kind`: `normal`, `oneshot`, `plan` or `chat`, and `plan` (the plan id,
or null). Planning and chat lines also carry `touched_code`.

A team unit counts as a token spender when it is listed in `/etc/agent-kit/token-units`, or when what it
executes mentions `claude`; `/etc/agent-kit/keep-units` overrides both.
