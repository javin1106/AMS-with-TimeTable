/**
 * Where the "Raise on GitHub" link appears on the bug report page.
 *
 * The important assertion is the negative one. The repository is **private**, so
 * a student who follows this link lands on a 404 that reads as the app being
 * broken — the link has to stay hidden from everyone who cannot reach the
 * tracker, and a regression there is invisible to anyone testing as an admin.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import BugReports from '../pages/BugReports';
import lmApi from '../api/lmApi';
import { LABEL, TEMPLATE } from '../githubIssue';

vi.mock('../api/lmApi', () => ({
  default: {
    myBugReports: vi.fn(),
    listClasses: vi.fn(),
    allBugReports: vi.fn(),
    reportBug: vi.fn(),
    reviewBug: vi.fn(),
  },
}));

const REPORT = {
  _id: 'r1',
  kind: 'bug',
  title: 'Document count is wrong',
  description: 'Front page says 1, the class says 3.',
  pageUrl: 'https://xceed.nitj.ac.in/learning/class/abc',
  className: 'Soft Computing',
  status: 'open',
  reporterName: 'Asha Rao',
  created_at: new Date().toISOString(),
};

const renderPage = () =>
  render(
    <ChakraProvider>
      <BugReports />
    </ChakraProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  lmApi.myBugReports.mockResolvedValue({ reports: [], pointsPerReport: 5 });
  lmApi.listClasses.mockResolvedValue([]);
});

const linkNamed = () => screen.queryAllByRole('link', { name: /Raise on GitHub/ });

describe('BugReports — the GitHub link', () => {
  it('is hidden from someone who is not an admin', async () => {
    // The repository is private; this link would 404 for them.
    lmApi.allBugReports.mockRejectedValue(new Error('403'));
    renderPage();

    await screen.findByText('Bug / Suggestion');
    expect(linkNamed()).toHaveLength(0);
  });

  it('is offered to an admin', async () => {
    lmApi.allBugReports.mockResolvedValue({ reports: [], counts: {} });
    renderPage();

    await waitFor(() => expect(linkNamed().length).toBeGreaterThan(0));
  });

  it('carries the label and the template', async () => {
    lmApi.allBugReports.mockResolvedValue({ reports: [], counts: {} });
    renderPage();

    await waitFor(() => expect(linkNamed().length).toBeGreaterThan(0));
    const href = new URL(linkNamed()[0].getAttribute('href'));
    expect(href.pathname).toBe('/xceed-nitj/AMS-with-TimeTable/issues/new');
    expect(href.searchParams.get('labels')).toBe(LABEL);
    expect(href.searchParams.get('template')).toBe(TEMPLATE);
  });

  it('opens in a new tab without handing the opener over', async () => {
    lmApi.allBugReports.mockResolvedValue({ reports: [], counts: {} });
    renderPage();

    await waitFor(() => expect(linkNamed().length).toBeGreaterThan(0));
    expect(linkNamed()[0]).toHaveAttribute('target', '_blank');
    expect(linkNamed()[0].getAttribute('rel')).toContain('noopener');
  });

  it('escalates a queued report with its own details', async () => {
    // The case this is really for: a student files in the app and an admin
    // forwards it to the tracker without retyping any of it.
    lmApi.allBugReports.mockResolvedValue({ reports: [REPORT], counts: { open: 1 } });
    renderPage();

    // The queue lives behind its own tab, which is lazily rendered.
    const queueTab = await screen.findByRole('tab', { name: /Queue/ });
    queueTab.click();

    await screen.findByText('Document count is wrong');
    const escalate = screen.getAllByRole('link', { name: /Raise on GitHub/ })
      .map((node) => new URL(node.getAttribute('href')))
      .find((url) => url.searchParams.get('title') === 'Document count is wrong');

    expect(escalate).toBeDefined();
    expect(escalate.searchParams.get('labels')).toBe(LABEL);
    const body = escalate.searchParams.get('body');
    expect(body).toContain('Front page says 1, the class says 3.');
    expect(body).toContain('https://xceed.nitj.ac.in/learning/class/abc');
    expect(body).toContain('Soft Computing');
  });

  it('does not put the reporter’s name in the escalated issue', async () => {
    lmApi.allBugReports.mockResolvedValue({ reports: [REPORT], counts: { open: 1 } });
    renderPage();

    (await screen.findByRole('tab', { name: /Queue/ })).click();
    await screen.findByText('Document count is wrong');

    const hrefs = screen.getAllByRole('link', { name: /Raise on GitHub/ })
      .map((node) => node.getAttribute('href'));
    hrefs.forEach((href) => expect(decodeURIComponent(href)).not.toContain('Asha Rao'));
  });
});
