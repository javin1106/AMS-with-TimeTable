import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

import { renderWithProviders } from '../../test/renderWithProviders';
import lmApi from '../api/lmApi';
import NotebookEditor from '../pages/NotebookEditor';

/**
 * Save and "Save & publish" are two buttons over one request path, so the thing
 * worth pinning down is that they stay distinguishable: only the one that was
 * pressed reports itself as working, and pressing either cannot put a second
 * write in flight — the server replaces `cells` wholesale, so two overlapping
 * saves mean the slower response decides what the notebook contains.
 */

vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value }) => <textarea data-testid="editor" readOnly value={value} onChange={() => {}} />,
}));
vi.mock('@codemirror/lang-python', () => ({ python: () => [] }));

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal()),
  useOutletContext: () => ({ classId: 'c1', isTeacher: true }),
  useParams: () => ({ notebookId: 'n1' }),
  useNavigate: () => vi.fn(),
}));

vi.mock('../api/lmApi', () => ({
  default: {
    getNotebook: vi.fn(),
    updateNotebook: vi.fn(),
    publishNotebook: vi.fn(),
  },
}));

const kernel = {
  status: 'idle',
  detail: '',
  busyCellId: null,
  kernelPackages: null,
  start: vi.fn(),
  restart: vi.fn(),
  runCell: vi.fn(),
  stop: vi.fn(),
};
// The argument matters as much as the return: what the editor hands the hook is
// what a started kernel installs.
let requestedPackages = [];
vi.mock('../hooks/usePyodide', () => ({
  default: (packages) => {
    requestedPackages = packages;
    return kernel;
  },
}));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const notebook = () => ({
  _id: 'n1',
  title: 'Lab 1',
  description: '',
  packages: [],
  published: false,
  settings: {},
  cells: [{ _id: 'c1', type: 'code', source: 'print(1)', locked: false, hidden: false, order: 0 }],
});

const flush = () => act(async () => { await Promise.resolve(); });

describe('learningModule <NotebookEditor /> saving', () => {
  beforeEach(() => {
    kernel.status = 'idle';
    kernel.busyCellId = null;
    kernel.kernelPackages = null;
    requestedPackages = [];
    kernel.runCell.mockReset();
    kernel.restart.mockReset();
    lmApi.getNotebook.mockReset().mockResolvedValue(notebook());
    lmApi.updateNotebook.mockReset().mockResolvedValue({});
    lmApi.publishNotebook.mockReset().mockResolvedValue({ published: true });
  });

  afterEach(() => vi.clearAllMocks());

  const open = async () => {
    renderWithProviders(<NotebookEditor />);
    await screen.findByText('Edit notebook');
  };

  // By label rather than accessible name: Chakra's spinner contributes a
  // "Loading..." of its own to the name of whichever button is working.
  const button = (label) =>
    screen
      .getAllByRole('button')
      .find((node) => node.textContent.replace('Loading...', '').trim() === label);
  const saveButton = () => button('Save');
  const publishButton = () => button('Save & publish');

  it('shows only the pressed button as working', async () => {
    await open();

    const update = deferred();
    lmApi.updateNotebook.mockReturnValue(update.promise);
    fireEvent.click(saveButton());
    await flush();

    expect(saveButton()).toHaveAttribute('data-loading');
    // The other button must not claim to be publishing when nobody asked it to.
    expect(publishButton()).not.toHaveAttribute('data-loading');
    expect(publishButton()).toBeDisabled();

    update.resolve({});
    await waitFor(() => expect(saveButton()).not.toHaveAttribute('data-loading'));
  });

  it('will not put a second write in flight', async () => {
    await open();

    const update = deferred();
    lmApi.updateNotebook.mockReturnValue(update.promise);
    fireEvent.click(saveButton());
    // A double click, or an Enter landing on top of one: both reach the handler
    // before the disabled state has rendered.
    fireEvent.click(publishButton());
    await flush();

    expect(lmApi.updateNotebook).toHaveBeenCalledTimes(1);
    expect(lmApi.publishNotebook).not.toHaveBeenCalled();

    update.resolve({});
    await flush();
  });

  it('reloads after a publish that fails on top of a save that worked', async () => {
    await open();
    expect(lmApi.getNotebook).toHaveBeenCalledTimes(1);

    const rejection = Object.assign(new Error('Fix these before publishing.'), {
      payload: { errors: ['Cell 1: the text is empty.'] },
    });
    lmApi.publishNotebook.mockRejectedValue(rejection);

    fireEvent.click(publishButton());

    // The save is already committed, so the editor has to show what is stored —
    // otherwise it keeps rendering placeholder ids for cells the server has.
    await waitFor(() => expect(lmApi.getNotebook).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Cell 1: the text is empty.')).toBeInTheDocument();
  });

  const pick = (file) =>
    fireEvent.change(screen.getByTestId('notebook-import'), { target: { files: [file] } });

  it('imports a .py file as cells and sends them on the next save', async () => {
    await open();
    expect(screen.getAllByTestId('editor')).toHaveLength(1);

    pick(
      new File(['# %%\nx = 1\n# %% [markdown]\n# Notes\n# %%\nprint(x)\n'], 'lecture.py', {
        type: 'text/x-python',
      }),
    );

    // Appended to what is already here, not a replacement.
    await waitFor(() => expect(screen.getAllByTestId('editor')).toHaveLength(4));

    // Left unsaved on purpose — nothing reaches a student until the teacher
    // has looked at the split and pressed Save.
    expect(lmApi.updateNotebook).not.toHaveBeenCalled();

    fireEvent.click(saveButton());
    await waitFor(() => expect(lmApi.updateNotebook).toHaveBeenCalled());

    const { cells } = lmApi.updateNotebook.mock.calls[0][2];
    expect(cells).toHaveLength(4);
    // A `new-…` placeholder must never be sent as an _id.
    expect(cells.every((cell) => cell._id === undefined || !String(cell._id).startsWith('new-'))).toBe(true);
    expect(cells.slice(1)).toEqual([
      expect.objectContaining({ type: 'code', source: 'x = 1' }),
      expect.objectContaining({ type: 'markdown', source: 'Notes' }),
      expect.objectContaining({ type: 'code', source: 'print(x)' }),
    ]);
  });

  it('imports an .ipynb without its stored outputs', async () => {
    await open();

    const doc = JSON.stringify({
      nbformat: 4,
      metadata: { language_info: { name: 'python' } },
      cells: [
        { cell_type: 'markdown', source: ['## Warm up\n'] },
        {
          cell_type: 'code',
          source: ['total = 0\n', 'for n in range(5):\n', '    total += n\n'],
          execution_count: 2,
          outputs: [{ output_type: 'stream', text: ['10\n'] }],
        },
      ],
    });
    pick(new File([doc], 'lecture.ipynb', { type: 'application/x-ipynb+json' }));

    await waitFor(() => expect(screen.getAllByTestId('editor')).toHaveLength(3));

    fireEvent.click(saveButton());
    await waitFor(() => expect(lmApi.updateNotebook).toHaveBeenCalled());

    const { cells } = lmApi.updateNotebook.mock.calls[0][2];
    expect(cells.slice(1)).toEqual([
      expect.objectContaining({ type: 'markdown', source: '## Warm up' }),
      // The line list is joined on nothing: those lines already end in \n.
      expect.objectContaining({ type: 'code', source: 'total = 0\nfor n in range(5):\n    total += n' }),
    ]);
    // An authored notebook has nowhere to put somebody else's run.
    expect(JSON.stringify(cells)).not.toContain('10');
  });

  it('can run a cell that came in from an import', async () => {
    kernel.status = 'ready';
    kernel.runCell.mockResolvedValue({ result: '42', error: null });
    await open();

    pick(new File(['# %%\nx = 6 * 7\n# %%\nx\n'], 'lecture.py', { type: 'text/x-python' }));
    await waitFor(() => expect(screen.getAllByTestId('editor')).toHaveLength(3));

    // The last Run button is the last imported cell.
    const runButtons = screen.getAllByLabelText('Run cell');
    fireEvent.click(runButtons[runButtons.length - 1]);

    await waitFor(() => expect(kernel.runCell).toHaveBeenCalled());
    expect(kernel.runCell.mock.calls[0][1]).toBe('x');
    expect(await screen.findByText('42')).toBeInTheDocument();
  });

  it('makes an imported Colab cell runnable and fills in its packages', async () => {
    await open();

    const doc = JSON.stringify({
      nbformat: 4,
      metadata: {},
      cells: [
        { cell_type: 'code', source: ['!pip install -q pandas\n'] },
        {
          cell_type: 'code',
          source: ['%matplotlib inline\n', 'import pandas as pd\n', 'import seaborn as sns\n', 'pd\n'],
        },
      ],
    });
    pick(new File([doc], 'colab.ipynb', { type: 'application/x-ipynb+json' }));

    // The install-only cell has no code left, so one cell arrives, not two.
    await waitFor(() => expect(screen.getAllByTestId('editor')).toHaveLength(2));

    // Magics are IPython syntax; under plain Pyodide they are a SyntaxError on
    // line 1, which is what "imported cells do not run" looks like.
    const imported = screen.getAllByTestId('editor')[1];
    expect(imported).toHaveValue('import pandas as pd\nimport seaborn as sns\npd');

    // And the packages box is filled in, or every cell raises ModuleNotFoundError.
    const packages = screen.getByLabelText('Packages');
    expect(packages.value).toContain('pandas');
    expect(packages.value).toContain('seaborn');

    fireEvent.click(saveButton());
    await waitFor(() => expect(lmApi.updateNotebook).toHaveBeenCalled());
    expect(lmApi.updateNotebook.mock.calls[0][2].packages).toEqual(
      expect.arrayContaining(['pandas', 'seaborn']),
    );
  });

  it('starts the kernel with the packages an import just added, before any save', async () => {
    await open();

    const doc = JSON.stringify({
      nbformat: 4,
      metadata: {},
      cells: [{ cell_type: 'code', source: ['import pandas as pd\n', 'pd.DataFrame()\n'] }],
    });
    pick(new File([doc], 'lab.ipynb', { type: 'application/x-ipynb+json' }));

    // Reading these off the saved notebook instead is what made every imported
    // cell raise ModuleNotFoundError until the teacher saved *and* restarted.
    await waitFor(() => expect(requestedPackages).toContain('pandas'));
  });

  it('offers a restart when a package arrives after the kernel started', async () => {
    kernel.status = 'ready';
    // Started before the import, so it has nothing installed.
    kernel.kernelPackages = [];
    await open();

    expect(screen.queryByText(/Restart it to install/)).not.toBeInTheDocument();

    const doc = JSON.stringify({
      nbformat: 4,
      metadata: {},
      cells: [{ cell_type: 'code', source: ['import pandas as pd\n'] }],
    });
    pick(new File([doc], 'lab.ipynb', { type: 'application/x-ipynb+json' }));

    // Installs happen at startup only, so the running kernel cannot import it
    // however many times the cell is run — say so rather than let it fail.
    expect(await screen.findByText(/Python is already running without pandas/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Restart & install' }));
    expect(kernel.restart).toHaveBeenCalled();
  });

  it('explains an .ipynb it cannot read instead of importing nothing', async () => {
    await open();

    pick(new File(['{"cells": ['], 'broken.ipynb', { type: 'application/x-ipynb+json' }));

    expect(await screen.findByText(/not valid JSON/)).toBeInTheDocument();
    expect(screen.getAllByTestId('editor')).toHaveLength(1);
  });

  it('keeps unsaved edits on screen when the save itself is rejected', async () => {
    await open();

    lmApi.updateNotebook.mockRejectedValue(new Error('Give the notebook a title.'));
    fireEvent.click(saveButton());

    await waitFor(() => expect(lmApi.updateNotebook).toHaveBeenCalled());
    await flush();
    // Reloading here would discard the edits the teacher still has to fix.
    expect(lmApi.getNotebook).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(saveButton()).toBeEnabled());
  });
});
