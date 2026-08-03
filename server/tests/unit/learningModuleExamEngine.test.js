/**
 * The exam engine decides what paper a student gets and what score they end up
 * with, so its behaviour is the difference between a fair test and a broken one.
 * Pure functions — no database.
 */

const engine = require('../../src/modules/learningModule/services/examEngine');

const oid = (hex) => ({ toString: () => hex, _bsontype: 'ObjectId' });

const QUIZ = {
  _id: 'quiz-1',
  sections: [
    { _id: 'secA', name: 'Aptitude', order: 0 },
    { _id: 'secB', name: 'Coding', order: 1 },
  ],
  questions: [
    { _id: 'q1', question: 'A1', type: 'mcq', options: ['a', 'b', 'c', 'd'], correctAnswers: ['0'], marks: 2, sectionId: 'secA', sectionName: 'Aptitude', order: 0 },
    { _id: 'q2', question: 'A2', type: 'msq', options: ['a', 'b', 'c'], correctAnswers: ['0', '2'], marks: 3, sectionId: 'secA', sectionName: 'Aptitude', order: 1 },
    { _id: 'q3', question: 'C1', type: 'numerical', options: [], correctAnswers: ['42'], tolerancePercent: 1, marks: 4, sectionId: 'secB', sectionName: 'Coding', order: 0 },
    { _id: 'q4', question: 'C2', type: 'truefalse', options: ['True', 'False'], correctAnswers: ['0'], marks: 1, sectionId: 'secB', sectionName: 'Coding', order: 1 },
  ],
  settings: { negativeMarking: 1, passPercent: 50 },
};

describe('learningModule examEngine — buildPaper', () => {
  it('keeps the authored order when shuffling is off', () => {
    const paper = engine.buildPaper(QUIZ, 'student-a', 1);
    expect(paper.questionOrder).toEqual(['q1', 'q2', 'q3', 'q4']);
    expect(paper.maxScore).toBe(10);
  });

  it('is deterministic per student and attempt', () => {
    const quiz = { ...QUIZ, settings: { ...QUIZ.settings, shuffleQuestions: true } };
    const first = engine.buildPaper(quiz, 'student-a', 1);
    const second = engine.buildPaper(quiz, 'student-a', 1);
    expect(second.questionOrder).toEqual(first.questionOrder);
  });

  it('never moves a question out of its section', () => {
    const quiz = { ...QUIZ, settings: { ...QUIZ.settings, shuffleQuestions: true } };
    for (let i = 0; i < 30; i += 1) {
      const paper = engine.buildPaper(quiz, `student-${i}`, 1);
      const sectionOf = (id) => QUIZ.questions.find((q) => q._id === id).sectionId;
      const sections = paper.questionOrder.map(sectionOf);
      // Every Aptitude question must precede every Coding question.
      expect(sections).toEqual(['secA', 'secA', 'secB', 'secB']);
    }
  });

  it('gives different students different orders', () => {
    const quiz = { ...QUIZ, settings: { ...QUIZ.settings, shuffleQuestions: true } };
    const seen = new Set();
    for (let i = 0; i < 30; i += 1) {
      seen.add(engine.buildPaper(quiz, `student-${i}`, 1).questionOrder.join(','));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('draws a subset when questionsPerAttempt is set', () => {
    const quiz = { ...QUIZ, settings: { ...QUIZ.settings, questionsPerAttempt: 2 } };
    const paper = engine.buildPaper(quiz, 'student-a', 1);
    expect(paper.questionOrder).toHaveLength(2);
    // maxScore reflects the drawn paper, not the whole bank.
    expect(paper.maxScore).toBeLessThan(10);
  });

  it('shuffles options but leaves True/False alone', () => {
    const quiz = { ...QUIZ, settings: { ...QUIZ.settings, shuffleOptions: true } };
    const paper = engine.buildPaper(quiz, 'student-a', 1);
    expect(paper.optionOrder.q1).toHaveLength(4);
    expect([...paper.optionOrder.q1].sort()).toEqual([0, 1, 2, 3]);
    expect(paper.optionOrder.q4).toBeUndefined();
    // Numerical questions have no options to shuffle.
    expect(paper.optionOrder.q3).toBeUndefined();
  });
});

describe('learningModule examEngine — student view and option mapping', () => {
  it('strips the answer key and explanation', () => {
    const view = engine.questionForStudent(
      { ...QUIZ.questions[0], explanation: 'because', correctAnswers: ['0'] },
      null,
    );
    expect(view.correctAnswers).toBeUndefined();
    expect(view.explanation).toBeUndefined();
    expect(view.question).toBe('A1');
  });

  it('presents options in the student’s own order', () => {
    const view = engine.questionForStudent(QUIZ.questions[0], [2, 0, 3, 1]);
    expect(view.options).toEqual(['c', 'a', 'd', 'b']);
  });

  it('maps a click back to the original index so marking still works', () => {
    // The student was shown ['c','a','d','b'] and clicked position 1 = 'a',
    // which is original index 0 — the correct answer.
    expect(engine.normaliseSelected(['1'], [2, 0, 3, 1])).toEqual(['0']);
    expect(engine.normaliseSelected(['0'], [2, 0, 3, 1])).toEqual(['2']);
  });

  it('passes selections through untouched when options were not shuffled', () => {
    expect(engine.normaliseSelected(['2'], null)).toEqual(['2']);
  });

  it('discards out-of-range positions rather than mapping them wrongly', () => {
    expect(engine.normaliseSelected(['9', 'x'], [2, 0, 3, 1])).toEqual([]);
  });
});

describe('learningModule examEngine — markAnswer', () => {
  it('marks single choice', () => {
    expect(engine.markAnswer(QUIZ.questions[0], { selected: ['0'] }, 1).awarded).toBe(2);
    expect(engine.markAnswer(QUIZ.questions[0], { selected: ['1'] }, 1).awarded).toBe(-1);
  });

  it('requires the exact set for multi-select, ignoring order', () => {
    expect(engine.markAnswer(QUIZ.questions[1], { selected: ['2', '0'] }, 1).correct).toBe(true);
    expect(engine.markAnswer(QUIZ.questions[1], { selected: ['0'] }, 1).correct).toBe(false);
    expect(engine.markAnswer(QUIZ.questions[1], { selected: ['0', '1', '2'] }, 1).correct).toBe(false);
  });

  it('marks numerical answers within tolerance', () => {
    expect(engine.markAnswer(QUIZ.questions[2], { text: '42' }, 1).correct).toBe(true);
    expect(engine.markAnswer(QUIZ.questions[2], { text: '42.3' }, 1).correct).toBe(true); // within 1%
    expect(engine.markAnswer(QUIZ.questions[2], { text: '45' }, 1).correct).toBe(false);
  });

  it('accepts an absolute tolerance for numerical answers near zero', () => {
    const question = { type: 'numerical', correctAnswers: ['0.0001'], toleranceAbs: 0.00005, marks: 1 };
    expect(engine.markAnswer(question, { text: '0.00011' }, 0).correct).toBe(true);
    expect(engine.markAnswer(question, { text: '0.001' }, 0).correct).toBe(false);
  });

  it('never penalises an unattempted question', () => {
    expect(engine.markAnswer(QUIZ.questions[0], { selected: [] }, 5)).toEqual({
      correct: false,
      attempted: false,
      awarded: 0,
    });
    expect(engine.markAnswer(QUIZ.questions[2], { text: '' }, 5).awarded).toBe(0);
  });

  it('handles a non-numeric answer to a numerical question', () => {
    const result = engine.markAnswer(QUIZ.questions[2], { text: 'forty two' }, 1);
    expect(result.attempted).toBe(true);
    expect(result.correct).toBe(false);
  });
});

describe('learningModule examEngine — scoreAttempt', () => {
  const attemptWith = (responses) => ({
    questionOrder: ['q1', 'q2', 'q3', 'q4'],
    optionOrder: {},
    startedAt: new Date(),
    responses,
  });

  it('rolls up score, counts and section breakdown', () => {
    const result = engine.scoreAttempt(
      QUIZ,
      attemptWith([
        { questionId: 'q1', selected: ['0'], timeSpentSec: 10 },   // correct  +2
        { questionId: 'q2', selected: ['1'], timeSpentSec: 20 },   // wrong    -1
        { questionId: 'q3', text: '42', timeSpentSec: 30 },        // correct  +4
        // q4 left unanswered                                        unattempted 0
      ]),
    );

    expect(result.score).toBe(5);
    expect(result.maxScore).toBe(10);
    expect(result.totalCorrect).toBe(2);
    expect(result.totalWrong).toBe(1);
    expect(result.totalUnattempted).toBe(1);
    expect(result.negativeApplied).toBe(1);
    expect(result.percent).toBe(50);
    expect(result.passed).toBe(true);

    const aptitude = result.sectionScores.find((s) => s.sectionName === 'Aptitude');
    expect(aptitude).toMatchObject({ score: 1, maxScore: 5, correct: 1, wrong: 1, unattempted: 0 });
    expect(aptitude.timeSpentSec).toBe(30);

    const coding = result.sectionScores.find((s) => s.sectionName === 'Coding');
    expect(coding).toMatchObject({ score: 4, maxScore: 5, correct: 1, wrong: 0, unattempted: 1 });
  });

  it('clamps a negatively-marked wipeout to zero but keeps the raw figure', () => {
    const result = engine.scoreAttempt(
      QUIZ,
      attemptWith([
        { questionId: 'q1', selected: ['1'] },
        { questionId: 'q2', selected: ['1'] },
        { questionId: 'q3', text: '0' },
        { questionId: 'q4', selected: ['1'] },
      ]),
    );
    expect(result.rawScore).toBe(-4);
    expect(result.score).toBe(0);
    expect(result.percent).toBe(0);
    expect(result.totalWrong).toBe(4);
  });

  it('uses a per-question negative mark over the quiz default', () => {
    const quiz = {
      ...QUIZ,
      questions: [{ ...QUIZ.questions[0], negativeMarks: 0 }],
    };
    const result = engine.scoreAttempt(quiz, {
      questionOrder: ['q1'],
      optionOrder: {},
      startedAt: new Date(),
      responses: [{ questionId: 'q1', selected: ['1'] }],
    });
    // Quiz default is 1, but this question overrides it to 0.
    expect(result.rawScore).toBe(0);
    expect(result.negativeApplied).toBe(0);
  });

  it('scores only the questions the student was dealt', () => {
    const result = engine.scoreAttempt(QUIZ, {
      questionOrder: ['q3'],
      optionOrder: {},
      startedAt: new Date(),
      responses: [{ questionId: 'q3', text: '42' }],
    });
    expect(result.maxScore).toBe(4);
    expect(result.percent).toBe(100);
    expect(result.responses).toHaveLength(1);
  });

  it('ignores a response to a question that is no longer on the paper', () => {
    const result = engine.scoreAttempt(QUIZ, {
      questionOrder: ['q1'],
      optionOrder: {},
      startedAt: new Date(),
      responses: [
        { questionId: 'q1', selected: ['0'] },
        { questionId: 'deleted-q', selected: ['0'] },
      ],
    });
    expect(result.responses).toHaveLength(1);
    expect(result.score).toBe(2);
  });

  it('accepts a Mongoose Map for optionOrder', () => {
    const result = engine.scoreAttempt(QUIZ, {
      questionOrder: ['q1'],
      optionOrder: new Map([['q1', [1, 0, 2, 3]]]),
      startedAt: new Date(),
      responses: [{ questionId: 'q1', selected: ['0'] }],
    });
    expect(result.optionOrder).toEqual({ q1: [1, 0, 2, 3] });
  });
});

describe('learningModule examEngine — windows and timing', () => {
  const at = (iso) => new Date(iso);

  it('reports a quiz not yet open', () => {
    const quiz = { settings: { availableFrom: at('2026-01-01T10:00:00Z') } };
    const state = engine.windowState(quiz, at('2026-01-01T09:00:00Z'));
    expect(state).toMatchObject({ open: false, notYetOpen: true, canStart: false });
  });

  it('reports a closed quiz', () => {
    const quiz = { settings: { availableTo: at('2026-01-01T10:00:00Z') } };
    const state = engine.windowState(quiz, at('2026-01-01T11:00:00Z'));
    expect(state).toMatchObject({ open: false, closed: true, canStart: false });
  });

  it('keeps the quiz open but blocks a late start past the margin', () => {
    // The distinction the margin window exists for: still open for those
    // already sitting it, closed to new arrivals.
    const quiz = {
      settings: {
        availableFrom: at('2026-01-01T10:00:00Z'),
        availableTo: at('2026-01-01T12:00:00Z'),
        marginMinutes: 15,
      },
    };
    const state = engine.windowState(quiz, at('2026-01-01T10:30:00Z'));
    expect(state.open).toBe(true);
    expect(state.canStart).toBe(false);
    expect(state.lateToStart).toBe(true);
    expect(state.startDeadline).toEqual(at('2026-01-01T10:15:00Z'));
  });

  it('allows a start inside the margin', () => {
    const quiz = {
      settings: { availableFrom: at('2026-01-01T10:00:00Z'), marginMinutes: 15 },
    };
    expect(engine.windowState(quiz, at('2026-01-01T10:05:00Z')).canStart).toBe(true);
  });

  it('treats a quiz with no window as always open', () => {
    expect(engine.windowState({ settings: {} })).toMatchObject({ open: true, canStart: true });
  });

  it('hides results until the release time', () => {
    const quiz = { settings: { resultReleaseAt: at('2026-01-02T00:00:00Z') } };
    expect(engine.resultsVisible(quiz, at('2026-01-01T23:59:00Z'))).toBe(false);
    expect(engine.resultsVisible(quiz, at('2026-01-02T00:01:00Z'))).toBe(true);
    expect(engine.resultsVisible({ settings: {} })).toBe(true);
  });

  it('takes the earliest of the per-question and whole-paper deadlines', () => {
    const start = at('2026-01-01T10:00:00Z');
    const quiz = { settings: { perQuestionTiming: true, timeLimitMinutes: 30 } };
    const attempt = { startedAt: start, currentServedAt: at('2026-01-01T10:20:00Z') };

    // Question allows 60s from 10:20 (→10:21); paper ends at 10:30. Question wins.
    expect(engine.questionDeadline(quiz, attempt, { timeLimitSec: 60 })).toEqual(
      at('2026-01-01T10:21:00Z'),
    );
    // A 20-minute question would run past the paper deadline, so the paper wins.
    expect(engine.questionDeadline(quiz, attempt, { timeLimitSec: 1200 })).toEqual(
      at('2026-01-01T10:30:00Z'),
    );
  });

  it('returns no deadline for an untimed quiz', () => {
    expect(engine.questionDeadline({ settings: {} }, { startedAt: new Date() }, {})).toBeNull();
  });

  it('estimates duration from per-question times or the paper limit', () => {
    expect(
      engine.estimatedDurationSec({
        settings: { perQuestionTiming: true },
        questions: [{ timeLimitSec: 60 }, { timeLimitSec: 90 }],
      }),
    ).toBe(150);
    expect(engine.estimatedDurationSec({ settings: { timeLimitMinutes: 30 }, questions: [] })).toBe(1800);
  });

  it('detects mobile user agents', () => {
    expect(engine.isMobileUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe(true);
    expect(engine.isMobileUserAgent('Mozilla/5.0 (Linux; Android 14)')).toBe(true);
    expect(engine.isMobileUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false);
    expect(engine.isMobileUserAgent('')).toBe(false);
  });
});
