// A run's events are JSON lines appended to one file by the Ansible callback
// and by the runner. This reads them: all at once, or as a live stream that
// starts at a byte offset so a reload or a reconnect continues where it was.
import fs from 'node:fs';

/** Whole lines from `offset` on: {events: [{at, event}], next}. `at` = offset just after the line. */
export function readFrom(file, offset = 0) {
  let buf;
  try {
    const size = fs.statSync(file).size;
    if (offset >= size) return { events: [], next: Math.min(offset, size) };
    const fd = fs.openSync(file, 'r');
    try {
      buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { events: [], next: offset };
  }
  const events = [];
  let pos = 0;
  for (;;) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) break; // a half-written last line waits for the next read
    const line = buf.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    if (!line.trim()) continue;
    try {
      events.push({ at: offset + pos, event: JSON.parse(line) });
    } catch {
      /* skip a damaged line */
    }
  }
  return { events, next: offset + pos };
}

export function readAll(file) {
  return readFrom(file, 0).events.map((e) => e.event);
}

/**
 * Server-sent events for one run. Ends after the run's `done` event, or when
 * the run is no longer active and the file has been read to its end.
 */
export function stream(file, { offset = 0, isActive = () => false, pollMs = 300 } = {}) {
  let timer = null;
  let idleSince = 0;
  let beat = 0;
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      let pos = offset;
      const stop = () => {
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const tick = () => {
        try {
          const { events, next } = readFrom(file, pos);
          pos = next;
          for (const { at, event } of events) {
            controller.enqueue(enc.encode(`id: ${at}\nevent: ${String(event.type).replace(/[^a-z_]/g, '')}\ndata: ${JSON.stringify(event)}\n\n`));
            if (event.type === 'done') return stop();
          }
          if (events.length) idleSince = 0;
          else if (!isActive()) {
            // Not running and nothing new: give a late writer two seconds, then end.
            idleSince ||= Date.now();
            if (Date.now() - idleSince > 2000) return stop();
          }
          if (Date.now() - beat > 15000) {
            beat = Date.now();
            controller.enqueue(enc.encode(': ping\n\n'));
          }
        } catch {
          stop();
        }
      };
      beat = Date.now();
      tick();
      timer = setInterval(tick, pollMs);
    },
    cancel() {
      clearInterval(timer);
    }
  });
}
