/**
 * The word filter in front of anonymous feedback.
 *
 * Two failure modes, and the second is the one that kills the feature. Letting
 * abuse through is bad; refusing honest criticism is worse, because the student
 * whose complaint about a course was rejected as "abusive" does not rephrase it,
 * they stop using the box. So the clean-text cases below are not padding — they
 * are the ones that must never regress.
 */

const { findProfanity, isClean } = require('../../src/modules/learningModule/services/profanityFilter');

describe('profanity filter — blocks abuse', () => {
  const abusive = [
    ['plain', 'the lectures are fine but the TA is an asshole'],
    ['leetspeak', 'this is complete sh1t'],
    ['symbol substitution', 'the whole course is $hit'],
    ['symbol substitution, @ for a', 'the lab TA is an @sshole'],
    ['doubled letters', 'the grading is bullshiiiit'],
    ['padded characters', 'total f.u.c.k up of a syllabus'],
    ['spaced characters', 'this is b u l l s h i t'],
    ['mixed case', 'the lab assistant is a MoRoN'],
    ['hinglish', 'sir aap bilkul chutiya padhate ho'],
    ['hinglish, spaced', 'ye to b h e n c h o d level ka course hai'],
    ['short exact term', 'this course is ass'],
    ['multi-word term', 'teri maa ki baat karta hai'],
  ];

  abusive.forEach(([label, text]) => {
    it(`catches ${label}`, () => {
      expect(findProfanity(text).length).toBeGreaterThan(0);
    });
  });

  it('names the terms it matched, so the student can rewrite the sentence', () => {
    expect(findProfanity('this is shit and the TA is a moron')).toEqual(
      expect.arrayContaining(['shit', 'moron']),
    );
  });
});

describe('profanity filter — lets honest criticism through', () => {
  const clean = [
    // The Scunthorpe family: innocent words containing a blocked one.
    ['assignment', 'the assignments are far too long for a two-credit course'],
    ['class / pass / assess', 'the class assessment does not assess what we passed'],
    ['analysis', 'the analysis section of the notes was hard to follow'],
    ['Scunthorpe itself', 'I did my schooling in Scunthorpe before joining here'],
    ['dictionary', 'a dictionary of terms would help a lot'],
    ['as, a standalone word', 'as far as I can tell the pace is as fast as it can be'],
    ['hell in hello', 'hello sir, the recorded lectures cut off halfway'],
    ['title in entitled', 'we were entitled to a revision class that never happened'],

    // Harsh but legitimate. The whole point of the channel.
    ['blunt criticism', 'the lectures are boring and the slides are useless'],
    ['a complaint about a person', 'the professor never answers questions and leaves early'],
    ['a serious allegation', 'marks were changed after the paper was shown to us'],
    ['a demand', 'this course is a waste of time and should be restructured'],
  ];

  clean.forEach(([label, text]) => {
    it(`allows ${label}`, () => {
      expect(findProfanity(text)).toEqual([]);
      expect(isClean(text)).toBe(true);
    });
  });
});

describe('profanity filter — edges', () => {
  it('treats empty and blank input as clean', () => {
    ['', '   ', null, undefined].forEach((value) => expect(findProfanity(value)).toEqual([]));
  });

  it('de-duplicates a term repeated in one message', () => {
    expect(findProfanity('shit shit shit')).toEqual(['shit']);
  });
});
