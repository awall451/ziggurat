# kit

`vm/` is installed inside each sandbox VM by `vm/install.sh <rendered-project-dir>`
(see [docs/getting-started.md](../docs/getting-started.md) and [docs/architecture.md](../docs/architecture.md)).
Update a VM that already runs the kit with `sudo bash vm/install.sh --upgrade`; this can be done while a cycle is
running (see "Upgrading the kit while a cycle runs" in [docs/architecture.md](../docs/architecture.md)).

| File | Role |
|---|---|
| `vm/install.sh` | idempotent installer: users, `/opt/agent-kit`, canonical repo, systemd units; `--upgrade` for kit files only |
| `vm/bin/lead-cycle` | one headless lead cycle (budget, daily cap, usage-limit backoff, ledger, owner inbox and issues) |
| `vm/bin/gate-status`, `agent-kit-status` | verdicts, owner overview |
| `vm/bin/agent-kit-halt`, `agent-kit-resume`, `agent-kit-halt-at` | stop now, undo a stop, stop at a set time (`agent-kit-stop` is the old name for halt) |
| `vm/bin/agent-kit-halt-after` | halt when the cycle in progress has ended and the gate has run, optionally asking the team to wrap up |
| `vm/bin/agent-kit-oneshot` | one cycle for one job from the owner on a halted or idle team, then back to halted or running (`start`, `finish`, `reap`) |
| `vm/bin/gate-wait` | for the lead: wait for the gate's verdict on submitted branches (used in a one-shot job) |
| `vm/bin/agent-kit-caps`, `agent-kit-gate`, `agent-kit-units` | brakes and models, gate pause, the team's own units |
| `vm/bin/agent-kit-gate-proof` | for a halted team: proves the gate merges a harmless change and refuses a change that deletes a test (`GATE_PROOF_DELETE` in `project.env`); uses `gate-run --proof`, never starts the team |
| `vm/bin/agent-kit-auth` | how the agents sign in to Claude: `status`, `set-token` (a subscription token from `claude setup-token`, on stdin), `clear`. Never prints the token; never accepts an API key |
| `vm/bin/agent-kit-inbox` | owner side of the inbox: checked delivery of a message, close |
| `vm/bin/owner-inbox`, `owner-inbox-hook`, `vm/lead-settings.json` | lead side: read, reply, ask; mid-cycle delivery to the lead's session |
| `vm/bin/agent-kit-schedule` | cycle slots: start the team's cycles at set times instead of back to back (checked schedule file, a tick every minute, a log of what each slot did) |
| `vm/bin/agent-kit-publish`, `owner-publish` | publishing main to a remote repository: status and a bundle of main for the console, which does the push; the lead's request and prompt |
| `vm/bin/agent-kit-issues`, `owner-issues` | owner issues: checked delivery and owner moves; the lead's list, show, update and prompt |
| `vm/gate/bin/gate-run` | the gate: fetch `ready/*`, test as `gaterun`, fast-forward `main` |
| `vm/agent.env` | proxy, PATH, model and safety env for agent processes |
| `vm/systemd/` | `agent-kit-lead` (cycles), `agent-kit-gate` (every 2 min) and `agent-kit-tick` (scheduled stop, halt after the cycle, lost one-shot jobs) timers |
| `vm/tests/run.sh` | script tests; run anywhere with `bash kit/vm/tests/run.sh` |

The project folder supplies `CHARTER.md`, `GATE-CONTRACT.md`, `lead-cycle.md`,
`project.env`, `gate-checks`, optional `checks/` and `agent.env.extra`, and
`agents/*.md` (the team).
