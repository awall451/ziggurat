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
| install | `npm ci` from the lockfile |
| typecheck | `npm run typecheck` |
| unit | `vitest run`; passed-test count must not drop below main's |
| build | `vite build` |
| boot-fuzz | gate-owned: boot with no console errors, New Game reaches a map, player moves, menu opens/closes, 60 s random input with no errors and a live screen |
| smoke | the repo's own `tools/smoke.mjs` (yours to maintain as content changes) |

Logs and screenshots: `/var/lib/agent-kit/gate/logs/<sha>.log` and `<sha>-out/`.

## Debug contract the game must keep

- `window.game` exists after load.
- `window.game.state` is `null`/falsy on the title screen and an object with
  `map` (string), `x`, `y` (numbers) and `party` once a game is running.
- `window.game.scenes.top` is the current scene object, `window.game.scenes.depth`
  the number of stacked scenes.
- From the title, `Enter` starts (or continues) a game. `C` opens the menu,
  `Escape` closes it.

If you need to change this contract, write an escalation first.
