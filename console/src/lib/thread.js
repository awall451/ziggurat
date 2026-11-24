// The comments thread of an issue (issue 75): the owner's comments (stored
// as `notes`), the lead's comments (from its updates, `comments`) and the
// status changes, oldest first. Updates from before kit 0.32 were not kept as
// comments: their text is in the history, and comes in from there.

const t = (iso) => Date.parse(iso) || 0;

/**
 * @returns {Array<{type:'comment'|'event', at:string, by:'boss'|'lead', text?:string,
 *   status?:string, from?:string, to?:string, who?:string, delivered?:boolean, error?:string|null}>}
 */
export function thread(issue) {
  const out = [];
  for (const n of issue?.notes || []) {
    out.push({ type: 'comment', at: n.at, by: 'boss', text: n.text, delivered: n.delivered !== false, error: n.error || null });
  }
  const lead = issue?.comments || [];
  for (const c of lead) {
    if (c.text) out.push({ type: 'comment', at: c.at, by: 'lead', text: c.text, status: c.status });
  }
  const leadAt = new Set(lead.map((c) => c.at));
  for (const h of issue?.history || []) {
    if (!h.from) continue; // raised, edited, files added: not part of the thread
    if (h.from === h.to) continue;
    out.push({ type: 'event', at: h.at, by: h.who === 'lead' ? 'lead' : 'boss', from: h.from, to: h.to, who: h.who });
    // What was said with the move: the owner's reason, or a lead update from
    // before kit 0.32 (its text only lives here).
    const by = h.who === 'lead' ? 'lead' : 'boss';
    if (h.note && !(by === 'lead' && leadAt.has(h.at))) out.push({ type: 'comment', at: h.at, by, text: h.note, status: h.to, delivered: true });
  }
  // Oldest first; at the same moment the status change comes before the comment that came with it.
  return out
    .map((x, i) => ({ x, i }))
    .sort((a, b) => t(a.x.at) - t(b.x.at) || (a.x.type === b.x.type ? a.i - b.i : a.x.type === 'event' ? -1 : 1))
    .map(({ x }) => x);
}
