// Speech to text for the chat boxes (issue 47): the browser's own speech
// recognition. Words are only ever added to the text box; nothing is sent.

/** The text box after a spoken phrase: one space between, a capital after a full stop or an empty box. */
export function joinSpeech(before, said) {
  const s = String(said || '').trim();
  if (!s) return before || '';
  const b = String(before || '');
  const startsNew = !b.trim() || /[.!?]\s*$/.test(b);
  const phrase = startsNew ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  if (!b) return phrase;
  return /\s$/.test(b) ? b + phrase : `${b} ${phrase}`;
}

/** Why the microphone did not work, in words the owner can act on. */
export function speechError(code) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'The browser blocked the microphone. Allow it for this site in the address bar.';
    case 'no-speech':
      return 'Heard nothing. Tap the microphone and speak.';
    case 'audio-capture':
      return 'No microphone found.';
    case 'network':
      return "The browser's speech service could not be reached.";
    case 'aborted':
      return '';
    default:
      return code ? `The microphone stopped (${code}).` : '';
  }
}
