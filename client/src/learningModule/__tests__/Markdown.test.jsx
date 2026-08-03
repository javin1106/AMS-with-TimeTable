import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import Markdown from '../components/Markdown';

/**
 * Markdown reaches this component from two untrusted-ish places: text written
 * by a model, and text a teacher pasted or edited. It is rendered with
 * dangerouslySetInnerHTML, so the sanitisation behaviour is the part worth
 * pinning down.
 */
describe('learningModule <Markdown />', () => {
  it('renders headings, emphasis and links', () => {
    const { container } = render(
      <Markdown>{'# Lecture 1\n\nThe **Fourier transform** is *useful*.\n\n[docs](https://example.com)'}</Markdown>,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Lecture 1' })).toBeInTheDocument();
    expect(container.querySelector('strong')).toHaveTextContent('Fourier transform');
    expect(container.querySelector('em')).toHaveTextContent('useful');

    const link = container.querySelector('a');
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('renders both list styles', () => {
    const { container } = render(<Markdown>{'- one\n- two\n\n1. first\n2. second'}</Markdown>);

    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(container.querySelectorAll('ol li')).toHaveLength(2);
  });

  it('renders a table, skipping the separator row', () => {
    const { container } = render(
      <Markdown>{'| Term | Meaning |\n| --- | --- |\n| DFT | Discrete transform |\n| FFT | Fast algorithm |'}</Markdown>,
    );

    expect(container.querySelectorAll('thead th')).toHaveLength(2);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container.querySelector('tbody')).toHaveTextContent('Discrete transform');
  });

  it('renders fenced code without interpreting its contents', () => {
    const { container } = render(<Markdown>{'```\nconst x = **not bold**;\n```'}</Markdown>);

    const code = container.querySelector('pre code');
    expect(code).toBeInTheDocument();
    expect(code.textContent).toContain('**not bold**');
    expect(code.querySelector('strong')).toBeNull();
  });

  it('renders blockquotes, which the heuristic fallback uses for its banner', () => {
    const { container } = render(<Markdown>{'> Generated without an AI provider.'}</Markdown>);
    expect(container.querySelector('blockquote')).toHaveTextContent('Generated without an AI provider.');
  });

  it('strips script tags rather than rendering them', () => {
    const { container } = render(
      <Markdown>{'# Title\n\n<script>window.__pwned = true;</script>\n\nBody text.'}</Markdown>,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(window.__pwned).toBeUndefined();
    expect(container).toHaveTextContent('Body text.');
  });

  it('strips inline event handlers and javascript: URLs', () => {
    const { container } = render(
      <Markdown>{'<img src="x" onerror="window.__pwned = true" />\n\n[click](javascript:alert(1))'}</Markdown>,
    );

    expect(container.querySelector('[onerror]')).toBeNull();
    const link = container.querySelector('a');
    // DOMPurify either drops the href entirely or neutralises the scheme —
    // either way it must not survive as an executable javascript: URL.
    expect(link?.getAttribute('href') || '').not.toMatch(/^javascript:/i);
    expect(window.__pwned).toBeUndefined();
  });

  it('handles empty and undefined input', () => {
    expect(() => render(<Markdown>{''}</Markdown>)).not.toThrow();
    expect(() => render(<Markdown>{undefined}</Markdown>)).not.toThrow();
  });
});
