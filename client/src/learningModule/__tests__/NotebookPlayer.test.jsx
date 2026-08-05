import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

import { renderWithProviders } from '../../test/renderWithProviders';
import lmApi from '../api/lmApi';
import NotebookPlayer from '../pages/NotebookPlayer';

/**
 * The two ways a notebook loses a student's work, both of which come from the
 * same place: autosave replacing local state with the server's copy.
 *
 * A cell the student adds has no `_id` until a save comes back with one, so the
 * swap happens mid-session — and if a run or a keystroke is in flight across it,
 * the thing it was pointing at is gone.
 */

vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange, editable }) => (
    <textarea
      data-testid="editor"
      readOnly={editable === false}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
vi.mock('@codemirror/lang-python', () => ({ python: () => [] }));

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal()),
  useOutletContext: () => ({ classId: 'c1', isTeacher: false }),
  useParams: () => ({ notebookId: 'n1' }),
  useNavigate: () => vi.fn(),
}));

vi.mock('../api/lmApi', () => ({
  default: {
    notebookAttempt: vi.fn(),
    saveNotebookAttempt: vi.fn(),
    submitNotebookAttempt: vi.fn(),
  },
}));

// A kernel that is up and does nothing until the test says so, so a run can be
// held open across an autosave.
const kernel = {
  status: 'ready',
  detail: '',
  busyCellId: null,
  start: vi.fn(),
  restart: vi.fn(),
  stop: vi.fn(),
  runCell: vi.fn(),
};
vi.mock('../hooks/usePyodide', () => ({ default: () => kernel }));

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const seededCell = { _id: 's1', type: 'code', source: 'print(1)', locked: false, outputs: [], runCount: 0 };

const attemptResponse = (cells = [seededCell]) => ({
  notebook: { _id: 'n1', title: 'Lab 1', description: '', packages: [], settings: {}, dueDate: null },
  hiddenSetup: [],
  attempt: { _id: 'a1', revision: 3, submittedAt: null, cells },
  solution: null,
});

/** Lets queued promise callbacks run without advancing the clock. */
const flush = () => act(async () => { await Promise.resolve(); });

const advance = (ms) => act(async () => {
  vi.advanceTimersByTime(ms);
  await Promise.resolve();
});

describe('learningModule <NotebookPlayer />', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    kernel.runCell.mockReset();
    lmApi.notebookAttempt.mockReset().mockResolvedValue(attemptResponse());
    lmApi.saveNotebookAttempt.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const open = async () => {
    renderWithProviders(<NotebookPlayer />);
    await screen.findByText('Lab 1');
  };

  it('shows the output of a cell the student added, even when an autosave lands mid-run', async () => {
    await open();

    fireEvent.click(screen.getByText('+ Code cell'));
    const editors = screen.getAllByTestId('editor');
    fireEvent.change(editors[1], { target: { value: 'x = 6 * 7' } });

    // Hold the run open so the save has to complete while it is still going.
    const run = deferred();
    kernel.runCell.mockReturnValue(run.promise);
    fireEvent.click(screen.getAllByLabelText('Run cell')[1]);

    // The save comes back having given the new cell a real id, which is exactly
    // what the run's output was about to be written against.
    const save = deferred();
    lmApi.saveNotebookAttempt.mockReturnValue(save.promise);
    await advance(2500);
    save.resolve({
      saved: true,
      revision: 4,
      cells: [seededCell, { _id: 'srv2', type: 'code', source: 'x = 6 * 7', locked: false, outputs: [], runCount: 0 }],
    });
    await flush();

    run.resolve({ result: '42', error: null });
    await flush();

    expect(await screen.findByText('42')).toBeInTheDocument();
    // The execution count is the other half of "did this cell run at all".
    expect(screen.getByText('[1]')).toBeInTheDocument();
  });

  it('does not report an edit made during a save as saved', async () => {
    await open();

    const editor = () => screen.getAllByTestId('editor')[0];
    fireEvent.change(editor(), { target: { value: 'first' } });

    const save = deferred();
    lmApi.saveNotebookAttempt.mockReturnValue(save.promise);
    await advance(2500);
    expect(lmApi.saveNotebookAttempt).toHaveBeenCalledTimes(1);

    // Typed while the request is on the wire — the server will not have it.
    fireEvent.change(editor(), { target: { value: 'second' } });
    await advance(2500);

    lmApi.saveNotebookAttempt.mockReturnValue(
      Promise.resolve({ saved: true, revision: 5, cells: [{ ...seededCell, source: 'second' }] }),
    );
    save.resolve({ saved: true, revision: 4, cells: [{ ...seededCell, source: 'first' }] });
    await flush();

    // The badge must not claim the newer text is stored.
    expect(screen.queryByText('saved')).not.toBeInTheDocument();
    // And the edit must not have been reverted to what the server echoed back.
    expect(editor()).toHaveValue('second');

    await advance(2500);
    await waitFor(() => expect(lmApi.saveNotebookAttempt).toHaveBeenCalledTimes(2));
    expect(lmApi.saveNotebookAttempt.mock.calls[1][2].cells[0].source).toBe('second');
  });
});
