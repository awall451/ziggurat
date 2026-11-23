import { focusNowSoon, reconcileFocus } from '$lib/server/focus.js';

/**
 * For every page: the team in focus, if any (the bar under the header shows
 * it). Pauses whose focus has ended are ended here too, at most once a minute.
 */
export async function load() {
  reconcileFocus();
  return { focusNow: await focusNowSoon() };
}
