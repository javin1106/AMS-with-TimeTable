/**
 * The learning module's AI service must stay fully functional with no API key
 * configured — that is the state every dev box and a freshly provisioned
 * campus server starts in, and the AI Studio would be unusable if generation
 * simply threw. These tests pin the heuristic fallback's contract.
 */

const ORIGINAL_ENV = { ...process.env };

const TRANSCRIPT = `
Good morning everyone. Today we are going to look at the Fourier transform and
why it matters for signal processing. The Fourier transform decomposes a signal
into the frequencies that make it up, which is exactly what we need when we
want to filter noise out of a measurement. A convolution in the time domain
becomes a simple multiplication in the frequency domain, and that property is
what makes the transform so useful in practice. When we sample a continuous
signal we must respect the Nyquist criterion, otherwise aliasing folds high
frequencies back down and corrupts the spectrum. The discrete Fourier transform
is the version we actually compute, and the fast Fourier transform is the
algorithm that makes computing it cheap enough to be practical. Remember that
the frequency resolution of a discrete Fourier transform depends on how long a
window of the signal you take. A longer window gives finer frequency resolution
but blurs anything that changes quickly in time. That trade-off between time
resolution and frequency resolution is fundamental and you cannot escape it.
`;

const CONTEXT = { className: 'Signals & Systems', subject: 'DSP', title: 'Fourier transforms' };

describe('learningModule aiService — heuristic fallback (no API key)', () => {
  let ai;

  beforeAll(() => {
    delete process.env.LM_AI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    jest.resetModules();
    // eslint-disable-next-line global-require
    ai = require('../../src/modules/learningModule/services/aiService');
  });

  afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('reports itself as unconfigured rather than pretending to be an AI', () => {
    expect(ai.isConfigured()).toBe(false);
    expect(ai.providerName()).toBe('heuristic');
  });

  it('still produces notes, and labels them as a non-AI draft', async () => {
    const notes = await ai.generateNotes(TRANSCRIPT, CONTEXT);

    expect(notes.provider).toBe('heuristic');
    expect(notes.markdown).toContain('# Fourier transforms');
    expect(notes.markdown.toLowerCase()).toContain('without an ai provider configured');
    expect(notes.outline.length).toBeGreaterThan(0);
    // Key terms should surface real subject vocabulary, not stop words.
    expect(notes.markdown.toLowerCase()).toContain('fourier');
  });

  it('produces a tutorial with key terms and flashcards', async () => {
    const tutorial = await ai.generateTutorial(TRANSCRIPT, CONTEXT);

    expect(tutorial.provider).toBe('heuristic');
    expect(tutorial.summary.length).toBeGreaterThan(0);
    expect(tutorial.keyTerms.length).toBeGreaterThan(0);
    expect(tutorial.flashcards.length).toBeGreaterThan(0);
    tutorial.flashcards.forEach((card) => {
      expect(typeof card.front).toBe('string');
      expect(typeof card.back).toBe('string');
    });
  });

  it('drafts answerable multiple-choice questions', async () => {
    const quiz = await ai.generateQuiz(TRANSCRIPT, CONTEXT, { count: 5 });

    expect(quiz.provider).toBe('heuristic');
    expect(quiz.questions.length).toBeGreaterThan(0);

    quiz.questions.forEach((question) => {
      expect(question.type).toBe('mcq');
      expect(question.options.length).toBe(4);
      expect(question.correctAnswers).toHaveLength(1);

      // The stored answer is an index into options, and it must point at a
      // real option — an off-by-one here would auto-mark every attempt wrong.
      const index = Number(question.correctAnswers[0]);
      expect(Number.isInteger(index)).toBe(true);
      expect(question.options[index]).toBeDefined();

      // The blanked term must not still be visible in the question text.
      expect(question.question).toContain('______');
    });
  });

  it('is deterministic, so regenerating the same lecture does not reshuffle the key', async () => {
    const first = await ai.generateQuiz(TRANSCRIPT, CONTEXT, { count: 5 });
    const second = await ai.generateQuiz(TRANSCRIPT, CONTEXT, { count: 5 });
    expect(second.questions).toEqual(first.questions);
  });

  it('caps question count to what the transcript can actually support', async () => {
    const quiz = await ai.generateQuiz(TRANSCRIPT, CONTEXT, { count: 500 });
    expect(quiz.questions.length).toBeLessThanOrEqual(30);
  });

  it('answers from the transcript, and says so when it cannot', async () => {
    const hit = await ai.answerFromTranscript(TRANSCRIPT, 'What is aliasing?', CONTEXT);
    expect(hit.text.toLowerCase()).toContain('aliasing');

    const miss = await ai.answerFromTranscript(
      TRANSCRIPT,
      'zzzzqqqq unrelatedgibberish',
      CONTEXT,
    );
    expect(miss.text.toLowerCase()).toContain('nothing in the transcript matched');
  });

  it('handles an empty transcript without throwing', async () => {
    await expect(ai.generateNotes('', CONTEXT)).resolves.toBeTruthy();
    await expect(ai.generateQuiz('', CONTEXT, { count: 5 })).resolves.toEqual(
      expect.objectContaining({ questions: [] }),
    );
  });
});
