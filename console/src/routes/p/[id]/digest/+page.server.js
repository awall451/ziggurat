import { redirect } from '@sveltejs/kit';

/** The daily digest became a brief per cycle: old links land there. */
export function load({ params }) {
  redirect(301, `/p/${params.id}/briefs`);
}
