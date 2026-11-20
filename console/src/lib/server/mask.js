// Agents hold a Claude subscription token in their environment. One that
// prints its environment writes the token into its transcript, and the console
// shows transcript text. Anything shaped like such a token is hidden before
// text leaves the server. The same goes for a private key block and for a
// password or token written into an address (https://user:secret@host).
const TOKEN_RE = /sk-ant-[a-z]{2,6}[0-9]{0,2}-[A-Za-z0-9_-]{16,}/g;
const KEY_RE = /-----BEGIN ([A-Z0-9 ]{0,30})PRIVATE KEY-----[\s\S]*?(-----END \1PRIVATE KEY-----|$)/g;
const URL_SECRET_RE = /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s/:@]{1,100}):[^\s/@]{1,300}@/gi;

export function maskSecrets(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  if (out.includes('sk-ant-')) out = out.replace(TOKEN_RE, 'sk-ant-…[hidden by the console]');
  if (out.includes('PRIVATE KEY-----')) out = out.replace(KEY_RE, '[private key hidden by the console]');
  if (out.includes('://')) out = out.replace(URL_SECRET_RE, '$1:[hidden]@');
  return out;
}
