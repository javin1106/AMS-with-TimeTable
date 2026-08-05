import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import RichText from '../components/RichText';
import Markdown from '../components/Markdown';

/**
 * Injection suite.
 *
 * Everything <RichText> renders is authored by a user — announcements, comments,
 * question stems, quiz options — and reaches other users' screens. The client is
 * not the security boundary (anyone can POST raw HTML to the API), so
 * sanitisation at render time is the guarantee that actually has to hold, and
 * this file is what holds it to account.
 *
 * The assertions are deliberately about *outcome* rather than about DOMPurify's
 * internals: no script node, no event handler, no scheme that executes, no
 * element that can cover the page. A future config change that still passes
 * these is fine; one that does not is a regression regardless of how it is
 * spelled.
 */

const html = (payload) => render(<RichText>{payload}</RichText>).container;

/** Every attribute on every node, so a handler cannot hide on a nested tag. */
const allAttributes = (container) =>
  [...container.querySelectorAll('*')].flatMap((node) => [...node.attributes].map((a) => a.name.toLowerCase()));

const SCRIPT_VECTORS = [
  ['a script tag', '<p>hi</p><script>alert(1)</script>'],
  ['an inline error handler', '<p>x</p><img src=x onerror="alert(1)">'],
  ['an inline load handler', '<p>x</p><img src=x onload="alert(1)">'],
  ['a click handler on a link', '<p><a href="#" onclick="alert(1)">click</a></p>'],
  ['a mouseover handler', '<p onmouseover="alert(1)">hover</p>'],
  ['an ontoggle handler', '<p>x</p><details open ontoggle="alert(1)">boom</details>'],
  ['an svg animate handler', '<p>x</p><svg><animate onbegin="alert(1)" attributeName="x" dur="1s"></svg>'],
  ['an iframe', '<p>x</p><iframe src="https://evil.test"></iframe>'],
  ['an iframe with srcdoc', '<p>x</p><iframe srcdoc="<script>alert(1)</script>"></iframe>'],
  ['an object tag', '<p>x</p><object data="https://evil.test"></object>'],
  ['an embed tag', '<p>x</p><embed src="https://evil.test">'],
  ['a form and input', '<p>x</p><form action="https://evil.test"><input name="password"></form>'],
  ['a style tag', '<p>x</p><style>body{display:none}</style>'],
  ['a stylesheet link', '<p>x</p><link rel="stylesheet" href="https://evil.test/x.css">'],
  ['a base tag', '<p>x</p><base href="https://evil.test/">'],
  ['a meta refresh', '<p>x</p><meta http-equiv="refresh" content="0;url=https://evil.test">'],
  ['a noscript mutation payload', '<p>x</p><noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>'],
];

describe('learningModule RichText — script injection', () => {
  SCRIPT_VECTORS.forEach(([name, payload]) => {
    it(`neutralises ${name}`, () => {
      const container = html(payload);

      expect(container.querySelector('script')).toBeNull();
      expect(container.querySelector('iframe')).toBeNull();
      expect(container.querySelector('object')).toBeNull();
      expect(container.querySelector('embed')).toBeNull();
      expect(container.querySelector('form')).toBeNull();
      expect(container.querySelector('input')).toBeNull();
      expect(container.querySelector('style')).toBeNull();
      expect(container.querySelector('link')).toBeNull();
      expect(container.querySelector('base')).toBeNull();
      expect(container.querySelector('meta')).toBeNull();

      // No `on*` attribute survived anywhere in the tree.
      expect(allAttributes(container).filter((name_) => name_.startsWith('on'))).toEqual([]);
    });
  });
});

describe('learningModule RichText — executable URLs', () => {
  const cases = [
    ['javascript: on a link', '<p><a href="javascript:alert(1)">x</a></p>'],
    ['mixed-case JaVaScRiPt:', '<p><a href="JaVaScRiPt:alert(1)">x</a></p>'],
    ['javascript: with padding', '<p><a href="  java\tscript:alert(1)">x</a></p>'],
    ['data:text/html on a link', '<p><a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a></p>'],
    ['javascript: on an image', '<p>x</p><img src="javascript:alert(1)">'],
    ['vbscript:', '<p><a href="vbscript:msgbox(1)">x</a></p>'],
  ];

  cases.forEach(([name, payload]) => {
    it(`strips ${name}`, () => {
      const container = html(payload);
      const urls = [...container.querySelectorAll('[href], [src]')].flatMap((node) => [
        node.getAttribute('href') || '',
        node.getAttribute('src') || '',
      ]);
      urls.forEach((url) => {
        // Whitespace is stripped before comparing because a browser ignores it
        // when resolving a scheme — `java\tscript:` runs.
        expect(url.replace(/\s+/g, '').toLowerCase()).not.toMatch(/^(javascript|vbscript|data:text)/);
      });
    });
  });

  it('keeps an ordinary https link working', () => {
    const container = html('<p><a href="https://nitj.ac.in">syllabus</a></p>');
    expect(container.querySelector('a')).toHaveAttribute('href', 'https://nitj.ac.in');
  });

  it('adds rel=noopener to a link that opens in a new tab', () => {
    // Without it the opened page can navigate this one via window.opener —
    // a signed-in tab redirected to a look-alike login.
    const container = html('<p><a href="https://nitj.ac.in" target="_blank">x</a></p>');
    expect(container.querySelector('a').getAttribute('rel')).toContain('noopener');
  });

  it('keeps an inline data:image, which is how diagrams get pasted in', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(html(`<p>x</p><img src="${png}">`).querySelector('img')).toHaveAttribute('src', png);
  });

  it('drops an svg data URI', () => {
    // An <img>-loaded SVG cannot run script in current browsers, but Quill never
    // produces one, so allowing it buys attack surface for no feature.
    const container = html('<p>x</p><img src="data:image/svg+xml;base64,PHN2Zy8+">');
    const img = container.querySelector('img');
    expect(img?.getAttribute('src') ?? '').not.toContain('svg');
  });
});

describe('learningModule RichText — style abuse', () => {
  it('strips positioning that would let a comment cover the page', () => {
    // No JavaScript required for this one: a full-viewport fixed overlay inside
    // a class announcement is a defacement, and wrapped in a link it is an
    // in-page phishing surface.
    const container = html(
      '<p><span style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999;background:red">gotcha</span></p>',
    );
    const style = container.querySelector('span')?.getAttribute('style') || '';
    expect(style).not.toMatch(/position|z-index|100vw|100vh/i);
  });

  it('strips url() so reading a comment cannot phone home', () => {
    const container = html('<p><span style="background-color:url(https://evil.test/beacon.png)">x</span></p>');
    expect(container.querySelector('span')?.getAttribute('style') || '').not.toMatch(/url\s*\(/i);
  });

  it('strips the legacy expression() vector', () => {
    const container = html('<p><span style="width:expression(alert(1))">x</span></p>');
    expect(container.querySelector('span')?.getAttribute('style') || '').not.toMatch(/expression/i);
  });

  it('keeps the colour and alignment the editor actually produces', () => {
    const container = html('<p style="text-align:center"><span style="color:rgb(230, 0, 0)">red</span></p>');
    expect(container.querySelector('span').getAttribute('style')).toContain('color');
    expect(container.querySelector('p').getAttribute('style')).toContain('text-align');
  });

  it('drops the attribute entirely when nothing in it is allowed', () => {
    const container = html('<p><span style="position:absolute">x</span></p>');
    expect(container.querySelector('span').hasAttribute('style')).toBe(false);
  });
});

describe('learningModule Markdown — injection', () => {
  it('does not execute raw HTML embedded in AI-generated markdown', () => {
    // Notes come back from a model, and a model will happily reproduce whatever
    // was in the transcript.
    const { container } = render(<Markdown>{'# Notes\n\n<script>alert(1)</script>\n'}</Markdown>);
    expect(container.querySelector('script')).toBeNull();
  });

  it('strips a javascript: markdown link', () => {
    const { container } = render(<Markdown>{'[click](javascript:alert(1))'}</Markdown>);
    const href = container.querySelector('a')?.getAttribute('href') || '';
    expect(href.toLowerCase()).not.toContain('javascript:');
  });

  it('strips an onerror smuggled through a markdown image', () => {
    const { container } = render(<Markdown>{'![x](x" onerror="alert(1))'}</Markdown>);
    expect(allAttributes(container).filter((name) => name.startsWith('on'))).toEqual([]);
  });
});
