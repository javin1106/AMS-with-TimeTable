const fs = require('fs');
const path = require('path');

const {
  EMBEDDINGS_DIR,
  safeSubject,
  resolveEmbeddingFile,
} = require('../../src/modules/attendanceModule/controllers/embeddingPathResolver');
const {
  escapeRegex,
} = require('../../src/modules/attendanceModule/controllers/classContextResolver');

// The department folder is created by embeddingController from whatever casing
// the generation request supplied, but the scheduler derives its dept from the
// timetable, where deriveBatch() upper-cases it. Fixtures use the mismatched
// pair that actually shipped: written title-case, looked up upper-case.
const SESSION = '__test-session';
const DEPT_ON_DISK = 'Electronics_and_Communication_Engineering';
const DEPT_FROM_TIMETABLE = 'ELECTRONICS AND COMMUNICATION ENGINEERING';
const FILENAME = 'ECDE0353_FPGA_DE_GE_2026-27.pkl';

const sessionDir = path.join(EMBEDDINGS_DIR, SESSION);
const deptDir = path.join(sessionDir, DEPT_ON_DISK);

beforeAll(() => {
  fs.mkdirSync(deptDir, { recursive: true });
  fs.writeFileSync(path.join(deptDir, FILENAME), 'fixture');
});

afterAll(() => {
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

describe('safeSubject', () => {
  it('produces the filename embeddingController generated for FPGA(DE/GE)', () => {
    expect(safeSubject('FPGA(DE/GE)')).toBe('FPGA_DE_GE');
    expect(`ECDE0353_${safeSubject('FPGA(DE/GE)')}_2026-27.pkl`).toBe(FILENAME);
  });
});

describe('resolveEmbeddingFile', () => {
  it('finds the PKL when the dept folder casing differs from the timetable', () => {
    const { path: found } = resolveEmbeddingFile({
      session: SESSION,
      dept: DEPT_FROM_TIMETABLE,
      filename: FILENAME,
    });
    expect(found).not.toBeNull();
    expect(fs.readFileSync(found, 'utf8')).toBe('fixture');
  });

  it('finds the PKL when the dept casing matches exactly', () => {
    const { path: found } = resolveEmbeddingFile({
      session: SESSION,
      dept: DEPT_ON_DISK,
      filename: FILENAME,
    });
    expect(found).not.toBeNull();
  });

  it('names the folder it searched when the dept folder is absent', () => {
    const { path: found, reason } = resolveEmbeddingFile({
      session: SESSION,
      dept: 'MECHANICAL ENGINEERING',
      filename: FILENAME,
    });
    expect(found).toBeNull();
    expect(reason).toMatch(/MECHANICAL_ENGINEERING/);
  });

  it('names the folder it searched when only the file is absent', () => {
    const { path: found, reason } = resolveEmbeddingFile({
      session: SESSION,
      dept: DEPT_FROM_TIMETABLE,
      filename: 'NOT_A_REAL_FILE.pkl',
    });
    expect(found).toBeNull();
    expect(reason).toMatch(/NOT_A_REAL_FILE\.pkl/);
    expect(reason).toMatch(/Electronics_and_Communication_Engineering/i);
  });
});

// The bug this guards: an unescaped subject name is a regex, so "FPGA(DE/GE)"
// reads "(DE/GE)" as a capture group and matches "FPGADE/GE" — never itself.
// Subject.findOne then returned null and the scheduler skipped the room.
describe('subject name as a Mongo $regex', () => {
  const SUBJECT = 'FPGA(DE/GE)';

  it('does not match itself when left unescaped', () => {
    expect(new RegExp(SUBJECT, 'i').test(SUBJECT)).toBe(false);
  });

  it('matches itself once escaped', () => {
    expect(new RegExp(escapeRegex(SUBJECT), 'i').test(SUBJECT)).toBe(true);
  });

  it('escapes every regex metacharacter a subject name can carry', () => {
    for (const name of ['FPGA(DE/GE)', 'C++ Programming', 'Maths-I (PE)', 'A.B.C']) {
      expect(new RegExp(escapeRegex(name), 'i').test(name)).toBe(true);
    }
  });
});
