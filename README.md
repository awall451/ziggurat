# Ziggurat

**A tiered team of Claude Code agents that builds software on its own, inside a sandbox, and can only ship what passes checks it cannot touch.**

> Status: **experimental.** This is a working setup extracted from real use (a browser JRPG and a PlayStation 1 JRPG built mostly unattended), published early. Expect sharp edges, Proxmox-specific plumbing and breaking changes.

```
                 ┌───────────────┐
                 │     lead      │  Fable · one fresh session per cycle
                 │ plans, assigns│  keeps STATE.md as its own handoff
                 └──────┬────────┘
          ┌─────────────┼─────────────┐
   ┌──────┴─────┐ ┌─────┴──────┐ ┌────┴───────┐
   │ area lead  │ │ area lead  │ │ area lead  │  Opus (Sonnet for small goals)
   │  engine    │ │  content   │ │  art/audio │  one goal each · plan · review · commit
   └──┬───┬───┬─┘ └──┬────┬────┘ └──┬─────────┘
      │   │   │      │    │         │
   builder builder scout builder scout ...       Sonnet builders (never commit)
                                                 Haiku scouts (search, run, summarize)
                          │
                 ready/<topic> branch
                          ▼
   ┌─────────────────────────────────────────────┐
   │ THE GATE  (root-owned, agents cannot edit)  │  fresh checkout as a separate user:
   │ build · tests (count may not drop) · e2e    │  passes → main moves; fails → back to the team
   └─────────────────────────────────────────────┘
```

## The idea

Most "autonomous coding" failures come from one thing: **the agent that did the work also decides it is done.** Ziggurat separates those roles mechanically:

- **A gate the agents cannot edit.** Work reaches `main` only when a root-owned script, running as a separate unprivileged user on a fresh checkout, says every check passes. The test count may not drop. The project defines its checks (`gate-checks`); the agents cannot change them.
- **A tiered team, priced by thinking.** The lead (top model) plans and reviews lightly. Area leads (Opus) own one goal each, break it into steps and review every diff. Builders (Sonnet) and scouts (Haiku) do the long, token-heavy work in short sessions. In our trials this cut cost per merged goal by about 40% versus Opus-does-everything.
- **A sandbox with one door.** Each project runs in its own VM with no route anywhere. The only way out is a proxy that allows a short domain list (the model API, package registries). The VM holds no credentials that work anywhere else.
- **Fresh sessions, durable notes.** No agent keeps a long context. The lead starts every cycle from `docs/agents/STATE.md` and the gate's verdicts, and rewrites `STATE.md` before it ends.

## What's in here

| Path | What |
|---|---|
| [`kit/vm/`](kit/vm) | Installed inside each sandbox VM: the cycle runner, the gate, kill switch, status commands, systemd timers |
| [`examples/web-game/`](examples/web-game) | A TypeScript/Vite browser game: charter, gate checks (type check, unit tests, headless boot + fuzz, smoke playthrough), team |
| [`examples/ps1-cpp/`](examples/ps1-cpp) | A PlayStation 1 game in C++20 (psyqo): charter, gate checks (host tests, PS1 build, headless-emulator playthrough, disc image), toolchain recipe, team |
| [`sandbox/proxmox/`](sandbox/proxmox) | Ansible for the isolated network, the egress proxy gateway and one VM per project, with a wall check that proves isolation from inside |
| [`workstation/`](workstation) | Pull agent data home (append-only, pull-only) and write a morning digest with a spoken brief |
| [`dashboard/`](dashboard) | A web page per box: spoken brief, screenshots over time, usage, gate verdicts, the lead's plan, QA issues, trial comparisons |
| [`themes/`](themes) | Display names for the roles: `plain`, `tolkien`, `borg`, `orchestra`, `gothic`, `cathedral`, `starship`, `norse`, `heist`, `greek`, `monastery`. Behaviour never changes with a theme |
| [`tools/render-team.py`](tools/render-team.py) | Renders a project folder for a theme |
| [`docs/`](docs) | [Architecture](docs/architecture.md) · [Getting started](docs/getting-started.md) · [Lessons](docs/lessons.md) · [Results](docs/results.md) · [Roadmap](docs/roadmap.md) |

## Roles and themes

Agent ids are neutral and stable (`area-lead-engine`, `builder`, `scout`, `reviewer`, `qa`); a theme only changes the names in prose.

| Role | plain | tolkien | borg | orchestra |
|---|---|---|---|---|
| lead | lead | Eru | Queen | Conductor |
| area lead | area lead | Ainu / Ainur | Unimatrix | Section Principal |
| worker | builder | Maia / Maiar | Drone | Player |

```bash
tools/render-team.py examples/web-game --theme tolkien --out build/my-game
```

## Requirements

- A **Claude subscription** (the agents log in with it; no API keys) and Claude Code in each VM.
- A **Proxmox VE** host for the sandboxes (other backends are on the roadmap). Ansible on your workstation.
- Patience: this is a set of scripts and conventions, not an installer yet. Start with [Getting started](docs/getting-started.md).

## Safety notes

- Agents run with permission prompts off **inside** the VM. The VM, the egress allow-list and the absence of credentials are the safety boundary; read [sandbox/proxmox/README.md](sandbox/proxmox/README.md) before running anything.
- Every allow-listed domain is also a possible exfiltration channel. Keep the list short.
- Your subscription's usage limits are shared between the agents and your own Claude use. Cycles back off and retry when a limit is hit; watch your usage page the first days.

## License

MIT, see [LICENSE](LICENSE).
