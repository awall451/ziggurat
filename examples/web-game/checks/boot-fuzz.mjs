#!/usr/bin/env node
/**
 * Gate-owned, content-agnostic check. Agents cannot edit this file.
 * Copied into the candidate worktree by the gate and run there (so
 * `playwright` resolves from the candidate's node_modules).
 *
 *   node .gate/boot-fuzz.mjs <baseUrl> <outDir>
 *
 * Contract the game must keep (see GATE-CONTRACT.md):
 *   window.game.state            -> null on title, object with .map/.x/.y/.party after New Game
 *   window.game.scenes.top       -> current scene object (constructor name used)
 *   window.game.scenes.depth     -> number of stacked scenes
 *   Enter on the title starts or continues a game; C opens the menu, Escape closes it.
 *
 * Checks:
 *   1. boots with zero console errors / page errors
 *   2. Enter from title reaches a playable map (state != null)
 *   3. arrow keys move the player at least once in 4 directions x 3 taps
 *   4. menu opens (depth grows) and closes again
 *   5. 60 s random-input fuzz: no errors, game loop keeps drawing (canvas changes)
 * Exit 0 = pass. Screenshots go to <outDir>.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:5190";
const out = process.argv[3] ?? "tools/out/gate";
mkdirSync(out, { recursive: true });

let failed = 0;
const check = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failed++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 768, height: 672 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

const wait = (ms) => page.waitForTimeout(ms);
const tap = async (key, hold = 40) => { await page.keyboard.down(key); await wait(hold); await page.keyboard.up(key); await wait(120); };
const snap = (n) => page.screenshot({ path: `${out}/${n}.png` });
const st = () => page.evaluate(() => {
  const g = window.game; if (!g) return { noGame: true };
  const s = g.state;
  return { hasState: !!s, map: s?.map, x: s?.x, y: s?.y, depth: g.scenes?.depth, top: g.scenes?.top?.constructor?.name };
});
const canvasHash = () => page.evaluate(() => {
  const c = document.querySelector("canvas"); if (!c) return "nocanvas";
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0; return String(h);
});

try {
  await page.goto(base, { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });
  await wait(1200);
  await snap("01-boot");
  let s = await st();
  check(!s.noGame, "window.game exposed");
  check(errors.length === 0, `boot without errors (${errors.slice(0, 3).join(" | ")})`);

  // New game
  for (let i = 0; i < 4 && !(await st()).hasState; i++) { await tap("Enter"); await wait(700); }
  // Clear any opening dialogue
  for (let i = 0; i < 40 && (await st()).depth > 1; i++) { await tap("Enter"); await wait(250); }
  s = await st();
  await snap("02-new-game");
  check(s.hasState && typeof s.map === "string", `new game reaches a map (${JSON.stringify(s)})`);

  // Movement
  const start = await st(); let moved = false;
  for (const k of ["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"]) {
    for (let i = 0; i < 3; i++) await tap(k, 60);
    const now = await st();
    if (now.x !== start.x || now.y !== start.y || now.map !== start.map) moved = true;
    for (let i = 0; i < 20 && (await st()).depth > 1; i++) { await tap("Enter"); await wait(200); }
  }
  check(moved, "player can move");

  // Menu
  const d0 = (await st()).depth;
  await tap("KeyC"); await wait(400);
  const d1 = (await st()).depth;
  await snap("03-menu");
  await tap("Escape"); await wait(300);
  for (let i = 0; i < 5 && (await st()).depth > d0; i++) { await tap("Escape"); await wait(250); }
  const d2 = (await st()).depth;
  check(d1 > d0, `menu opens (depth ${d0} -> ${d1})`);
  check(d2 === d0, `menu closes (depth back to ${d2})`);

  // Fuzz
  const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Enter", "KeyX", "KeyC", "Escape"];
  let seed = 1337; const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const hashes = new Set(); const t0 = Date.now(); let n = 0;
  while (Date.now() - t0 < 60000) {
    await tap(keys[Math.floor(rnd() * keys.length)], 30 + Math.floor(rnd() * 200));
    if (++n % 25 === 0) { hashes.add(await canvasHash()); }
    if (errors.length) break;
  }
  await snap("04-after-fuzz");
  check(errors.length === 0, `60s fuzz without errors (${n} inputs) ${errors.slice(0, 3).join(" | ")}`);
  check(hashes.size >= 3, `screen keeps changing during fuzz (${hashes.size} distinct frames)`);
} catch (e) {
  check(false, `crashed: ${e}`);
} finally {
  await browser.close();
}
console.log(failed ? `GATE CHECK FAILED (${failed})` : "GATE CHECK OK");
process.exit(failed ? 1 : 0);
