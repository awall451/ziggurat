# Gate contract

Read-only. How work reaches `main`.

## Submitting

1. Commit your work on a branch based on the **current** gate main:
   `git fetch gate && git rebase gate/main`.
2. Create (or move) a branch named `ready/<topic>` pointing at that commit:
   `git branch -f ready/<topic> HEAD`. No push is needed: the gate reads your
   workspace every ~2 minutes.
3. Check the verdict: `gate-status` (or `gate-status <topic>`). A verdict is
   `merged`, `failed` (with the failing step and log path) or `rejected`
   (not based on current main: rebase and move the ready branch).
4. After a merge, delete the ready branch: `git branch -D ready/<topic>`.

`gate/main` is the only real main. Your local `main` is just a copy:
`git fetch gate && git checkout main && git reset --hard gate/main`.

## What the gate runs (as a separate user, on a fresh checkout)

| Step | Rule |
|---|---|
| venv | fresh `python3 -m venv .venv` |
| install | `pip install -r requirements-dev.txt` (and `requirements.txt` if present) |
| lint | `ruff check .` (keep `ruff` in `requirements-dev.txt`) |
| unit | `pytest`; **passed** tests (skipped ones do not count) must not drop below main's |
| repo checks | `tools/gate-extra.sh` if present: the team's own checks, yours to maintain |

The whole run has a 30 minute limit; keep `tools/gate-extra.sh` well under it.

Logs: `/var/lib/agent-kit/gate/logs/<sha>.log` and `<sha>-out/`.

## Changing the gate

The gate's own steps are root-owned. To make one of your checks binding, build
it in `tools/gate-extra.sh` first, then ask for promotion with
`PROMOTE: gate check <name>` in ESCALATIONS.md.
