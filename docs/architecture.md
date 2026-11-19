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

1. `agent-kit-lead.timer` starts `lead-cycle` 15 minutes after the previous cycle ended (and only if `control` says `run` and the daily cap allows).
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

## Getting data out

The owner's side pulls; the VM never pushes and holds no credentials for anything else. The
[console](../console/README.md) copies transcripts, the ledger, gate history, notes and screenshots every 15
minutes (and the cycle in progress every 15 seconds while someone is watching it), append-only and without
following symlinks. Agent-owned folders are read as the `agent` user, so a path an agent swapped for a link
cannot make a root process read something else.

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
"Leave a note"), drawing boxes, ellipses or freehand marks on it. The console's Issues tab shows them as a
board: New, In progress, Done (won't fix sits in Done).

| Path | Owner | Purpose |
|---|---|---|
| `/var/lib/agent-kit/issues/<id>/issue.md`, `shot.png`, `markup.png` | root | The issue, the screenshot, and the screenshot with the owner's markup flattened on it |
| `/var/lib/agent-kit/issues/.owner/<id>` | root | `<status> <date>` when the owner moved the issue on the board |
| `/var/lib/agent-kit/issues-out/<id>.md` | `agent` | The lead's latest update: `Status: in_progress`, `done` or `wontfix`, optional `Fixed-shot:` |

- `agent-kit-issues put` (root, called by the console) accepts only `issue.md`, `shot.png` and `markup.png`.
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
| `agent-kit-oneshot start <id> <from>` | On a halted team: one cycle for one job from the owner, then halted again (see below) |
| `agent-kit-halt-at set <unix-seconds>` | A halt at a fixed time (checked every minute, survives a reboot). The daily cap counts cycles, not hours |
| `agent-kit-caps set <KEY> <VALUE>` | Cycle cap, budget and models, kept in `/etc/agent-kit/caps.env` |
| `agent-kit-gate pause` / `resume` | Pause the merge gate on its own |
| `agent-kit-units` | The team's own systemd user units and whether a halt stops them |

### One-shot job

For feedback and fixes the owner wants now, without letting the team run on. Only on a halted team.

1. `agent-kit-oneshot start` stores the job as an owner message (tier `oneshot`, same checks as any message),
   writes the marker `/var/lib/agent-kit/oneshot`, sets `control` to `run oneshot <id>` so that the gate runs,
   and starts `agent-kit-lead.service` once. The lead timer stays off and the team's own units stay stopped.
   If the cycle cannot be started, all of it is undone, the stored message included.
2. `lead-cycle` sees the marker (it must agree with the control line) and builds a different prompt:
   `owner-inbox oneshot <id> --head` (a notice that this is a one-shot cycle), then the team's own
   `lead-cycle.md`, then `owner-inbox prompt`, then `owner-inbox oneshot <id>`: the job in full and the rules.
   The notice comes first because the team's instructions say the opposite in their first steps (pick roadmap
   work, resume or remove leftover worktrees). The rules: do this job and nothing else, leave interrupted work
   alone, plan, delegate as usual, ask with a default if unsure, wait for the gate with `gate-wait`, reply to
   the message, end. The team's own `lead-cycle.md` is not changed, and a normal cycle's prompt is the same
   as before.
3. When the cycle ends for any reason, the unit's `ExecStopPost` runs `agent-kit-oneshot finish`, which writes
   `stop` again. No second cycle starts. If the VM loses power mid-job, `finish` never runs: `agent-kit-tick`
   calls `agent-kit-oneshot reap` every minute, which halts again once a job has no cycle.

`finish` runs as root at the end of every cycle. The lead's unit reads `agent.env`, whose `PATH` starts with a
folder the agent can write to, so the unit starts `finish` with an empty environment and the script sets its
own `PATH`. `gate-run` reads `agent.env` too and resets its `PATH` after that, for the same reason.

- The cycle budget applies. The daily cycle cap does not block a one-shot job (the owner asked for it), but the
  cycle is counted. The ledger line of the cycle carries `oneshot: <id>`.
- During the job every owner message, notes included, is delivered mid-cycle, since no later cycle would read it.
- The gate runs for the length of the job. Branches that were submitted before the halt and not yet judged are
  tested and merged then, as they would be on a resume. Unfinished work (worktrees, `work/*` branches) is not
  touched.
- `gate-wait <topic>...` is for the lead: it waits for the verdict on the commits it submitted. One call waits
  90 seconds at most, so that it fits in a tool call, and says when to call it again.
- A halt stops the job like any cycle; a resume during the job turns it into a normal run.
- If the job's cycle ends before the lead answered `done` or `declined` (a halt, a usage limit, the budget),
  the message stays open. The owner can start the job again from the Inbox (`agent-kit-oneshot start` with
  the same id), or resume the team: a normal cycle treats an open `oneshot` message as `priority`.

A team unit counts as a token spender when it is listed in `/etc/agent-kit/token-units`, or when what it
executes mentions `claude`; `/etc/agent-kit/keep-units` overrides both.
