import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import RichText from '../components/RichText';
import { isRichTextEmpty, richTextToPlain } from '../richTextUtils';

/**
 * RichText renders stored content with dangerouslySetInnerHTML. The client is
 * not a security boundary — anyone can POST raw HTML to the API — so the
 * sanitisation here is the guarantee that actually holds, and it is what these
 * tests cover, alongside the three-way content detection.
 */
describe('learningModule <RichText />', () => {
  it('renders editor HTML, keeping the formatting a teacher applied', () => {
    const { container } = render(
      <RichText>{'<p>Find <strong>P</strong> when H<sub>2</sub>O is <em>pure</em></p>'}</RichText>,
    );
    expect(container.querySelector('strong')).toHaveTextContent('P');
    expect(container.querySelector('sub')).toHaveTextContent('2');
    expect(container.querySelector('em')).toHaveTextContent('pure');
  });

  it('keeps lists and tables from the editor', () => {
    const { container } = render(
      <RichText>{'<ul><li>one</li><li>two</li></ul><table><tbody><tr><td>x</td></tr></tbody></table>'}</RichText>,
    );
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('td')).toHaveTextContent('x');
  });

  it('keeps inline images, which is how diagrams get into a question', () => {
    const { container } = render(
      <RichText>{'<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="circuit" /></p>'}</RichText>,
    );
    const img = container.querySelector('img');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('alt', 'circuit');
  });

  it('strips script tags and inline handlers', () => {
    const { container } = render(
      <RichText>{'<p>Safe</p><script>window.__lmPwned = true;</script><img src="x" onerror="window.__lmPwned = true">'}</RichText>,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(window.__lmPwned).toBeUndefined();
    expect(container).toHaveTextContent('Safe');
  });

  it('strips iframes, forms and inputs', () => {
    const { container } = render(
      <RichText>
        {'<p>a</p><iframe src="https://evil.example"></iframe><form action="/x"><input name="p" /></form>'}
      </RichText>,
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
  });

  it('neutralises javascript: links', () => {
    const { container } = render(<RichText>{'<p><a href="javascript:alert(1)">click</a></p>'}</RichText>);
    const href = container.querySelector('a')?.getAttribute('href') || '';
    expect(href).not.toMatch(/^javascript:/i);
  });

  it('falls back to the Markdown renderer for AI-generated content', () => {
    // AI notes and tutorials are Markdown, not editor HTML, and predate the
    // rich editor — they must keep rendering as headings and bullets.
    const { container } = render(<RichText>{'## Key takeaways\n\n- first point\n- second point'}</RichText>);
    expect(container.querySelector('h2')).toHaveTextContent('Key takeaways');
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  it('renders older plain-text posts with their line breaks intact', () => {
    const { container } = render(<RichText>{'line one\nline two'}</RichText>);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('line one');
    expect(container.textContent).toContain('line two');
  });

  it('renders the fallback for empty content', () => {
    const { container } = render(<RichText fallback={<span>nothing</span>}>{''}</RichText>);
    expect(container).toHaveTextContent('nothing');
  });

  it('handles undefined without throwing', () => {
    expect(() => render(<RichText>{undefined}</RichText>)).not.toThrow();
  });
});

describe('learningModule richTextUtils', () => {
  it('treats an empty Quill document as empty', () => {
    // The case a plain .trim() check gets wrong, letting a blank post through.
    expect(isRichTextEmpty('<p><br></p>')).toBe(true);
    expect(isRichTextEmpty('<p></p>')).toBe(true);
    expect(isRichTextEmpty('<p>&nbsp;</p>')).toBe(true);
    expect(isRichTextEmpty('')).toBe(true);
    expect(isRichTextEmpty(undefined)).toBe(true);
  });

  it('treats real content as non-empty', () => {
    expect(isRichTextEmpty('<p>Hello</p>')).toBe(false);
    expect(isRichTextEmpty('plain text')).toBe(false);
  });

  it('flattens rich text to one line for tables and previews', () => {
    expect(richTextToPlain('<p>Find <strong>P</strong></p><p>when V = 5</p>')).toBe('Find P when V = 5');
    expect(richTextToPlain('<ul><li>a</li><li>b</li></ul>')).toBe('a b');
    expect(richTextToPlain('line<br>break')).toBe('line break');
  });

  it('decodes entities while flattening', () => {
    expect(richTextToPlain('<p>a &amp; b &lt;c&gt;</p>')).toBe('a & b <c>');
    expect(richTextToPlain('<p>x&nbsp;y</p>')).toBe('x y');
  });

  it('returns an empty string for blank input', () => {
    expect(richTextToPlain('')).toBe('');
    expect(richTextToPlain(null)).toBe('');
  });
});
