// Agents hold a Claude subscription token in their environment. One that
// prints its environment writes the token into its transcript, and the console
// shows transcript text. Anything shaped like such a token is hidden before
// text leaves the server.
const TOKEN_RE = /sk-ant-[a-z]{2,6}[0-9]{0,2}-[A-Za-z0-9_-]{16,}/g;

export function maskSecrets(text) {
  return typeof text === 'string' && text.includes('sk-ant-') ? text.replace(TOKEN_RE, 'sk-ant-…[hidden by the console]') : text;
}
