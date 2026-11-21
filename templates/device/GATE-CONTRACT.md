# Gate contract

Read-only. How work reaches `main`.

## Submitting

1. Commit your work on a branch based on the **current** gate main:
   `git fetch gate && git rebase gate/main`.
2. Create (or move) a branch named `ready/<topic>` pointing at that commit:
   `git branch -f ready/<topic> HEAD`. No push is needed: the gate reads your
   workspace every ~2 minutes.
3. Check the verdict: `gate-status` (or `gate-status <topic>`). A verdict is
   `merged`, `failed` (with the failing step and log path), `rejected`
   (not based on current main: rebase and move the ready branch) or `held`
   (it changes the checks: waiting for the owner, see below).
4. After a merge, delete the ready branch: `git branch -D ready/<topic>`.

`gate/main` is the only real main. Your local `main` is just a copy:
`git fetch gate && git checkout main && git reset --hard gate/main`.

## What the gate runs (as a separate user, on a fresh checkout)

The repository owns its checks: the gate runs `bash tools/check <outdir>` and
nothing else of the project's. `tools/check` must:

| | |
|---|---|
| print | one line per step: `STEP <name> ok <secs>s` or `STEP <name> FAIL <secs>s` |
| print | `TESTS_PASSED=<n>`: the passed tests (a skipped test does not count) |
| exit | non-zero when anything fails |
| may write | screenshots to `<outdir>/shots/*.png`: the owner sees them in the gallery, one set per merged build |

It runs with a 25 minute limit, without your environment, through the same
proxy. Run it yourself before submitting: `bash tools/check /tmp/check-out`.

The gate's own rules, outside the repository:
- the number of passed tests may never drop below main's;
- a branch must be based on current main;
- a change to `tools/check` or `tools/check.d/` is **held** until the owner
  approves that exact commit. Explain it first, in plain words, with
  `owner-gate explain <topic>` (text on stdin): what the checks will do
  differently and why. Keep it on its own branch: a new commit needs a new
  approval. A declined change shows as `failed`.

Logs: `/var/lib/agent-kit/gate/logs/<sha>.log` and `<sha>-out/`.
