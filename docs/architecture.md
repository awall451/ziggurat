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

The workstation pulls; the VM never pushes and holds no credentials for anything else. `workstation/agent-pull` copies transcripts (for a token tracker), the ledger, gate history, notes and screenshots, append-only and without following symlinks.
