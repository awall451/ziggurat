import { timeline } from '$lib/server/schedule.js';

export async function load({ url }) {
  return { timeline: await timeline({ view: url.searchParams.get('view') || 'week', date: url.searchParams.get('date') }) };
}
