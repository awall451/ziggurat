import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Notes, reports and digests are written inside a sandbox, so they are
// untrusted: everything goes through DOMPurify, and images or media that
// point at another host are dropped (fetching one would tell that host
// something through the owner's browser).
let hooked = false;

function hook() {
  if (hooked || typeof window === 'undefined') return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.hasAttribute?.('src')) {
      const src = node.getAttribute('src') || '';
      if (!/^(data:image\/|\/(?!\/))/.test(src)) node.removeAttribute('src');
    }
    if (node.tagName === 'A') {
      node.setAttribute('rel', 'noopener noreferrer');
      node.setAttribute('target', '_blank');
    }
  });
}

/** Markdown to safe HTML. Runs in the browser only; on the server it returns ''. */
export function md(src) {
  if (typeof window === 'undefined') return '';
  hook();
  return DOMPurify.sanitize(marked.parse(src || '', { gfm: true, breaks: false }), {
    FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed', 'svg', 'math'],
    FORBID_ATTR: ['style', 'srcset']
  });
}
