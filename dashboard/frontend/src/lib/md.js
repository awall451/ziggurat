import { marked } from 'marked'
import DOMPurify from 'dompurify'

// Full markdown (STATE, journal, digests) rendered safely: agent-written text
// is untrusted, so everything goes through DOMPurify.
export function md(src) {
  return DOMPurify.sanitize(marked.parse(src || '', { gfm: true, breaks: false }))
}
