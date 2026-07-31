import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import NotebookCell from '../components/NotebookCell';

/**
 * The output pane is where a student reads what their code did, so the failure
 * that matters is output rendered wrongly or silently not at all — a traceback
 * that looks like ordinary print output, or a figure that never appears.
 *
 * CodeMirror is stubbed: it needs layout APIs jsdom does not implement, and the
 * editor is not what these tests are about.
 */
vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, editable }) => (
    <textarea data-testid="editor" readOnly={editable === false} value={value} onChange={() => {}} />
  ),
}));
vi.mock('@codemirror/lang-python', () => ({ python: () => [] }));

const codeCell = (overrides = {}) => ({
  _id: 'c1',
  type: 'code',
  source: 'print("hi")',
  locked: false,
  outputs: [],
  runCount: 0,
  ...overrides,
});

const noop = () => {};
const props = {
  index: 0,
  total: 2,
  onChange: noop,
  onRun: noop,
  onStop: noop,
  onMove: noop,
  onDelete: noop,
};

describe('learningModule <NotebookCell />', () => {
  it('shows stdout as it was printed, preserving whitespace', () => {
    render(
      <NotebookCell
        {...props}
        cell={codeCell({ outputs: [{ type: 'stdout', text: 'line one\n  indented\n' }] })}
      />,
    );
    const block = screen.getByText(/line one/);
    expect(block.tagName).toBe('PRE');
    expect(block.textContent).toContain('  indented');
  });

  it('renders a base64 figure as an image rather than as text', () => {
    // Without this a matplotlib plot would print a wall of base64 at the
    // student, which reads as the code having gone wrong.
    render(<NotebookCell {...props} cell={codeCell({ outputs: [{ type: 'image', text: 'AAAB' }] })} />);
    const image = screen.getByRole('img');
    expect(image).toHaveAttribute('src', 'data:image/png;base64,AAAB');
  });

  it('renders nothing at all when a cell has never been run', () => {
    // An empty output box under every cell would double the page length before
    // the student has done anything.
    const { container } = render(<NotebookCell {...props} cell={codeCell()} />);
    expect(container.querySelector('pre')).toBeNull();
  });

  it('shows a running indicator before any output has arrived', () => {
    render(<NotebookCell {...props} cell={codeCell()} running />);
    expect(screen.getByText('Running…')).toBeInTheDocument();
  });

  it('offers Stop instead of Run while the cell is running', () => {
    const { rerender } = render(<NotebookCell {...props} cell={codeCell()} />);
    expect(screen.getByLabelText('Run cell')).toBeInTheDocument();

    rerender(<NotebookCell {...props} cell={codeCell()} running />);
    expect(screen.getByLabelText('Stop')).toBeInTheDocument();
    expect(screen.queryByLabelText('Run cell')).not.toBeInTheDocument();
  });

  it('marks a locked cell and hides its editing controls', () => {
    render(<NotebookCell {...props} cell={codeCell({ locked: true })} />);
    expect(screen.getByText('locked')).toBeInTheDocument();
    // Reordering or deleting a locked setup cell would break the notebook for
    // that student with nothing on screen explaining why.
    expect(screen.queryByLabelText('Delete cell')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Move cell up')).not.toBeInTheDocument();
  });

  it('still lets a locked cell be run', () => {
    render(<NotebookCell {...props} cell={codeCell({ locked: true })} />);
    expect(screen.getByLabelText('Run cell')).toBeEnabled();
  });

  it('shows the execution count so a stale cell is visible', () => {
    render(<NotebookCell {...props} cell={codeCell({ runCount: 3 })} />);
    expect(screen.getByText('[3]')).toBeInTheDocument();
  });

  it('renders a markdown cell as prose when read-only', () => {
    render(<NotebookCell {...props} readOnly cell={{ _id: 'm1', type: 'markdown', source: '# Lab 1' }} />);
    expect(screen.getByText('Lab 1')).toBeInTheDocument();
    // Prose has nothing to execute.
    expect(screen.queryByLabelText('Run cell')).not.toBeInTheDocument();
  });

  it('renders every output in order, so print-then-error reads correctly', () => {
    const { container } = render(
      <NotebookCell
        {...props}
        cell={codeCell({
          outputs: [
            { type: 'stdout', text: 'before' },
            { type: 'error', text: 'ZeroDivisionError: division by zero' },
          ],
        })}
      />,
    );
    const blocks = [...container.querySelectorAll('pre')].map((node) => node.textContent);
    expect(blocks).toEqual(['before', 'ZeroDivisionError: division by zero']);
  });

  it('disables Run when the kernel is not ready', () => {
    render(<NotebookCell {...props} cell={codeCell()} canRun={false} />);
    expect(screen.getByLabelText('Run cell')).toBeDisabled();
  });
});
