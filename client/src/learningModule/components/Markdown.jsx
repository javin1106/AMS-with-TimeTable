import React, { useMemo } from 'react';
import { Box } from '@chakra-ui/react';
import DOMPurify from 'dompurify';

/**
 * Small GitHub-flavoured-Markdown subset renderer.
 *
 * AI-generated notes and tutorials arrive as Markdown, and the project has no
 * Markdown dependency. Rather than adding one for headings, lists, tables and
 * emphasis, this converts the subset the generators actually emit and runs the
 * result through DOMPurify — which the project already depends on — so nothing
 * a model (or a teacher editing the text) produces can inject script.
 */

const escapeHtml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderInline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
}

function markdownToHtml(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];

  let inCodeBlock = false;
  let listType = null; // 'ul' | 'ol'
  let inTable = false;
  let tableHeaderDone = false;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const closeTable = () => {
    if (inTable) {
      out.push('</tbody></table>');
      inTable = false;
      tableHeaderDone = false;
    }
  };
  const closeBlocks = () => {
    flushParagraph();
    closeList();
    closeTable();
  };

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      closeBlocks();
      out.push(inCodeBlock ? '</code></pre>' : '<pre><code>');
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      out.push(`${escapeHtml(line)}\n`);
      continue;
    }

    if (!line.trim()) {
      closeBlocks();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeBlocks();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^(---|\*\*\*|___)\s*$/.test(line.trim())) {
      closeBlocks();
      out.push('<hr />');
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      closeBlocks();
      out.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }

    // Tables: a row of pipes, with the |---|---| separator skipped.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushParagraph();
      closeList();
      const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
      if (/^[\s|:-]+$/.test(line)) continue;
      if (!inTable) {
        out.push('<table><thead>');
        out.push(`<tr>${cells.map((c) => `<th>${renderInline(c)}</th>`).join('')}</tr>`);
        out.push('</thead><tbody>');
        inTable = true;
        tableHeaderDone = true;
        continue;
      }
      if (tableHeaderDone) {
        out.push(`<tr>${cells.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`);
        continue;
      }
    } else {
      closeTable();
    }

    const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
    if (unordered) {
      flushParagraph();
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${renderInline(unordered[1])}</li>`);
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      flushParagraph();
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${renderInline(ordered[1])}</li>`);
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }

  closeBlocks();
  if (inCodeBlock) out.push('</code></pre>');
  return out.join('\n');
}

export default function Markdown({ children, ...rest }) {
  const html = useMemo(
    () =>
      DOMPurify.sanitize(markdownToHtml(children), {
        ADD_ATTR: ['target', 'rel'],
      }),
    [children],
  );

  return (
    <Box
      className="lm-markdown"
      sx={{
        'h1, h2, h3, h4, h5, h6': { fontWeight: 700, lineHeight: 1.3, mt: 5, mb: 2, color: 'gray.800' },
        h1: { fontSize: '1.6rem', mt: 0 },
        h2: { fontSize: '1.3rem' },
        h3: { fontSize: '1.1rem' },
        p: { mb: 3, lineHeight: 1.75, color: 'gray.700' },
        'ul, ol': { pl: 6, mb: 3 },
        li: { mb: 1, lineHeight: 1.7, color: 'gray.700' },
        strong: { color: 'gray.900' },
        a: { color: 'blue.600', textDecoration: 'underline' },
        blockquote: {
          borderLeftWidth: '4px',
          borderColor: 'blue.300',
          bg: 'blue.50',
          px: 4,
          py: 2,
          my: 3,
          borderRadius: 'md',
          color: 'gray.700',
          fontStyle: 'italic',
        },
        code: {
          bg: 'gray.100',
          px: 1.5,
          py: 0.5,
          borderRadius: 'sm',
          fontSize: '0.875em',
          fontFamily: 'mono',
        },
        pre: {
          bg: 'gray.900',
          color: 'gray.100',
          p: 4,
          borderRadius: 'md',
          overflowX: 'auto',
          my: 3,
        },
        'pre code': { bg: 'transparent', color: 'inherit', p: 0 },
        table: { width: '100%', my: 4, borderCollapse: 'collapse', display: 'block', overflowX: 'auto' },
        'th, td': { borderWidth: '1px', borderColor: 'gray.200', px: 3, py: 2, textAlign: 'left', fontSize: 'sm' },
        th: { bg: 'gray.50', fontWeight: 600 },
        hr: { my: 5, borderColor: 'gray.200' },
      }}
      // Content is sanitised by DOMPurify immediately above.
      dangerouslySetInnerHTML={{ __html: html }}
      {...rest}
    />
  );
}
