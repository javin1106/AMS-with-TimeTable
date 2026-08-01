const rules = require('../../src/modules/learningModule/services/questionRules');

describe('learningModule questionRules — duplicate options', () => {
  it('ignores formatting when comparing options', () => {
    const options = ['Ohm', '<b>ohm</b>', 'Volt'];
    expect([...rules.duplicateOptionIndexes(options)]).toEqual([1]);
  });

  it('does not flag blank options', () => {
    expect(rules.duplicateOptionIndexes(['A', '', '', 'B'])).toEqual([]);
  });

  it('tells two image-only options apart', () => {
    const options = ['<img src="a.png">', '<img src="b.png">', '<img src="a.png">'];
    expect(rules.duplicateOptionIndexes(options)).toEqual([2]);
  });

  it('treats &nbsp; and stray whitespace as the same answer', () => {
    expect(rules.duplicateOptionIndexes(['9.8 m/s', '<p>9.8&nbsp;m/s </p>'])).toEqual([1]);
  });

  it('names every offending question, one-based', () => {
    const message = rules.duplicateOptionMessage([
      { type: 'mcq', options: ['a', 'b'] },
      { type: 'mcq', options: ['a', 'a'] },
      { type: 'msq', options: ['x', 'y', 'x'] },
    ]);
    expect(message).toMatch(/Questions 2, 3/);
  });

  it('passes a clean paper', () => {
    expect(
      rules.duplicateOptionMessage([
        { type: 'mcq', options: ['a', 'b', 'c', 'd'] },
        { type: 'truefalse', options: ['True', 'False'] },
      ]),
    ).toBeNull();
  });

  it('leaves non-choice questions alone', () => {
    // A numerical question's correctAnswers live in `options`-free territory;
    // repeated text there is not the same defect.
    expect(rules.duplicateOptionMessage([{ type: 'numerical', options: ['1', '1'] }])).toBeNull();
  });
});
