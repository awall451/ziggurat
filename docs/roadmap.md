# Roadmap

Where Ziggurat is going. The structure is still being worked out on two example
projects (a browser game and a PlayStation 1 game).

## 1. Roles are the product, names are a theme

The structure is what matters; themed names are flavour and will not land with
everyone. Treat every agent as a **neutral role** with a
**themed display name**.

| Role id (neutral, used in code and files) | What it does | Model (current) | Tolkien theme |
|---|---|---|---|
| `lead` | Plans each cycle, assigns goals, light review, keeps STATE.md | Fable | Eru |
| `area-lead` (`engine`, `content`, `art`, `audio`) | Owns one goal, plans steps, delegates, reviews diffs, commits | Opus (Sonnet for small goals) | Ainur |
| `builder` | Implements one step, never commits | Sonnet | Maia (`maia-builder`) |
| `scout` | Search, run checks, summarize logs, never edits | Haiku | Maia (`maia-scout`) |
| `reviewer` | Independent review of risky branches | Opus / Sonnet | `ainu-review` |
| `qa` | Plays the game, files issues | Opus | `ainu-qa` |

### Themes (implemented in `themes/`)

| Theme (file) | lead | area-lead | builder | scout | reviewer | qa |
|---|---|---|---|---|---|---|
| Plain (`plain`, default for others) | lead | area lead | builder | scout | reviewer | QA |
| Tolkien (`tolkien`) | Eru | Ainu / Ainur | Maia / Maiar | Maia scout | Ainu reviewer | Ainu QA |
| Borg (`borg`) | Queen | Unimatrix | Drone | Probe | Vinculum | Tactical Cube |
| Orchestra (`orchestra`) | Conductor | Section Principal | Player | Stagehand | Critic | Audience |
| Gothic household (`gothic`) | The Count | Steward | Servant | Footman | Chaplain | Night Watch |
| Cathedral builders (`cathedral`) | Master Builder | Master Mason | Journeyman | Apprentice | Inspector | Pilgrim |
| Starship (`starship`) | Captain | Chief Officer | Crew member / Crew | Ensign | First Officer | Away Team |
| Norse (`norse`) | Odin | As / Aesir | Einheri / Einherjar | Raven | Norn | Valkyrie |
| Heist crew (`heist`) | Mastermind | Specialist | Muscle | Lookout | Fixer | Inside Man |
| Greek (`greek`) | Zeus | Olympian | Hero | Hermes | Athena | the Oracle |
| Monastery (`monastery`) | Abbot | Brother | Novice | Lay Brother | Prior | Pilgrim |

Each file sets `lead`, `area_lead(s)`, `worker(s)` (the builder), `scout(s)`, `reviewer` and `qa`.
Prompts reference them as `{{lead}}`, `{{workers}}`, `{{reviewer}}` etc.

### How a theme toggle could work (later)

- Agent files and prompts use **role ids** (`area-lead-engine.md`, `builder.md`, `scout.md`).
- A theme is a small file, `themes/<name>.yml`: role id → display name, plus an optional one-line
  flavour per role ("You are a Maia..."). Prompts reference `{{name.builder}}` etc.
- The installer renders the agent files and prompts for the chosen theme (`THEME=tolkien`).
- The console, digests and spoken briefs read the same theme file, so labels match everywhere.
- Switching theme only changes display names and flavour text, never behaviour, models or permissions.
- Migration from today: rename `ainu-*`/`maia-*` files to role ids and render Tolkien names from
  the theme. One mechanical change, best done when the setup is stable.

## 2. What is personal today and would need generalizing

| Hard-coded now | Generalize to |
|---|---|
| Proxmox host, `vmbr1`, `10.66.0.0/24`, gateway CT 110, VMIDs 300+ | Config file; also support "Docker Sandboxes / plain VM / cloud session" backends |
| Admin user, SSH key, workstation paths | Done: `config.example.env`; next: a setup script |
| Allow-list domains | Per-project additions in project config |
| Gate checks (`gate-checks` per project) | Keep: it is the per-project contract; ship examples (web game, PS1/C++) |
| Console and digest on the owner's workstation | Done: `console/` with its own config folder; next: run it on a small VM with a login in front, and create projects from it |
| Subscription-only auth via `claude auth login` in each VM | Document both login and `setup-token` paths and their trade-offs |

## 3. Lessons worth writing up for others

- The gate the workers cannot edit is the core idea; everything else is plumbing.
- Headless cycles kill background subagents when the lead ends its turn: foreground only.
- Count only real work toward daily caps; usage-limit hits must retry, not burn the cap.
- Most spend was long Opus builder sessions re-reading context; tiering (Opus leads, Sonnet
  builders, Haiku scouts) is the main cost lever. Measure: `fleet/<box>/trials/`.
- Toolchains for sandboxed VMs: download on the host, copy in, keep the allow-list small.

## 4. Console: what is next

Done: projects, live topology with history, progress, usage, owner inbox with replies and questions,
halt/resume and brakes, one-shot jobs on a halted team, all through fixed kit scripts.

Later:
- Create a project from the console: pick a target, run the sandbox playbooks, install the kit and a team bundle.
- A login in front (an auth proxy header is already honoured) and a dedicated, restricted ssh key.
- A side chat with the lead that forks its session, for questions that need an answer now.
- A full transcript viewer per agent, context shown as a share of the model's limit, and services used.
- Allow-list edits, VM rollback and removal, with the same care as the gate.

