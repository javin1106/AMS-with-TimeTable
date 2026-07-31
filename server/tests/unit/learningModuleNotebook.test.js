/**
 * Notebook cell handling.
 *
 * Python runs in the student's browser, so everything arriving at these
 * functions is client-controlled: the source, the outputs, their size, and which
 * cells claim to exist. That is what these tests are about — the clamping and
 * the locked-cell rules are the only thing between an untrusted tab and the
 * stored document.
 */

const nb = require('../../src/modules/learningModule/services/notebookService');

const cell = (overrides = {}) => ({ type: 'code', source: 'print(1)', ...overrides });

describe('learningModule notebookService — prepareCells', () => {
  it('defaults an unknown cell type to code rather than dropping the cell', () => {
    // Losing a teacher's cell silently would be worse than mislabelling it.
    const [prepared] = nb.prepareCells([{ type: 'raw', source: 'x = 1' }]);
    expect(prepared.type).toBe('code');
    expect(prepared.source).toBe('x = 1');
  });

  it('numbers cells by position when no order is given', () => {
    const prepared = nb.prepareCells([cell(), cell(), cell()]);
    expect(prepared.map((entry) => entry.order)).toEqual([0, 1, 2]);
  });

  it('respects an explicit order so a reorder survives the round trip', () => {
    const prepared = nb.prepareCells([cell({ order: 5 }), cell({ order: 2 })]);
    expect(prepared.map((entry) => entry.order)).toEqual([5, 2]);
  });

  it('refuses to mark a markdown cell hidden', () => {
    // Hidden means "runs but is not shown". Prose does not run, so a hidden
    // markdown cell is just a deleted one with extra steps.
    const [prepared] = nb.prepareCells([{ type: 'markdown', source: '# Title', hidden: true }]);
    expect(prepared.hidden).toBe(false);
  });

  it('keeps hidden and locked flags on code cells', () => {
    const [prepared] = nb.prepareCells([cell({ hidden: true, locked: true })]);
    expect(prepared.hidden).toBe(true);
    expect(prepared.locked).toBe(true);
  });

  it('truncates a source longer than the cap and says so', () => {
    const [prepared] = nb.prepareCells([cell({ source: 'x'.repeat(nb.MAX_SOURCE_LENGTH + 500) })]);
    expect(prepared.source.length).toBeLessThan(nb.MAX_SOURCE_LENGTH + 100);
    expect(prepared.source).toContain('truncated');
  });

  it('caps the number of cells', () => {
    const many = Array.from({ length: nb.MAX_CELLS + 40 }, () => cell());
    expect(nb.prepareCells(many)).toHaveLength(nb.MAX_CELLS);
  });

  it('returns an empty list for junk input rather than throwing', () => {
    expect(nb.prepareCells(null)).toEqual([]);
    expect(nb.prepareCells('cells')).toEqual([]);
  });
});

describe('learningModule notebookService — preparePackages', () => {
  it('keeps ordinary distribution names', () => {
    expect(nb.preparePackages(['numpy', 'scikit-learn', 'ruamel.yaml'])).toEqual([
      'numpy',
      'scikit-learn',
      'ruamel.yaml',
    ]);
  });

  it('drops anything that is not a plausible package name', () => {
    // These reach micropip on the client; a name is a name, not a command.
    expect(
      nb.preparePackages(['numpy; rm -rf /', '../../etc/passwd', 'https://evil.test/x.whl', '', '-flag']),
    ).toEqual([]);
  });

  it('deduplicates', () => {
    expect(nb.preparePackages(['numpy', 'numpy', 'numpy'])).toEqual(['numpy']);
  });
});

describe('learningModule notebookService — seeding a student copy', () => {
  const notebook = {
    cells: [
      { _id: 'a', type: 'markdown', source: '# Lab 1', hidden: false, locked: false },
      { _id: 'b', type: 'code', source: 'import pandas as pd', hidden: true, locked: false },
      { _id: 'c', type: 'code', source: '# your turn', hidden: false, locked: false },
    ],
  };

  it('omits hidden cells from what the student receives', () => {
    const seeded = nb.seedAttemptCells(notebook);
    expect(seeded.map((entry) => String(entry.sourceCellId))).toEqual(['a', 'c']);
  });

  it('renumbers the remaining cells contiguously', () => {
    // Carrying the authored index through would leave a gap where the hidden
    // cell was, and the gap drives the rendering order.
    expect(nb.seedAttemptCells(notebook).map((entry) => entry.order)).toEqual([0, 1]);
  });

  it('hands hidden code back separately, in authored order', () => {
    expect(nb.hiddenSetup(notebook)).toEqual(['import pandas as pd']);
  });

  it('never treats hidden markdown as setup', () => {
    expect(nb.hiddenSetup({ cells: [{ type: 'markdown', source: 'x', hidden: true }] })).toEqual([]);
  });
});

describe('learningModule notebookService — normaliseOutput', () => {
  it('falls back to stdout for an unrecognised stream', () => {
    expect(nb.normaliseOutput({ type: 'javascript', text: 'x' }).type).toBe('stdout');
  });

  it('truncates a runaway print loop', () => {
    const flood = nb.normaliseOutput({ type: 'stdout', text: 'spam\n'.repeat(100000) });
    expect(flood.text.length).toBeLessThan(nb.MAX_OUTPUT_TEXT + 200);
    expect(flood.text).toContain('truncated');
  });

  it('allows an image far larger than the text cap', () => {
    // A matplotlib PNG legitimately dwarfs a traceback; clamping both at the
    // same limit would corrupt every plot.
    const png = nb.normaliseOutput({ type: 'image', text: 'A'.repeat(nb.MAX_OUTPUT_TEXT * 4) });
    expect(png.text).not.toContain('truncated');
  });

  it('survives a missing text field', () => {
    expect(nb.normaliseOutput({ type: 'stderr' }).text).toBe('');
    expect(nb.normaliseOutput(null).type).toBe('stdout');
  });
});

describe('learningModule notebookService — applyStudentCells', () => {
  const stored = [
    { _id: 'c1', type: 'code', source: 'import numpy', locked: true, outputs: [], order: 0 },
    { _id: 'c2', type: 'code', source: '# todo', locked: false, outputs: [], order: 1 },
  ];

  it('saves an edit to an unlocked cell', () => {
    const merged = nb.applyStudentCells(stored, [
      { _id: 'c1', source: 'import numpy' },
      { _id: 'c2', source: 'print(42)' },
    ]);
    expect(merged[1].source).toBe('print(42)');
  });

  it('ignores an edit to a locked cell', () => {
    // The editor is disabled client-side, but the client is not a boundary. A
    // rewritten setup cell would break the sheet for that student invisibly.
    const merged = nb.applyStudentCells(stored, [
      { _id: 'c1', source: 'import os; os.system("hi")' },
      { _id: 'c2', source: 'ok' },
    ]);
    expect(merged[0].source).toBe('import numpy');
  });

  it('restores a locked cell the student deleted', () => {
    const merged = nb.applyStudentCells(stored, [{ _id: 'c2', source: 'ok' }]);
    expect(merged.map((entry) => String(entry._id))).toContain('c1');
  });

  it('lets an unlocked cell be deleted', () => {
    const merged = nb.applyStudentCells(stored, [{ _id: 'c1', source: 'import numpy' }]);
    expect(merged.map((entry) => String(entry._id))).not.toContain('c2');
  });

  it('accepts a new cell when the notebook allows it', () => {
    const merged = nb.applyStudentCells(stored, [
      { _id: 'c1', source: 'import numpy' },
      { _id: 'c2', source: 'ok' },
      { _id: undefined, type: 'code', source: 'extra = 1' },
    ]);
    expect(merged).toHaveLength(3);
    expect(merged[2].source).toBe('extra = 1');
    // A student's own cell is never linked back to an authored one.
    expect(merged[2].sourceCellId).toBeNull();
  });

  it('drops a new cell when the notebook forbids adding', () => {
    const merged = nb.applyStudentCells(
      stored,
      [{ _id: 'c1', source: 'import numpy' }, { _id: 'c2', source: 'ok' }, { source: 'sneaked in' }],
      { allowAddCells: false },
    );
    expect(merged).toHaveLength(2);
  });

  it('never lets a student mark their own cell locked', () => {
    const merged = nb.applyStudentCells(stored, [
      { _id: 'c1', source: 'import numpy' },
      { _id: 'c2', source: 'ok' },
      { source: 'mine', locked: true },
    ]);
    expect(merged[2].locked).toBe(false);
  });

  it('renumbers order from the submitted sequence, so a reorder sticks', () => {
    const merged = nb.applyStudentCells(stored, [
      { _id: 'c2', source: 'ok' },
      { _id: 'c1', source: 'import numpy' },
    ]);
    expect(merged.map((entry) => String(entry._id))).toEqual(['c2', 'c1']);
    expect(merged.map((entry) => entry.order)).toEqual([0, 1]);
  });

  it('clamps a flood of outputs on one cell', () => {
    const outputs = Array.from({ length: 500 }, () => ({ type: 'stdout', text: 'x' }));
    const merged = nb.applyStudentCells(stored, [
      { _id: 'c1', source: 'import numpy' },
      { _id: 'c2', source: 'ok', outputs },
    ]);
    expect(merged[1].outputs).toHaveLength(nb.MAX_OUTPUTS_PER_CELL);
  });

  it('refuses a negative run count', () => {
    const merged = nb.applyStudentCells(stored, [
      { _id: 'c1', source: 'import numpy' },
      { _id: 'c2', source: 'ok', runCount: -5 },
    ]);
    expect(merged[1].runCount).toBe(0);
  });

  it('handles an empty save without wiping locked scaffolding', () => {
    const merged = nb.applyStudentCells(stored, []);
    expect(merged.map((entry) => String(entry._id))).toEqual(['c1']);
  });
});

describe('learningModule notebookService — validateCells', () => {
  it('rejects a notebook with no cells', () => {
    expect(nb.validateCells([])).toContain('Add at least one cell.');
  });

  it('rejects empty prose', () => {
    expect(nb.validateCells(nb.prepareCells([{ type: 'markdown', source: '   ' }]))).toHaveLength(1);
  });

  it('accepts an empty code cell, which is a legitimate blank for the student', () => {
    expect(nb.validateCells(nb.prepareCells([{ type: 'code', source: '' }]))).toEqual([]);
  });
});
