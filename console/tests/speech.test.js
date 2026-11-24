import { describe, it, expect } from 'vitest';
import { joinSpeech, speechError } from '../src/lib/speech.js';

describe('speech into the chat box', () => {
  it('adds a phrase with one space, capitalised where a sentence starts', () => {
    expect(joinSpeech('', 'what is the team doing')).toBe('What is the team doing');
    expect(joinSpeech('Hello.', 'how are you')).toBe('Hello. How are you');
    expect(joinSpeech('About the shop', 'and the map')).toBe('About the shop and the map');
    expect(joinSpeech('Line one\n', 'two')).toBe('Line one\ntwo');
    expect(joinSpeech('Keep', '   ')).toBe('Keep');
  });
  it('says why the microphone did not work', () => {
    expect(speechError('not-allowed')).toMatch(/blocked/);
    expect(speechError('aborted')).toBe('');
    expect(speechError('weird')).toMatch(/weird/);
  });
});
