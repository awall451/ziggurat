# kit

`vm/` is installed inside each sandbox VM by `vm/install.sh <rendered-project-dir>`
(see [docs/getting-started.md](../docs/getting-started.md) and [docs/architecture.md](../docs/architecture.md)).
Update a VM that already runs the kit with `sudo bash vm/install.sh --upgrade` while its team is halted.

| File | Role |
|---|---|
| `vm/install.sh` | idempotent installer: users, `/opt/agent-kit`, canonical repo, systemd units; `--upgrade` for kit files only |
| `vm/bin/lead-cycle` | one headless lead cycle (budget, daily cap, usage-limit backoff, ledger, owner inbox) |
| `vm/bin/gate-status`, `agent-kit-status` | verdicts, owner overview |
| `vm/bin/agent-kit-halt`, `agent-kit-resume`, `agent-kit-halt-at` | stop now, undo a stop, stop at a set time (`agent-kit-stop` is the old name for halt) |
| `vm/bin/agent-kit-caps`, `agent-kit-gate`, `agent-kit-units` | brakes and models, gate pause, the team's own units |
| `vm/bin/agent-kit-auth` | how the agents sign in to Claude: `status`, `set-token` (a subscription token from `claude setup-token`, on stdin), `clear`. Never prints the token; never accepts an API key |
| `vm/bin/agent-kit-inbox` | owner side of the inbox: checked delivery of a message, close |
| `vm/bin/owner-inbox`, `owner-inbox-hook`, `vm/lead-settings.json` | lead side: read, reply, ask; mid-cycle delivery to the lead's session |
| `vm/gate/bin/gate-run` | the gate: fetch `ready/*`, test as `gaterun`, fast-forward `main` |
| `vm/agent.env` | proxy, PATH, model and safety env for agent processes |
| `vm/systemd/` | `agent-kit-lead` (cycles), `agent-kit-gate` (every 2 min) and `agent-kit-tick` (scheduled stop) timers |
| `vm/tests/run.sh` | script tests; run anywhere with `bash kit/vm/tests/run.sh` |

The project folder supplies `CHARTER.md`, `GATE-CONTRACT.md`, `lead-cycle.md`,
`project.env`, `gate-checks`, optional `checks/` and `agent.env.extra`, and
`agents/*.md` (the team).
