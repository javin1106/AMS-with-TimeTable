/**
 * The prefilled GitHub issue link.
 *
 * The assertions that matter are the label and the template: the label is how
 * the issue reaches the right people, and the template is the only one of the
 * two mechanisms that survives a reporter without triage permission on the
 * repository. Losing either fails quietly — a perfectly good issue lands with no
 * label on it and nobody notices for a week.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { githubIssueUrl, LABEL, TEMPLATE, REPO_URL } from '../githubIssue';

/** Parses the link back into the bits GitHub will read. */
const parse = (url) => {
  const parsed = new URL(url);
  return { path: `${parsed.origin}${parsed.pathname}`, params: parsed.searchParams };
};

describe('githubIssueUrl', () => {
  it('points at this repository', () => {
    expect(parse(githubIssueUrl()).path).toBe(`${REPO_URL}/issues/new`);
  });

  it('carries the label', () => {
    expect(parse(githubIssueUrl()).params.get('labels')).toBe(LABEL);
  });

  it('uses the exact label that exists on the repo', () => {
    // GitHub does not create a label from a URL — a near miss on spelling or
    // case means no label at all, silently.
    expect(LABEL).toBe('Learning Module');
  });

  it('names the template as well as the label', () => {
    // Belt and braces: `labels=` is dropped for reporters without triage
    // permission, while a label in the template's front matter is not.
    expect(parse(githubIssueUrl()).params.get('template')).toBe(TEMPLATE);
  });

  it('prefills the title when there is one', () => {
    const { params } = parse(githubIssueUrl({ title: 'Points shown twice' }));
    expect(params.get('title')).toBe('Points shown twice');
  });

  it('leaves the title out entirely when blank', () => {
    expect(parse(githubIssueUrl({ title: '   ' })).params.has('title')).toBe(false);
    expect(parse(githubIssueUrl()).params.has('title')).toBe(false);
  });

  it('puts the description in the body', () => {
    const { params } = parse(githubIssueUrl({ description: 'Opened the class and it showed 3.' }));
    expect(params.get('body')).toContain('Opened the class and it showed 3.');
  });

  it('asks the right question for a suggestion', () => {
    expect(parse(githubIssueUrl({ kind: 'suggestion' })).params.get('body'))
      .toContain('What would you like to see?');
    expect(parse(githubIssueUrl({ kind: 'bug' })).params.get('body'))
      .toContain('What went wrong?');
  });

  it('records the page and the class', () => {
    const { params } = parse(githubIssueUrl({
      pageUrl: 'https://xceed.nitj.ac.in/learning/class/abc/quizzes',
      className: 'Soft Computing Techniques',
    }));
    expect(params.get('body')).toContain('https://xceed.nitj.ac.in/learning/class/abc/quizzes');
    expect(params.get('body')).toContain('Soft Computing Techniques');
  });

  it('prompts for a description rather than filing an empty one', () => {
    expect(parse(githubIssueUrl()).params.get('body')).toContain('please describe');
  });

  it('never carries the reporter’s name or email', () => {
    // The GitHub account filing it is already on the issue; copying an institute
    // address into the tracker is a second copy of somebody's personal data for
    // no benefit.
    const { params } = parse(githubIssueUrl({
      description: 'nothing personal here',
      reporterName: 'Asha Rao',
      reporterEmail: 'asha@nitj.ac.in',
    }));
    expect(params.get('body')).not.toContain('Asha Rao');
    expect(params.get('body')).not.toContain('asha@nitj.ac.in');
  });

  it('escapes everything it is given', () => {
    // A title with an ampersand in it would otherwise truncate the body, and one
    // with a newline would produce a URL the browser rejects outright.
    const url = githubIssueUrl({
      title: 'Marks & grades: 100% wrong?',
      description: 'line one\nline two #2 &c',
    });
    expect(() => new URL(url)).not.toThrow();
    const { params } = parse(url);
    expect(params.get('title')).toBe('Marks & grades: 100% wrong?');
    expect(params.get('body')).toContain('line one\nline two #2 &c');
  });

  it('trims a description too long for a URL', () => {
    const { params } = parse(githubIssueUrl({ description: 'x'.repeat(20000) }));
    expect(params.get('body').length).toBeLessThan(7000);
    expect(params.get('body')).toContain('trimmed');
  });

  describe('environment details', () => {
    // Stubbed rather than read from the test environment: asserting on whatever
    // width jsdom happens to default to makes the test fail for reasons that
    // have nothing to do with the link.
    beforeEach(() => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('TestBrowser/1.0');
      vi.stubGlobal('window', { ...globalThis.window, innerWidth: 1280, innerHeight: 800 });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it('includes the browser and viewport', () => {
      // The first two questions a maintainer asks, answered without a round trip.
      const { params } = parse(githubIssueUrl({}));
      expect(params.get('body')).toContain('TestBrowser/1.0');
      expect(params.get('body')).toContain('Viewport: 1280×800');
    });
  });
});
