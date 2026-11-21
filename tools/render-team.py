#!/usr/bin/env python3
"""Render a project folder for a chosen theme.

Agent ids (area-lead-engine, builder, scout, reviewer, qa) never change; a
theme only changes the display names used in prose ({{lead}}, {{area_lead}},
{{area_leads}}, {{worker}}, {{workers}}, {{scout}},
{{scouts}}, {{reviewer}}, {{qa}}).

Usage: tools/render-team.py examples/ps1-cpp --theme tolkien --out build/my-project
       (theme = a name in themes/ or a path to a .yml file)
       A team template (templates/) has a {{goal}} slot in its charter: pass the
       owner's goal with --goal-file <path>. It is inserted as written, never
       rendered itself.
"""
import argparse, pathlib, re, shutil, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TOKEN = re.compile(r"\{\{\s*([a-z_]+)\s*\}\}")


def load_theme(arg):
    p = pathlib.Path(arg)
    if not p.exists():
        p = ROOT / "themes" / f"{arg}.yml"
    if not p.exists():
        sys.exit(f"theme not found: {arg} (available: {', '.join(t.stem for t in (ROOT / 'themes').glob('*.yml'))})")
    names = {}
    for line in p.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if ":" in line:
            k, v = line.split(":", 1)
            names[k.strip()] = v.strip()
    return names


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("--theme", default="plain"); ap.add_argument("--out", required=True)
    ap.add_argument("--goal-file")
    a = ap.parse_args()
    names = load_theme(a.theme)
    names.pop("goal", None)  # a theme never sets the goal
    if a.goal_file:
        names["goal"] = pathlib.Path(a.goal_file).read_text().strip()
    src, out = pathlib.Path(a.src), pathlib.Path(a.out)
    if out.exists():
        sys.exit(f"{out} exists; choose a new --out")
    shutil.copytree(src, out)
    missing = set()
    for f in out.rglob("*.md"):
        text = f.read_text()
        def rep(m):
            k = m.group(1)
            if k not in names:
                missing.add(k)
                return m.group(0)
            return names[k]
        f.write_text(TOKEN.sub(rep, text))
    if missing:
        sys.exit(f"theme is missing names for: {', '.join(sorted(missing))}")
    print(f"rendered {src} with theme '{a.theme}' -> {out}")


if __name__ == "__main__":
    main()
