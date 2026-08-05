// Helpers for the rich text content produced by <RichTextEditor>.
//
// Kept out of the component files so those export components only — mixing
// non-component exports in breaks React Fast Refresh for the whole module.

/**
 * Quill's "empty" document is `<p><br></p>`, not an empty string, so a plain
 * `.trim()` check on the editor's value is always truthy and would let an
 * empty announcement through.
 */
export const isRichTextEmpty = (html) =>
  !String(html || '')
    .replace(/<(p|div|br|span)[^>]*>/gi, '')
    .replace(/<\/(p|div|span)>/gi, '')
    .replace(/&nbsp;/gi, '')
    .replace(/\s/g, '').length;

/**
 * Flattens rich text to one line for places that cannot render markup —
 * table cells, list previews, notification titles.
 */
export function richTextToPlain(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
