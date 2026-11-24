// A light highlighter for the shell commands the lead runs (Chat tab steps):
// the command names, flags, strings, pipes and comments get their own colour.
// Everything is escaped first; only our own spans are added.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const TOKEN = /("(?:[^"\\]|\\.)*"?|'[^']*'?)|(#[^\n]*)|(\|\||&&|[|;]|>>?|<)|(\s+)|(--?[A-Za-z0-9][\w-]*(?:=\S*)?)|([^\s|;&<>"'#]+|[&#])/g;

/** HTML for a shell command: escaped text in spans of class hl-cmd, hl-flag, hl-str, hl-op, hl-com. */
export function highlightShell(src) {
  let out = '';
  let start = true; // the next word is a command name
  for (const m of String(src || '').matchAll(TOKEN)) {
    const [all, str, com, op, ws, flag] = m;
    if (str) out += `<span class="hl-str">${esc(str)}</span>`;
    else if (com) out += `<span class="hl-com">${esc(com)}</span>`;
    else if (op) {
      out += `<span class="hl-op">${esc(op)}</span>`;
      start = true;
      continue;
    } else if (ws) {
      out += ws.includes('\n') ? ws : esc(ws);
      if (ws.includes('\n')) start = true;
      continue;
    } else if (flag) out += `<span class="hl-flag">${esc(flag)}</span>`;
    else if (start && /^[A-Za-z_][\w.\/-]*$/.test(all) && !/=/.test(all)) out += `<span class="hl-cmd">${esc(all)}</span>`;
    else out += esc(all);
    start = false;
  }
  return out;
}
