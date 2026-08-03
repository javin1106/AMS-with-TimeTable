import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithProviders } from '../../test/renderWithProviders';
import lmApi from '../api/lmApi';
import Calendar from '../pages/Calendar';

/**
 * A month cell is small: it names the subject a thing belongs to, and it holds
 * only the first few entries. Both of those are the point of the grid — a chip
 * that does not say which subject is being tested, or a day whose fourth entry
 * cannot be reached, sends the reader to the lists below to guess.
 */

vi.mock('../api/lmApi', () => ({ default: { calendar: vi.fn() } }));

const DSP = { _id: 'c1', name: 'ECE-A 2026', subject: 'Digital Signal Processing', subjectCode: 'EC8553', coverColor: '#1967d2' };
const MATHS = { _id: 'c2', name: 'ECE-A 2026', subject: 'Probability', subjectCode: 'MA8451', coverColor: '#0f9d58' };

/**
 * The page opens on the current month, so the fixture is anchored to it rather
 * than to a fixed date — the 12th exists in every month.
 */
const on = (day, hour = 9) => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), day, hour, 0, 0).toISOString();
};

const feed = () => ({
  coursework: [
    {
      _id: 'w1',
      classId: 'c1',
      title: 'Lab report 2',
      workType: 'assignment',
      calendarDate: on(12),
      dateKind: 'due',
      class: DSP,
      myRole: 'student',
      mySubmissionState: 'assigned',
    },
    {
      _id: 'w2',
      classId: 'c2',
      title: 'Reference notes',
      workType: 'material',
      calendarDate: on(12, 8),
      dateKind: 'posted',
      class: MATHS,
      myRole: 'student',
    },
  ],
  quizzes: [
    {
      _id: 'q1',
      classId: 'c1',
      title: 'Unit test 1',
      conductedAt: on(12, 10),
      timeLimitMinutes: 45,
      class: DSP,
      myRole: 'student',
      myAttemptStatus: null,
    },
    {
      _id: 'q2',
      classId: 'c2',
      title: 'Surprise test',
      conductedAt: on(12, 14),
      class: MATHS,
      myRole: 'student',
      myAttemptStatus: null,
    },
  ],
  shorts: [],
  nonWorkingDays: [],
});

describe('learningModule <Calendar />', () => {
  beforeEach(() => {
    lmApi.calendar.mockResolvedValue(feed());
  });

  it('labels each chip with the subject short name', async () => {
    renderWithProviders(<Calendar />);

    // The cell only fits CHIPS_PER_CELL of the four, so assert on the codes of
    // the ones it does show rather than on all four.
    await waitFor(() => expect(screen.getAllByText('EC8553').length).toBeGreaterThan(0));
    expect(screen.getAllByText('MA8451').length).toBeGreaterThan(0);
  });

  it('opens the whole day when a cell holds more than it can show', async () => {
    renderWithProviders(<Calendar />);

    const more = await screen.findByText('+1 more');
    fireEvent.click(more);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('4 activities')).toBeInTheDocument();
    // Every entry on the day, including the one the cell had no room for.
    ['Lab report 2', 'Reference notes', 'Unit test 1', 'Surprise test'].forEach((title) => {
      expect(within(dialog).getByText(title)).toBeInTheDocument();
    });
  });

  it('orders a day by time rather than by feed', async () => {
    renderWithProviders(<Calendar />);

    fireEvent.click(await screen.findByText('+1 more'));
    const dialog = await screen.findByRole('dialog');

    const order = ['Reference notes', 'Lab report 2', 'Unit test 1', 'Surprise test'];
    const rendered = order.map((title) => within(dialog).getByText(title));
    for (let i = 1; i < rendered.length; i += 1) {
      // Node.compareDocumentPosition: 4 === "follows".
      expect(rendered[i - 1].compareDocumentPosition(rendered[i]) & 4).toBeTruthy();
    }
  });

  it('leaves an empty day alone', async () => {
    lmApi.calendar.mockResolvedValue({ coursework: [], quizzes: [], shorts: [], nonWorkingDays: [] });
    renderWithProviders(<Calendar />);

    await waitFor(() => expect(screen.getByText('7')).toBeInTheDocument());
    fireEvent.click(screen.getByText('7'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
