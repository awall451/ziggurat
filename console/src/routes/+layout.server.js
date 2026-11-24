import { focusAllSoon, reconcileFocus } from '$lib/server/focus.js';

/**
 * For every page: every team in focus (the bar under the header shows
 * them). Pauses whose focus has ended are ended here too, at most once a minute.
 */
export async function load() {
  reconcileFocus();
  return { focusAll: await focusAllSoon() };
}
