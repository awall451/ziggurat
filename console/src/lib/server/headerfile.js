// Agent-written note files: `Key: value` lines, `---`, then free text. Read
// as data only: a regular file (no symlink), cut at 200 KB.
import fs from 'node:fs';

export function parseHeaderFile(file, max = 200_000) {
  let text;
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    text = fs.readFileSync(file, 'utf8').slice(0, max);
  } catch {
    return null;
  }
  const i = text.indexOf('\n---\n');
  const head = i >= 0 ? text.slice(0, i) : text;
  const fields = {};
  for (const line of head.split('\n')) {
    const j = line.indexOf(': ');
    if (j > 0) fields[line.slice(0, j).toLowerCase()] = line.slice(j + 2).trim();
  }
  return { fields, body: i >= 0 ? text.slice(i + 5).trim() : '' };
}
