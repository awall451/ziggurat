# kit

`vm/` is installed inside each sandbox VM by `vm/install.sh <rendered-project-dir>`
(see [docs/getting-started.md](../docs/getting-started.md) and [docs/architecture.md](../docs/architecture.md)).

| File | Role |
|---|---|
| `vm/install.sh` | idempotent installer: users, `/opt/agent-kit`, canonical repo, systemd units |
| `vm/bin/lead-cycle` | one headless lead cycle (budget, daily cap, usage-limit backoff, ledger) |
| `vm/bin/gate-status`, `agent-kit-status`, `agent-kit-stop` | verdicts, owner overview, kill switch |
| `vm/gate/bin/gate-run` | the gate: fetch `ready/*`, test as `gaterun`, fast-forward `main` |
| `vm/agent.env` | proxy, PATH, model and safety env for agent processes |
| `vm/systemd/` | `agent-kit-lead` (cycles) and `agent-kit-gate` (every 2 min) timers |

The project folder supplies `CHARTER.md`, `GATE-CONTRACT.md`, `lead-cycle.md`,
`project.env`, `gate-checks`, optional `checks/` and `agent.env.extra`, and
`agents/*.md` (the team).
