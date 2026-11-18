# Lessons (paid for already)

## Design

- **The gate is the product.** The research and our runs agree: an agent judging its own work is lenient, and vision models miss most small visual changes. Put the definition of done where the worker cannot edit it, and make it mechanical.
- **Delegation depth works for planning, not for typing.** Most spend was long Opus sessions re-reading 10–25 million tokens of context while doing hands-on work. Opus leads plus Sonnet builders plus Haiku scouts moved that work to cheaper models; per-session Opus context dropped to about 4 million tokens.
- **Light lead review + independent review for risky branches** keeps quality without paying for a full second review on every branch.
- **Watch for loosened tests.** In one cycle reviewers accepted a looser size check. The test *count* rose, so the gate passed. Consider gating on specific protected checks, not only on counts.

## Headless operation

- A headless cycle ends when the lead's final message is sent; **background subagents are killed with it.** Run everything in the foreground.
- Count only real work toward daily caps. Usage-limit failures must be retried, not burn the cap, or the team stalls until the next day after a 5-hour reset.
- Leftover worktrees from an interrupted cycle are normal; the lead's first step is to resume or remove them.

## Sandbox and tooling

- Download toolchains on the host and copy them in; the allow-list never has to grow. Serve git submodules from a local mirror with `url.<mirror>.insteadOf`.
- Some installers redirect to general cloud storage (for example browser downloads for Playwright). Do not allow-list general storage; open it for a one-off install and close it again.
- Ubuntu 24.04 blocks unprivileged user namespaces, so Claude Code's subprocess credential scrubbing (needs bubblewrap) fails inside the VM. The VM boundary is the protection; scrubbing adds little when the login is a file the agent user can read anyway.
- `git config --replace-all safe.directory` wipes other entries; add entries only if missing.
- Shell loops that call `ssh`/`rsync` must read their list from another file descriptor; `ssh` eats stdin, and `ssh -n` breaks rsync.
- Repos built on Windows carry stale dependency files with Windows paths; clean generated artifacts (`make clean`, `git clean -X` in submodules) before the first Linux build.
- Rendering many emulator screenshots is slow (minutes); give that gate step a generous timeout and make it best-effort.

## Working with the owner

- Pause and resume must be one command (`agent-kit-stop`, timer enable/disable).
- Run single supervised cycles after any change to the team or prompts, and measure them against a baseline before turning the timer back on.
- Long supervising chat sessions are expensive: every message re-reads the whole context. Keep handoff notes and start fresh sessions.
