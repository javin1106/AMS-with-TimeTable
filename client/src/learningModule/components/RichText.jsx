import React, { useMemo } from 'react';
import { Box, Text } from '@chakra-ui/react';
import createDOMPurify from 'dompurify';
import Markdown from './Markdown';

/**
 * Renders content authored in <RichTextEditor>.
 *
 * Sanitisation happens **here, at render time**, rather than on save. That is
 * deliberate: the client is not a security boundary — anyone can POST raw HTML
 * straight to the API — so trusting stored content would be unsafe no matter
 * what the editor sends. Sanitising every time we render is the guarantee that
 * actually holds.
 *
 * Three content shapes reach this component, because the module predates the
 * rich editor and AI generation produces Markdown:
 *
 *   HTML      → sanitised and rendered (anything the editor produced)
 *   Markdown  → handed to <Markdown> (AI-generated notes and tutorials)
 *   plain     → rendered with newlines preserved (older posts, pasted text)
 *
 * Detection is a cheap tag sniff. It only has to separate editor output from
 * the other two, and Quill always emits at least a block-level wrapper.
 */

const HTML_PATTERN = /<(p|div|h[1-6]|ul|ol|li|br|strong|em|u|s|sub|sup|blockquote|pre|img|a|span|table)\b/i;

// Markdown that is unambiguous enough to be worth routing to the Markdown
// renderer: an ATX heading, a fenced block, a bullet or a table pipe row.
const MARKDOWN_PATTERN = /(^|\n)\s{0,3}(#{1,6}\s|```|[-*+]\s|\d+\.\s|\|.*\|)/;

const SANITISE_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'div', 'span',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'b', 'em', 'i', 'u', 's', 'del',
    'sub', 'sup',
    'ul', 'ol', 'li',
    'blockquote', 'pre', 'code',
    'a', 'img',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'hr',
  ],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'src', 'alt', 'title', 'class', 'style', 'colspan', 'rowspan'],
  // `data:image/svg+xml` is deliberately absent. An SVG loaded through <img> is
  // a sandboxed image context in current browsers and will not run its scripts,
  // but it is attack surface bought for nothing: Quill never produces one, so
  // the only source would be someone hand-posting HTML to the API.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|data:image\/(?:png|jpe?g|gif|webp));?|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  ADD_ATTR: ['target', 'rel'],
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'srcset', 'formaction'],
};

/**
 * CSS properties an author may set inline.
 *
 * DOMPurify strips scripting but passes `style` through largely intact, and a
 * style attribute alone is enough to do damage without a single line of
 * JavaScript: `position:fixed;width:100vw;height:100vh;z-index:9999` on a
 * comment in the class stream covers the entire page, and wrapped in a link it
 * becomes an in-page phishing overlay. Nobody needs positioning to write an
 * answer, so the allowlist is what Quill actually emits and nothing else.
 */
const ALLOWED_CSS = new Set([
  'color',
  'background-color',
  'font-size',
  'font-family',
  'font-weight',
  'font-style',
  'text-align',
  'text-decoration',
  'line-height',
  'padding-left',
  'margin-left',
  'vertical-align',
  'white-space',
]);

const safeStyle = (value) =>
  String(value)
    .split(';')
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .filter((declaration) => {
      const [property, ...rest] = declaration.split(':');
      const body = rest.join(':');
      if (!ALLOWED_CSS.has(property.trim().toLowerCase())) return false;
      // Even on an allowed property: no url() and no expression(). `url()` in
      // CSS cannot execute script in any current browser, but it can silently
      // fetch a remote resource, which turns reading a comment into a beacon.
      return !/url\s*\(|expression\s*\(|@import/i.test(body);
    })
    .map((declaration) => declaration.trim())
    .join('; ');

/**
 * A DOMPurify instance of our own.
 *
 * Hooks are registered per instance, and the default export is shared with
 * every other module in this app. Adding the style filter to it would silently
 * change how the conference, review and timetable modules sanitise their
 * content — an improvement, probably, but not this module's call to make.
 */
const purify = createDOMPurify(window);

purify.addHook('afterSanitizeAttributes', (node) => {
  if (node.hasAttribute?.('style')) {
    const cleaned = safeStyle(node.getAttribute('style'));
    if (cleaned) node.setAttribute('style', cleaned);
    else node.removeAttribute('style');
  }

  // A link opening in a new tab hands the opener to the target page unless
  // told otherwise, which is a redirect of the still-signed-in original.
  if (node.tagName === 'A' && node.getAttribute('target')) {
    node.setAttribute('rel', 'noopener noreferrer');
  }

  // ALLOWED_URI_REGEXP does not govern this. DOMPurify special-cases `data:` on
  // its built-in DATA_URI_TAGS — img among them — and lets any media type
  // through, so narrowing the regexp above is not on its own enough to keep
  // `data:image/svg+xml` out. Re-checking here is what actually excludes it.
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') || '';
    if (/^data:/i.test(src) && !/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(src)) {
      node.removeAttribute('src');
    }
  }
});

const PROSE_STYLES = {
  p: { mb: 2, lineHeight: 1.7 },
  'p:last-child': { mb: 0 },
  'ul, ol': { pl: 6, mb: 2 },
  li: { mb: 1, lineHeight: 1.7 },
  'h1, h2, h3, h4, h5, h6': { fontWeight: 700, mt: 3, mb: 1.5, lineHeight: 1.3 },
  h1: { fontSize: '1.4rem' },
  h2: { fontSize: '1.2rem' },
  h3: { fontSize: '1.05rem' },
  strong: { fontWeight: 700 },
  a: { color: 'blue.600', textDecoration: 'underline' },
  img: { maxWidth: '100%', height: 'auto', borderRadius: 'md', my: 2 },
  blockquote: {
    borderLeftWidth: '4px',
    borderColor: 'gray.300',
    pl: 3,
    py: 1,
    my: 2,
    color: 'gray.600',
    fontStyle: 'italic',
  },
  code: { bg: 'gray.100', px: 1, borderRadius: 'sm', fontSize: '0.875em', fontFamily: 'mono' },
  pre: { bg: 'gray.900', color: 'gray.100', p: 3, borderRadius: 'md', overflowX: 'auto', my: 2 },
  'pre code': { bg: 'transparent', color: 'inherit', p: 0 },
  table: { width: '100%', my: 2, borderCollapse: 'collapse', display: 'block', overflowX: 'auto' },
  'th, td': { borderWidth: '1px', borderColor: 'gray.200', px: 2, py: 1, fontSize: 'sm' },
  'sub, sup': { fontSize: '0.75em' },
};

/**
 * @param {boolean} [markdown]
 *        Set by a caller that already knows the content is Markdown — a
 *        notebook's markdown cell, say, where the cell type says so outright.
 *        The sniff below only recognises *block* markers, so `**bold**` on its
 *        own would otherwise fall through to the plain-text branch and render
 *        as literal asterisks. HTML still wins: an .ipynb cell may hold raw
 *        HTML, and that is not markdown whatever the cell is labelled.
 */
export default function RichText({ children, fallback = null, markdown = false, ...rest }) {
  const source = String(children ?? '');

  const html = useMemo(() => {
    if (!HTML_PATTERN.test(source)) return null;
    return purify.sanitize(source, SANITISE_CONFIG);
  }, [source]);

  if (!source.trim()) return fallback;

  if (html !== null) {
    return (
      <Box
        className="lm-richtext"
        sx={PROSE_STYLES}
        color="gray.700"
        fontSize="sm"
        // Sanitised immediately above with an explicit tag/attribute allowlist.
        dangerouslySetInnerHTML={{ __html: html }}
        {...rest}
      />
    );
  }

  if (markdown || MARKDOWN_PATTERN.test(source)) {
    return <Markdown {...rest}>{source}</Markdown>;
  }

  return (
    <Text whiteSpace="pre-wrap" color="gray.700" fontSize="sm" {...rest}>
      {source}
    </Text>
  );
}

