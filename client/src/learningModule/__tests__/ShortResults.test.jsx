import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import ShortResults from '../components/ShortResults';

/**
 * ShortResults is projected in front of a room, so a mislabelled bar or a hidden
 * answer key is visible to everyone at once. These tests cover the two things
 * that would actually go wrong: a number rendered in the wrong place, and the
 * answer key leaking before the teacher reveals it.
 *
 * The component recomputes nothing — the server's aggregator owns the maths, and
 * these fixtures are shaped exactly as it emits them.
 */

const choiceResults = (overrides = {}) => ({
  slideId: 's1',
  type: 'mcq',
  question: '<p>Which is <strong>Ohm</strong>&rsquo;s law?</p>',
  totalResponses: 4,
  gradable: true,
  options: [
    { index: 0, label: 'V = IR', count: 3, percent: 75, isCorrect: undefined },
    { index: 1, label: 'V = I/R', count: 1, percent: 25, isCorrect: undefined },
  ],
  ...overrides,
});

describe('learningModule <ShortResults />', () => {
  it('renders each option with its own count and percentage', () => {
    render(<ShortResults results={choiceResults()} />);

    expect(screen.getByText('V = IR')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/75%/)).toBeInTheDocument();
    expect(screen.getByText(/25%/)).toBeInTheDocument();
  });

  it('withholds the answer key until the slide is revealed', () => {
    // Before a reveal the server omits isCorrect entirely, so no option may be
    // badged — otherwise the projector gives the answer away mid-vote.
    render(<ShortResults results={choiceResults()} />);
    expect(screen.queryByText('correct')).not.toBeInTheDocument();
  });

  it('badges the correct option and shows the tally once revealed', () => {
    render(
      <ShortResults
        results={choiceResults({
          options: [
            { index: 0, label: 'V = IR', count: 3, percent: 75, isCorrect: true },
            { index: 1, label: 'V = I/R', count: 1, percent: 25, isCorrect: false },
          ],
          correctCount: 3,
          explanation: 'Voltage is current times resistance.',
        })}
      />,
    );

    expect(screen.getByText('correct')).toBeInTheDocument();
    expect(screen.getByText('3 of 4 correct')).toBeInTheDocument();
    expect(screen.getByText(/Voltage is current times resistance/)).toBeInTheDocument();
  });

  it('renders the question as rich text when asked to show it', () => {
    const { container } = render(<ShortResults results={choiceResults()} showQuestion />);
    // The question is authored in the rich editor, so its markup has to survive
    // rather than being printed as tags.
    expect(container.querySelector('strong')).toHaveTextContent('Ohm');
  });

  it('sizes word-cloud words by frequency without dropping the rare ones', () => {
    render(
      <ShortResults
        results={{
          slideId: 's2',
          type: 'wordcloud',
          totalResponses: 5,
          gradable: false,
          maxCount: 4,
          words: [
            { text: 'entropy', count: 4 },
            { text: 'enthalpy', count: 1 },
          ],
        }}
      />,
    );

    const common = screen.getByText('entropy');
    const rare = screen.getByText('enthalpy');

    // Chakra emits the size as a generated class, so the cascade is what has to
    // be read here — an inline style would be empty.
    const sizeOf = (node) => parseFloat(window.getComputedStyle(node).fontSize);
    expect(sizeOf(common)).toBeGreaterThan(sizeOf(rare));
    // A one-mention word must still be legible rather than collapsing to nothing.
    expect(sizeOf(rare)).toBeGreaterThan(0);

    // The count itself is only in the tooltip, so it is worth asserting the
    // singular/plural does not read "1 mentions" on a projector.
    expect(rare).toHaveAttribute('title', '1 mention');
    expect(common).toHaveAttribute('title', '4 mentions');
  });

  it('still varies size and colour when every word was said exactly once', () => {
    // The common shape in a live room: everyone types something different, so
    // every count is 1. Keyed on frequency alone the cloud came out as one flat
    // block of identical blue text, which is what made it unreadable.
    const { container } = render(
      <ShortResults
        results={{
          slideId: 's2b',
          type: 'wordcloud',
          totalResponses: 6,
          gradable: false,
          maxCount: 1,
          words: ['entropy', 'enthalpy', 'gibbs', 'spontaneity', 'reversible', 'isotherm'].map((text) => ({
            text,
            count: 1,
          })),
        }}
      />,
    );

    const words = ['entropy', 'enthalpy', 'gibbs', 'spontaneity', 'reversible', 'isotherm'];

    const sizes = words.map((text) => window.getComputedStyle(screen.getByText(text)).fontSize);
    expect(new Set(sizes).size).toBeGreaterThan(1);

    // The colour is a theme token, which jsdom cannot resolve through
    // getComputedStyle — the generated rule is where it actually lands.
    const sheet = [...document.querySelectorAll('style')].map((tag) => tag.textContent || '').join('\n');
    const colourOf = (text) => {
      const node = screen.getByText(text);
      const generated = [...node.classList].find((name) => sheet.includes(`.${name}{`));
      return (sheet.match(new RegExp(`\\.${generated}\\{[^}]*[;{]color:([^;}]+)`)) || [])[1];
    };
    const colours = words.map(colourOf);
    expect(colours.every(Boolean)).toBe(true);
    expect(new Set(colours).size).toBeGreaterThan(1);

    // Six words must not be strung along a single line — the cloud is dealt into
    // rows so it fills a block the way a projector audience expects.
    expect(container.querySelectorAll('.chakra-wrap').length).toBeGreaterThan(1);
  });

  it('shows a scale average and median from the server rather than recomputing', () => {
    render(
      <ShortResults
        results={{
          slideId: 's3',
          type: 'scale',
          totalResponses: 3,
          gradable: false,
          min: 1,
          max: 3,
          minLabel: 'Lost',
          maxLabel: 'Clear',
          buckets: [
            { value: 1, count: 0, percent: 0 },
            { value: 2, count: 1, percent: 33.3 },
            { value: 3, count: 2, percent: 66.7 },
          ],
          average: 2.67,
          median: 3,
        }}
      />,
    );

    expect(screen.getByText('2.67')).toBeInTheDocument();
    expect(screen.getByText('Lost')).toBeInTheDocument();
    expect(screen.getByText('Clear')).toBeInTheDocument();
  });

  it('shows an em dash rather than 0 when a numeric slide has no answers', () => {
    // Printing 0 for "nobody answered" is the mistake worth guarding: on a
    // projector it reads as the room having estimated zero.
    render(
      <ShortResults
        results={{
          slideId: 's4',
          type: 'numeric',
          totalResponses: 0,
          gradable: false,
          average: null,
          median: null,
          lowest: null,
          highest: null,
          buckets: [],
        }}
      />,
    );

    expect(screen.getByText('No answers yet.')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBe(4);
  });

  it('lists ranking items in aggregate order with their Borda points', () => {
    render(
      <ShortResults
        results={{
          slideId: 's5',
          type: 'ranking',
          totalResponses: 2,
          gradable: true,
          items: [
            { index: 1, label: 'Second in the list', points: 6, placements: 2, averagePosition: 3, rank: 1 },
            { index: 0, label: 'First in the list', points: 2, placements: 2, averagePosition: 1, rank: 2 },
          ],
          correctOrder: ['First in the list', 'Second in the list'],
        }}
      />,
    );

    // The item with the most points is rank 1 even though it is second in the
    // authored option list — the ordering must follow points, not index.
    expect(screen.getByText('Second in the list')).toBeInTheDocument();
    expect(screen.getByText('6 pts')).toBeInTheDocument();
    expect(screen.getByText(/Correct order: First in the list → Second in the list/)).toBeInTheDocument();
  });

  it('renders open-text answers as cards, anonymously when the server omits names', () => {
    render(
      <ShortResults
        results={{
          slideId: 's6',
          type: 'open',
          totalResponses: 2,
          gradable: false,
          entries: [
            { text: 'The integral diverges.', name: '', at: '2026-01-01T10:00:00Z' },
            { text: 'It converges to pi.', name: 'Asha', at: '2026-01-01T10:00:01Z' },
          ],
        }}
      />,
    );

    expect(screen.getByText('The integral diverges.')).toBeInTheDocument();
    expect(screen.getByText('— Asha')).toBeInTheDocument();
    // An empty name must not render a stray dash.
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('renders nothing at all when there are no results yet', () => {
    const { container } = render(<ShortResults results={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
