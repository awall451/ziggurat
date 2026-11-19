// The one place that decides who is using the console. Today there is no
// login: the console is reachable only on the owner's private network, so
// every request is the owner. When an auth proxy sits in front, set
// CONSOLE_USER_HEADER to the header it adds (for example X-authentik-username)
// and requests without that header are refused.
const HEADER = process.env.CONSOLE_USER_HEADER || '';

export function userFor(request) {
  if (!HEADER) return { name: 'owner', via: 'none' };
  const name = (request.headers.get(HEADER) || '').trim();
  return name ? { name: name.slice(0, 80), via: 'proxy' } : null;
}
