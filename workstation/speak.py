#!/usr/bin/env python3
"""Render a spoken digest script to mp3 with edge-tts (same voice and
hardening as an earlier project's narrator).

Usage: speak.py <script.txt> <out.mp3>
Env:   FLEET_TTS_VOICE (default en-US-AndrewNeural)

Writes to a temp file and renames only a complete take into place, so a
failed or truncated synthesis never leaves a broken mp3 behind.
"""
import asyncio
import os
import pathlib
import re
import sys
import time

import edge_tts

VOICE = os.environ.get("FLEET_TTS_VOICE", "en-US-AndrewNeural")
RETRY_WAITS = (5, 20, 60)
MIN_BYTES_PER_CHAR = 64   # real takes run ~360 B/char; less = truncated

# Names the voice guesses badly from spelling (Tolkien theme names included;
# add your own theme's names here).
PRONOUNCE = [
    (r"\bEru\b", "Eh-roo"),
    (r"\bAinur\b", "Eye-noor"),
    (r"\bAinu\b", "Eye-noo"),
    (r"\bMaiar\b", "My-ar"),
    (r"\bOakhollow\b", "Oak-hollow"),
]


def prepare(text: str) -> str:
    s = re.sub(r"`([^`]*)`", r"\1", text)
    s = re.sub(r"[*_#]+", "", s)
    s = s.replace("->", ", then ").replace("→", ", then ").replace("—", ", ")
    for pat, rep in PRONOUNCE:
        s = re.sub(pat, rep, s)
    return re.sub(r"[ \t]+", " ", s).strip()


def main():
    src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
    text = prepare(src.read_text())
    tmp = out.with_name(out.name + ".part")
    try:
        for wait in (*RETRY_WAITS, None):
            try:
                asyncio.run(edge_tts.Communicate(text, VOICE).save(str(tmp)))
                size = tmp.stat().st_size
                if size < MIN_BYTES_PER_CHAR * len(text):
                    raise RuntimeError(f"take too short: {size} bytes for {len(text)} chars")
                break
            except Exception as e:
                if wait is None:
                    raise
                print(f"! tts: {type(e).__name__}: {e}; retrying in {wait}s", file=sys.stderr)
                time.sleep(wait)
        os.replace(tmp, out)
    finally:
        tmp.unlink(missing_ok=True)
    print(f"spoke {len(text)} chars -> {out}")


if __name__ == "__main__":
    main()
