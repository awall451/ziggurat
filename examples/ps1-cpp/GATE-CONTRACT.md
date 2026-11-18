# Gate contract

Read-only. How work reaches `main`.

## Submitting

1. Commit your work on a branch based on the **current** gate main:
   `git fetch gate && git rebase gate/main`.
2. Create (or move) a branch named `ready/<topic>` pointing at that commit:
   `git branch -f ready/<topic> HEAD`. No push needed: the gate reads your
   workspace every ~2 minutes.
3. Check the verdict: `gate-status` (or `gate-status <topic>`): `merged`,
   `failed` (failing step + log path) or `rejected` (rebase and move the ready
   branch). Lower branches of a merged stack show as merged.
4. After a merge, delete the ready branch: `git branch -D ready/<topic>`.

`gate/main` is the only real main. Reset your local copy with
`git fetch gate && git checkout main && git reset --hard gate/main`.

## What the gate runs (separate user, fresh checkout, plain Linux host)

| Step | Rule |
|---|---|
| test | `make test`: doctest host tests (sanitizers) + tools pytest. Passed-test count (doctest cases + pytest tests) must not drop below main's |
| ps1 | `make ps1`: the PS1 executable builds with the pinned psyqo |
| test-emu | `make test-emu`: the self-test playthrough passes in headless PCSX-Redux on OpenBIOS |
| iso | `make iso`: the disc image builds |

The gate writes its own `config.local.mk` (`PCSX_REDUX_CLI`, `winpath = $(1)`);
do not rely on a committed one. Logs: `/var/lib/agent-kit/gate/logs/<sha>.log`
and `<sha>-out/`. The toolchain is at `/opt/psx`, the emulator at
`/opt/pcsx-redux`; both are read-only.

If a check is wrong or you need a new one (for example a screenshot check once
frames can be rendered), write an escalation.
