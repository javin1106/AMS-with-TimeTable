import { describe, expect, it } from 'vitest';

import { cellsFromFile, cellsFromIpynb, cellsFromPython } from '../notebookImport';

/**
 * The failures that matter here are the quiet ones: a cell dropped off the end
 * of the file, a docstring splitting the import in half, or markdown arriving
 * with its comment hashes still attached. All of those produce a notebook that
 * looks plausible and is wrong.
 */

describe('learningModule cellsFromPython', () => {
  it('splits on the # %% markers every Python editor writes', () => {
    const { cells, marked } = cellsFromPython(['# %%', 'x = 1', '', '# %%', 'print(x)'].join('\n'));
    expect(marked).toBe(true);
    expect(cells).toEqual([
      { type: 'code', source: 'x = 1' },
      { type: 'code', source: 'print(x)' },
    ]);
  });

  it('accepts #%% without the space, and a label after the marker', () => {
    const { cells } = cellsFromPython(['#%% setup', 'import math', '# %%  Part two', 'math.pi'].join('\n'));
    expect(cells.map((cell) => cell.source)).toEqual(['import math', 'math.pi']);
  });

  it('keeps code above the first marker rather than dropping it', () => {
    // A shebang and a block of imports usually sit above the first cell.
    const { cells } = cellsFromPython(['import numpy as np', '', '# %%', 'np.zeros(3)'].join('\n'));
    expect(cells).toEqual([
      { type: 'code', source: 'import numpy as np' },
      { type: 'code', source: 'np.zeros(3)' },
    ]);
  });

  it('keeps the last cell in a file with no trailing newline', () => {
    const { cells } = cellsFromPython('# %%\nfirst = 1\n# %%\nlast = 2');
    expect(cells[cells.length - 1].source).toBe('last = 2');
  });

  it('reads a [markdown] cell as prose, without the comment hashes', () => {
    const source = ['# %% [markdown]', '# # Lab 1', '#', '# Work through each cell.', '# %%', 'x = 1'].join('\n');
    const { cells } = cellsFromPython(source);
    expect(cells[0]).toEqual({ type: 'markdown', source: '# Lab 1\n\nWork through each cell.' });
    expect(cells[1].type).toBe('code');
  });

  it('leaves a markdown heading its own hashes', () => {
    // Only the comment marker comes off; `###` is the heading level.
    const { cells } = cellsFromPython('# %% [md]\n# ### Deeper heading');
    expect(cells[0].source).toBe('### Deeper heading');
  });

  it('reads the # In[n]: markers nbconvert writes', () => {
    const { cells } = cellsFromPython(['# In[1]:', 'a = 1', '', '# In[ ]:', 'b = 2'].join('\n'));
    expect(cells.map((cell) => cell.source)).toEqual(['a = 1', 'b = 2']);
  });

  it('does not split on a marker inside a docstring', () => {
    const source = ['def explain():', '    """', '    Use # %% to split cells.', '    """', '    return 1'].join('\n');
    const { cells, marked } = cellsFromPython(source);
    expect(marked).toBe(false);
    expect(cells).toHaveLength(1);
    expect(cells[0].source).toBe(source);
  });

  it('does not split on a trailing comment that happens to say %%', () => {
    const { cells } = cellsFromPython('x = 1  # %% not a boundary\ny = 2');
    expect(cells).toHaveLength(1);
  });

  it('imports an unmarked file as a single cell rather than guessing', () => {
    // Chopping a plain script on blank lines produces a notebook the teacher
    // then has to repair by hand.
    const source = ['import os', '', '', 'def main():', '    pass'].join('\n');
    const { cells, marked } = cellsFromPython(source);
    expect(marked).toBe(false);
    expect(cells).toEqual([{ type: 'code', source }]);
  });

  it('preserves indentation and blank lines inside a cell', () => {
    const body = ['def f():', '    if True:', '', '        return 2'].join('\n');
    const { cells } = cellsFromPython(`# %%\n${body}\n`);
    expect(cells[0].source).toBe(body);
  });

  it('drops empty cells instead of importing blank boxes', () => {
    const { cells } = cellsFromPython(['# %%', '', '# %%', 'x = 1', '# %%', '   ', '# %% [markdown]', '#'].join('\n'));
    expect(cells).toEqual([{ type: 'code', source: 'x = 1' }]);
  });

  it('handles CRLF line endings', () => {
    const { cells } = cellsFromPython('# %%\r\nx = 1\r\n# %%\r\ny = 2\r\n');
    expect(cells.map((cell) => cell.source)).toEqual(['x = 1', 'y = 2']);
  });

  it('returns nothing for an empty file', () => {
    expect(cellsFromPython('').cells).toEqual([]);
    expect(cellsFromPython('   \n\n').cells).toEqual([]);
  });
});

const ipynb = (cells, extra = {}) =>
  JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells, ...extra });

describe('learningModule cellsFromIpynb', () => {
  it('joins a line-list source without inserting blank lines', () => {
    // `source` lines already end in \n. Joining them on \n again double-spaces
    // every cell in the file, which is the classic way to botch this import.
    const { cells } = cellsFromIpynb(
      ipynb([{ cell_type: 'code', source: ['import os\n', 'print(os.name)\n'], outputs: [] }]),
    );
    expect(cells).toEqual([{ type: 'code', source: 'import os\nprint(os.name)' }]);
  });

  it('accepts a source given as one plain string', () => {
    const { cells } = cellsFromIpynb(ipynb([{ cell_type: 'code', source: 'x = 1\ny = 2' }]));
    expect(cells[0].source).toBe('x = 1\ny = 2');
  });

  it('keeps markdown as markdown, hashes and all', () => {
    const { cells } = cellsFromIpynb(
      ipynb([{ cell_type: 'markdown', source: ['# Lab 1\n', '\n', 'Work through it.\n'] }]),
    );
    // Prose in an .ipynb is already markdown — nothing to strip.
    expect(cells[0]).toEqual({ type: 'markdown', source: '# Lab 1\n\nWork through it.' });
  });

  it('drops stored outputs rather than importing someone else’s run', () => {
    const { cells } = cellsFromIpynb(
      ipynb([
        {
          cell_type: 'code',
          source: '2 + 2',
          execution_count: 7,
          outputs: [{ output_type: 'execute_result', data: { 'text/plain': ['4'] } }],
        },
      ]),
    );
    expect(cells).toEqual([{ type: 'code', source: '2 + 2' }]);
  });

  it('counts cells it cannot represent instead of dropping them silently', () => {
    const { cells, skipped } = cellsFromIpynb(
      ipynb([
        { cell_type: 'raw', source: 'nbconvert directive' },
        { cell_type: 'code', source: 'x = 1' },
      ]),
    );
    expect(cells).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('skips empty cells', () => {
    const { cells } = cellsFromIpynb(
      ipynb([
        { cell_type: 'code', source: [] },
        { cell_type: 'markdown', source: ['\n', '   \n'] },
        { cell_type: 'code', source: 'x = 1' },
      ]),
    );
    expect(cells).toEqual([{ type: 'code', source: 'x = 1' }]);
  });

  it('reports the kernel language, so a non-Python notebook can be flagged', () => {
    expect(cellsFromIpynb(ipynb([], { metadata: { language_info: { name: 'python' } } })).language).toBe(
      'python',
    );
    expect(cellsFromIpynb(ipynb([], { metadata: { kernelspec: { language: 'R' } } })).language).toBe('R');
    expect(cellsFromIpynb(ipynb([])).language).toBeNull();
  });

  it('reads the nbformat 3 worksheets layout', () => {
    const doc = JSON.stringify({
      nbformat: 3,
      metadata: {},
      worksheets: [{ cells: [{ cell_type: 'code', input: '', source: 'x = 1' }] }],
    });
    expect(cellsFromIpynb(doc).cells).toEqual([{ type: 'code', source: 'x = 1' }]);
  });

  it('explains a file that is not JSON rather than throwing a parser error', () => {
    expect(() => cellsFromIpynb('{ "cells": [')).toThrow(/not valid JSON/);
  });

  it('rejects JSON that is not a notebook', () => {
    expect(() => cellsFromIpynb('{"hello":"world"}')).toThrow(/no cells/);
  });

  it('caps a huge notebook and says it did', () => {
    const many = Array.from({ length: 250 }, (_, index) => ({ cell_type: 'code', source: `x = ${index}` }));
    const { cells, truncated } = cellsFromIpynb(ipynb(many));
    expect(cells).toHaveLength(200);
    expect(truncated).toBe(true);
  });
});

describe('learningModule magics and packages', () => {
  const codeOf = (out, index = 0) => out.cells[index].source;

  it('turns a cell of Jupyter magics into valid Python', () => {
    // The kernel is plain Pyodide, so an imported cell opening with a magic dies
    // on line 1 with a SyntaxError — which reads as "the import broke it".
    const out = cellsFromIpynb(
      ipynb([
        {
          cell_type: 'code',
          source: ['%matplotlib inline\n', '!pip install pandas\n', 'import pandas as pd\n', 'pd\n'],
        },
      ]),
    );
    expect(codeOf(out)).toBe('import pandas as pd\npd');
    expect(out.packages).toContain('pandas');
    // Neither line is *reported* as removed: one is an install, the other is
    // exactly what the worker's matplotlib shim already does.
    expect(out.magics).toBe(0);
  });

  it('comments out a magic it cannot honour rather than deleting it', () => {
    const out = cellsFromPython('%load_ext autoreload\nx = 1');
    expect(codeOf(out)).toBe('# %load_ext autoreload\nx = 1');
    expect(out.magics).toBe(1);
  });

  it('comments out a shell line that is not an install', () => {
    const out = cellsFromPython('!ls -la\nx = 1');
    expect(codeOf(out)).toBe('# !ls -la\nx = 1');
    expect(out.magics).toBe(1);
  });

  it('keeps the body of a cell magic', () => {
    const out = cellsFromIpynb(ipynb([{ cell_type: 'code', source: '%%time\ntotal = sum(range(10))' }]));
    expect(codeOf(out)).toBe('# %%time\ntotal = sum(range(10))');
  });

  it('reads the get_ipython() calls nbconvert leaves behind', () => {
    // These parse fine and then fail at runtime with a NameError, which is the
    // same problem arriving later and more confusingly.
    const out = cellsFromPython(
      [
        "get_ipython().run_line_magic('matplotlib', 'inline')",
        "get_ipython().system('pip install seaborn')",
        "get_ipython().run_line_magic('pip', 'install altair')",
        "get_ipython().run_line_magic('load_ext', 'autoreload')",
        'x = 1',
      ].join('\n'),
    );
    expect(codeOf(out)).toBe("# get_ipython().run_line_magic('load_ext', 'autoreload')\nx = 1");
    expect(out.packages).toEqual(expect.arrayContaining(['seaborn', 'altair']));
  });

  it('strips version pins and flags off an install', () => {
    const out = cellsFromPython('!pip install -q "pandas==1.5.3" scikit-learn[extra] numpy>=1.24');
    expect(out.packages).toEqual(['pandas', 'scikit-learn', 'numpy']);
  });

  it('drops a cell that was nothing but an install', () => {
    const out = cellsFromIpynb(
      ipynb([
        { cell_type: 'code', source: '!pip install pandas' },
        { cell_type: 'code', source: 'x = 1' },
      ]),
    );
    expect(out.cells).toEqual([{ type: 'code', source: 'x = 1' }]);
  });

  it('collects the third-party modules the cells import', () => {
    const out = cellsFromPython(
      ['import os, sys', 'import numpy as np', 'from sklearn.tree import DecisionTreeClassifier', 'import cv2'].join(
        '\n',
      ),
    );
    // Stdlib must never reach the packages box — micropip would go looking for
    // `os` on PyPI and fail for no reason.
    expect(out.packages).not.toContain('os');
    expect(out.packages).not.toContain('sys');
    // And the import name is not always the package name.
    expect(out.packages).toEqual(expect.arrayContaining(['numpy', 'scikit-learn', 'opencv-python']));
  });

  it('installs the top-level package for a submodule import', () => {
    const out = cellsFromPython('import matplotlib.pyplot as plt');
    expect(out.packages).toEqual(['matplotlib']);
  });

  it('ignores imports and magics inside a docstring', () => {
    const source = ['text = """', '%matplotlib inline', 'import nonexistent_package', '"""'].join('\n');
    const out = cellsFromPython(source);
    expect(codeOf(out)).toBe(source);
    expect(out.packages).toEqual([]);
    expect(out.magics).toBe(0);
  });

  it('leaves markdown cells alone', () => {
    const out = cellsFromIpynb(ipynb([{ cell_type: 'markdown', source: '100% of the time\n!important' }]));
    expect(out.cells[0].source).toBe('100% of the time\n!important');
    expect(out.magics).toBe(0);
  });
});

describe('learningModule cellsFromFile', () => {
  it('picks the parser from the extension', () => {
    expect(cellsFromFile('lecture.ipynb', ipynb([{ cell_type: 'code', source: 'x = 1' }])).cells).toEqual([
      { type: 'code', source: 'x = 1' },
    ]);
    expect(cellsFromFile('lecture.py', '# %%\nx = 1').cells).toEqual([{ type: 'code', source: 'x = 1' }]);
    // A .py containing `#%%` must not be run through the JSON parser.
    expect(cellsFromFile('Lab.IPYNB', ipynb([{ cell_type: 'markdown', source: 'hi' }])).cells).toHaveLength(1);
  });
});
