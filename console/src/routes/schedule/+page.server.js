import { timeline } from '$lib/server/schedule.js';

export async function load({ url }) {
  const q = url.searchParams;
  return { timeline: await timeline({ view: q.get('view') || 'day', date: q.get('date'), from: q.get('from'), to: q.get('to') }) };
}
