<script>
  // Talk instead of type (issue 47): the browser's speech recognition puts
  // the words into the text box, where they can be changed before Send.
  // Tap to start, tap again to stop; it never sends. Hidden where the
  // browser has no speech recognition; it needs HTTPS (or localhost).
  import { onMount } from 'svelte';
  import { joinSpeech, speechError } from '$lib/speech.js';

  let { text = $bindable(''), disabled = false, interim = $bindable(''), problem = $bindable('') } = $props();

  let Rec = $state(null);
  let secure = $state(true);
  let rec = null;
  let listening = $state(false);

  onMount(() => {
    Rec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    secure = window.isSecureContext;
    return () => rec?.abort();
  });

  function start() {
    problem = '';
    interim = '';
    rec = new Rec();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    rec.onresult = (e) => {
      let now = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) text = joinSpeech(text, r[0].transcript);
        else now += r[0].transcript;
      }
      interim = now;
    };
    rec.onerror = (e) => {
      problem = speechError(e.error);
    };
    rec.onend = () => {
      listening = false;
      interim = '';
      rec = null;
    };
    try {
      rec.start();
      listening = true;
    } catch (e) {
      problem = speechError(e?.name === 'NotAllowedError' ? 'not-allowed' : e?.message || 'start');
      rec = null;
    }
  }
  function toggle() {
    if (listening) rec?.stop();
    else start();
  }
</script>

{#if Rec}
  <button
    class="btn quiet sm mic"
    class:on={listening}
    disabled={!secure || (disabled && !listening)}
    title={!secure ? 'The microphone needs HTTPS' : listening ? 'Stop listening' : 'Speak instead of typing (nothing is sent until you press Send)'}
    aria-label={listening ? 'Stop listening' : 'Speak'}
    aria-pressed={listening}
    onclick={toggle}
  >
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11 a7 7 0 0 0 14 0 M12 18 V21" />
    </svg>
    {#if listening}<span class="dot"></span>Listening…{/if}
  </button>
{/if}

<style>
  .mic {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .mic.on {
    border-color: var(--critical);
    color: var(--ink-strong);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--critical);
    animation: pulse 1s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.25;
    }
  }
</style>
