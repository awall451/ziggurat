#!/usr/bin/env python3
"""Build the fleet dashboard data: fleet/index.json and fleet/<box>/dashboard.json.

Inputs (all already on the workstation, pulled by kit/workstation/agent-pull):
  fleet/<box>/cycles.jsonl        lead cycle ledger (one JSON per cycle)
  fleet/<box>/history.log         gate verdicts ("<iso> <topic> <sha> <status> <detail>")
  fleet/<box>/control             run/stop switch as last seen
  fleet/<box>/notes/agents/*.md   the lead's STATE, JOURNAL, ESCALATIONS; issues/
  fleet/<box>/digests/<date>.md   morning digests (+ .mp3 when spoken)
  fleet/<box>/shots/<date>/*.png  gate screenshots of the newest passing build
  token tracker API (localhost:9420) for per-project usage

Stdlib only. Safe to run often (agent-pull runs it every 15 minutes).
"""
import datetime as dt
import json
import os
import pathlib
import re
import sys
import urllib.parse
import urllib.request

FLEET = pathlib.Path(os.environ.get("FLEET_DATA", pathlib.Path.home() / "ziggurat-data"))
CONF = pathlib.Path(os.environ.get("AGENT_BOXES_CONF", FLEET / "agent-boxes.conf"))
TRACKER = os.environ.get("TOKEN_TRACKER_URL", "")  # optional: a token tracker with /api/project
NOW = dt.datetime.now(dt.timezone.utc)


def read(p: pathlib.Path, default=""):
    try:
        return p.read_text(errors="replace")
    except OSError:
        return default


def parse_time(s):
    try:
        t = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
        return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)
    except (ValueError, AttributeError):
        return None


def tracker(path, **q):
    if not TRACKER:
        return None
    url = f"{TRACKER}{path}?{urllib.parse.urlencode(q)}"
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            return json.load(r)
    except Exception as e:  # tracker down must not break the page
        print(f"! tracker {path}: {e}", file=sys.stderr)
        return None


def cycles(box_dir):
    out = []
    for line in read(box_dir / "cycles.jsonl").splitlines():
        try:
            c = json.loads(line)
        except ValueError:
            continue
        out.append({k: c.get(k) for k in ("start", "end", "secs", "rc", "cost_usd", "turns", "summary")})
    return out


GATE_RE = re.compile(r"^(\S+) (\S+) (\S+) (\S+) ?(.*)$")


def gate(box_dir):
    rows = []
    for line in read(box_dir / "history.log").splitlines():
        m = GATE_RE.match(line)
        if not m:
            continue
        at, topic, sha, status, detail = m.groups()
        tests = re.search(r"\((\d+) tests\)", detail)
        rows.append({"at": at, "topic": topic, "sha": sha[:9], "status": status,
                     "detail": detail, "tests": int(tests.group(1)) if tests else None,
                     "canary": topic.startswith("canary")})
    return rows


FM_RE = re.compile(r"^---\n(.*?)\n---\n?(.*)$", re.S)


def issues(box_dir):
    out = []
    for p in sorted((box_dir / "notes" / "agents" / "issues").glob("*.md")):
        text = read(p)
        meta, body = {}, text
        m = FM_RE.match(text)
        if m:
            for line in m.group(1).splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    meta[k.strip()] = v.strip()
            body = m.group(2)
        status = meta.get("status", "open").lower()
        out.append({"file": p.name, "id": meta.get("id", p.stem.split("-")[0]),
                    "title": meta.get("title", p.stem), "severity": meta.get("severity", "n/a"),
                    "area": meta.get("area", ""), "status": status,
                    "excerpt": body.strip()[:600]})
    return out


def digests(box_dir):
    d = box_dir / "digests"
    out = []
    for md in sorted(d.glob("????-??-??.md"), reverse=True):
        date = md.stem
        out.append({"date": date, "md": read(md),
                    "mp3": (d / f"{date}.mp3").exists()})
    return out


def shots(box_dir):
    out = {}
    for day in sorted((box_dir / "shots").glob("????-??-??")):
        files = sorted(f.name for f in day.glob("*.png"))
        if files:
            out[day.name] = files
    return out


def usage(project):
    p30 = tracker("/api/project", name=project, range="30d")
    p7 = tracker("/api/project", name=project, range="7d")
    if not p30:
        return None
    since = (NOW - dt.timedelta(hours=24)).timestamp() * 1000
    recent = []
    for s in (p7 or {}).get("sessions", []):
        if (s.get("last_ts") or 0) >= since:
            recent.append({"name": s.get("session_name") or s.get("session_id"),
                           "subagent": s.get("is_subagent"), "api_usd": s.get("api_usd"),
                           "turns": s.get("turns"), "models": s.get("models"),
                           "lines_added": s.get("lines_added"), "last_ts": s.get("last_ts")})
    recent.sort(key=lambda s: -(s["api_usd"] or 0))
    return {"summary_30d": p30.get("summary"), "daily": p30.get("daily", []), "recent_sessions": recent}


def trials(box_dir):
    """Supervised trial runs: fleet/<box>/trials/<name>-result.json, compared with
    baseline-old-model.json; optional trials/<name>/{before,after}/*.png and lead-summary.md."""
    tdir = box_dir / "trials"
    base_p = tdir / "baseline-old-model.json"
    base = json.loads(read(base_p)) if base_p.exists() else None
    out = []
    for rp in sorted(tdir.glob("*-result.json")):
        name = rp.name[: -len("-result.json")]
        r = json.loads(read(rp))
        d = tdir / name
        before = sorted(f.name for f in (d / "before").glob("*.png")) if (d / "before").is_dir() else []
        after = sorted(f.name for f in (d / "after").glob("*.png")) if (d / "after").is_dir() else []
        out.append({"name": name, "result": r, "baseline": base,
                    "summary_md": read(d / "lead-summary.md"),
                    "before": before, "after": after,
                    "new_screens": [f for f in after if f not in before]})
    return out


def build_box(box):
    bd = FLEET / box
    bd.mkdir(parents=True, exist_ok=True)
    cyc, gt = cycles(bd), gate(bd)
    since = NOW - dt.timedelta(hours=24)
    c24 = [c for c in cyc if (parse_time(c.get("start") or "") or NOW) >= since]
    g24 = [g for g in gt if (parse_time(g["at"]) or NOW) >= since and not g["canary"]]
    tests = [{"at": g["at"], "tests": g["tests"]} for g in gt if g["tests"] is not None]
    iss = issues(bd)
    esc = read(bd / "notes" / "agents" / "ESCALATIONS.md").strip()
    control = read(bd / "control").strip() or "unknown"
    last = cyc[-1] if cyc else None
    data = {
        "box": box,
        "generated_at": NOW.isoformat(timespec="seconds"),
        "status": {
            "control": control,
            "paused": control.startswith("stop"),
            "last_cycle": last,
            "minutes_since_last_cycle": round((NOW - parse_time(last["end"])).total_seconds() / 60)
                if last and parse_time(last.get("end") or "") else None,
        },
        "last24": {
            "cycles": len(c24),
            "api_usd": round(sum((c.get("cost_usd") or 0) for c in c24), 2),
            "merged": sum(1 for g in g24 if g["status"] == "merged" and "contained" not in g["detail"]),
            "failed": sum(1 for g in g24 if g["status"] in ("failed", "rejected")),
            "minutes": round(sum((c.get("secs") or 0) for c in c24) / 60),
        },
        "tests_now": tests[-1]["tests"] if tests else None,
        "tests_series": tests,
        "cycles": cyc,
        "gate": gt[::-1][:60],
        "issues": iss,
        "issues_open": sum(1 for i in iss if i["status"] not in ("closed", "fixed", "done")
                           and i["severity"] != "n/a"),
        "escalations_md": esc,
        "escalations_count": len(re.findall(r"^##\s", esc, re.M)),
        "state_md": read(bd / "notes" / "agents" / "STATE.md"),
        "journal_md": read(bd / "notes" / "agents" / "JOURNAL.md")[-6000:],
        "digests": digests(bd),
        "shots": shots(bd),
        "usage": usage(f"/home/agent/{box}"),
        "trials": trials(bd),
    }
    (bd / "dashboard.json").write_text(json.dumps(data, indent=1))
    return {"box": box, "paused": data["status"]["paused"], "last24": data["last24"]}


def main():
    boxes = []
    for line in read(CONF).splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            boxes.append(build_box(line.split()[0]))
    (FLEET / "index.json").write_text(json.dumps(
        {"generated_at": NOW.isoformat(timespec="seconds"), "boxes": boxes}, indent=1))
    print(f"published {len(boxes)} box(es)")


if __name__ == "__main__":
    main()
