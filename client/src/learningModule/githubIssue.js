/**
 * Builds a "file this on GitHub" link for the learning module.
 *
 * GitHub prefills a new issue from query parameters, so a link is enough — no
 * token, no API call, and the issue is authored by whoever clicks it rather than
 * by a bot account, which is what you want when a maintainer needs to ask them a
 * follow-up question.
 *
 * ## Two ways the label gets applied, on purpose
 *
 * `labels=` in the URL is **ignored for anyone without triage permission** on
 * the repository — GitHub drops it silently rather than refusing, so a read-only
 * collaborator files a perfectly good issue with no label on it and nobody
 * notices. The `template=` parameter does not have that problem: labels declared
 * in an issue template's front matter are applied server-side whoever files it.
 *
 * So both are sent. The template is the one that works; `labels=` is the
 * fallback for the window where the template file has not reached the default
 * branch yet, since GitHub reads templates from there and nowhere else.
 */

const REPO = 'xceed-nitj/AMS-with-TimeTable';

/** Must match the label that already exists on the repo, spelling and case. */
export const LABEL = 'Learning Module';

/** Filename under `.github/ISSUE_TEMPLATE/`, read from the default branch. */
export const TEMPLATE = 'learning-module.md';

export const REPO_URL = `https://github.com/${REPO}`;

/**
 * Roughly where a GitHub issue URL stops working.
 *
 * The real ceiling is a server limit on the whole request line, so the number is
 * approximate by nature; this leaves room for the rest of the URL and errs
 * small. A description long enough to hit it is one somebody should paste in
 * themselves anyway.
 */
const MAX_BODY = 6000;

const truncate = (text) =>
  text.length <= MAX_BODY
    ? text
    : `${text.slice(0, MAX_BODY)}\n\n_…trimmed. Please paste the rest here._`;

/**
 * The issue body.
 *
 * Deliberately does **not** carry the reporter's name or email. The GitHub
 * account filing it is already on the issue, and copying an institute address
 * into a tracker is a needless second copy of somebody's personal data.
 */
const composeBody = ({ kind = 'bug', description = '', pageUrl = '', className = '' } = {}) => {
  const sections = [
    kind === 'suggestion' ? '### What would you like to see?' : '### What went wrong?',
    description.trim() || '_(please describe what you were doing, what you expected, and what happened)_',
    '',
    '### Where',
    `- Page: ${pageUrl || '_(not recorded)_'}`,
  ];

  if (className) sections.push(`- Class: ${className}`);
  // A screen size and a browser string answer the first two questions a
  // maintainer asks, and neither is worth a round trip to find out.
  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    sections.push(`- Browser: ${navigator.userAgent}`);
  }
  if (typeof window !== 'undefined' && window.innerWidth) {
    sections.push(`- Viewport: ${window.innerWidth}×${window.innerHeight}`);
  }

  sections.push('', '_Filed from the learning module’s bug report page._');
  return truncate(sections.join('\n'));
};

/**
 * A prefilled "new issue" URL.
 *
 * @param {object} report
 * @param {'bug'|'suggestion'} [report.kind]
 * @param {string} [report.title]
 * @param {string} [report.description]
 * @param {string} [report.pageUrl]
 * @param {string} [report.className]
 * @returns {string}
 */
export function githubIssueUrl(report = {}) {
  const params = new URLSearchParams({
    template: TEMPLATE,
    labels: LABEL,
    body: composeBody(report),
  });

  // Only when there is one: an empty `title` leaves GitHub's field blank but
  // still counts as "prefilled", which suppresses nothing and just looks odd.
  const title = (report.title || '').trim();
  if (title) params.set('title', title);

  return `${REPO_URL}/issues/new?${params.toString()}`;
}

export default githubIssueUrl;
