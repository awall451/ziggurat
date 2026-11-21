// Shared by the Issues board, the issue pop-up and the new-issue form.
export const PRIORITIES = [
  ['urgent', 'Urgent'],
  ['high', 'High'],
  ['normal', 'Normal'],
  ['low', 'Low']
];
export const PRIORITY_WORD = Object.fromEntries(PRIORITIES);
export const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
export const KIND_WORD = { bug: 'Bug', polish: 'Polish', idea: 'Idea', planned: 'Planned' };
export const STATUS_WORD = { new: 'New', in_progress: 'In progress', done: 'Done', wontfix: "Won't fix" };
/** Most urgent first, then newest first. */
export const byPriority = (a, b) => (PRIORITY_RANK[a.priority || 'normal'] - PRIORITY_RANK[b.priority || 'normal']) || (a.id < b.id ? 1 : -1);
