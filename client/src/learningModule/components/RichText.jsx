import React, { useMemo } from 'react';
import { Box, Text } from '@chakra-ui/react';
import DOMPurify from 'dompurify';
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
  // Quill writes inline styles for colour and alignment; allow those and
  // nothing that can load or position arbitrary content.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|data:image\/(?:png|jpe?g|gif|webp|svg\+xml));?|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  ADD_ATTR: ['target', 'rel'],
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'srcset', 'formaction'],
};

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

export default function RichText({ children, fallback = null, ...rest }) {
  const source = String(children ?? '');

  const html = useMemo(() => {
    if (!HTML_PATTERN.test(source)) return null;
    return DOMPurify.sanitize(source, SANITISE_CONFIG);
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

  if (MARKDOWN_PATTERN.test(source)) {
    return <Markdown {...rest}>{source}</Markdown>;
  }

  return (
    <Text whiteSpace="pre-wrap" color="gray.700" fontSize="sm" {...rest}>
      {source}
    </Text>
  );
}

