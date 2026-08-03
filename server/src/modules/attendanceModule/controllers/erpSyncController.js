// server/src/modules/attendanceModule/controllers/erpSyncController.js
//
// ERP roster sync — fetches each subject's enrolled roll numbers from the
// external ERP server over HTTP and persists them on the Subject document
// (enrolledRollNos / missedGroundTruth / embeddingUpdatedAt), making Subject
// the roster source of truth for the ERP Sync page. Embedding generation
// itself is NOT here — the page reuses POST /attendancemodule/embeddings/
// generate with the fetched roster (see embeddingController.js).
//
// ── Which subjects get asked for ────────────────────────────────────────────
// The ERP Embedding Generation tab has no subject picker: department (+ an
// optional semester) is the whole selection, and every subject that resolves
// to gets its own ERP roster request. collectSubjectsForDept decides that set
// from BOTH Subject.dept and the department's own timetables
// (Subject.code → TimeTable.code), because Subject.dept is an optional field
// that is frequently blank — a dept-only query silently drops subjects that
// plainly belong to the department.
//
// ── The ERP request ─────────────────────────────────────────────────────────
// One endpoint, one shape — the NITJ ERP's student-roster API:
//
//   POST <ERP_STUDENTS_API_URL>
//   Content-Type: application/json
//   { portalKey, degree, department, semester, abbreviation }
//
//   e.g. { degree: "B.Tech",
//          department: "Electronics and Communication Engineering",
//          semester: "B.Tech-ECE-5",
//          abbreviation: "AWP(ECE)" }
//
// The four non-secret fields come off the Subject document (see
// buildErpPayload); portalKey is a server-side secret and must never be sent
// to the browser, echoed in a response, or written to a log.
//
// ── Configuration (env) ──────────────────────────────────────────────────────
//   ERP_PORTAL_KEY       required — the ERP portal key. `PORTAL_KEY` is
//                        accepted as an alias. Without it the ERP is treated
//                        as unconfigured and every fetch route answers 503.
//   ERP_STUDENTS_API_URL optional — overrides the built-in NITJ endpoint URL.
//
// Both are captured at module load, so changing .env needs a server restart.
//
// ── ERP response ────────────────────────────────────────────────────────────
//   The observed shape — note the all-lowercase `rollnos` key:
//
//     { "status": "success",
//       "degree": "B.Tech", "department": "Electronics and Communication Engineering",
//       "semester": "B.Tech-ECE-5", "abbreviation": "AWP(ECE)",
//       "subject_code": "ECDC0301", "subject_name": "Antenna and Wave Propagation",
//       "total_students": 88,
//       "rollnos": ["23104006", "24104001", ...] }
//
//   Failures are reported IN BAND — `status` comes back as something other
//   than "success" while the HTTP status stays 200 — so the status field is
//   checked before the roster is read.
//
//   parseErpResponse stays permissive beyond that shape: a bare array, or an
//   object carrying the list under rollnos / rollNos / roll_nos / data /
//   students / student_list / rows / result — with items that are either
//   plain strings or objects with a roll field (rollNo / roll_no / rollno /
//   rollNumber / roll_number / RollNo / roll / regno / registration_no, else
//   any key matching /roll|regn?o/i).
//   No faculty is present in the observed response, so erpFaculty is normally
//   null; faculty / facultyName / faculty_name / teacher / instructor are
//   still read if the ERP ever adds one. When present it is matched against
//   the timetable module's faculty for the same sem+abbreviation (LockSem).

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const mongoose = require('mongoose');
const Subject = require('../../../models/subject');
const LockSem = require('../../../models/locksem');
const TimeTable = require('../../../models/timetable');
const ErpSyncSettings = require('../../../models/attendanceModule/erpSyncSettings');

// First-year subjects live under the "Basic Sciences" timetable (no real
// owning department exists) and are mapped to the teaching faculty's
// department via the Map First Year Subjects page (Subject.dept). They're
// identified by Subject.code matching a Basic Sciences timetable's code —
// same mechanism firstYearSubjectMappingController uses. For these subjects
// institute-wide ground-truth search is applied AUTOMATICALLY: their
// students' GT folders live under first-year/other-branch batch folders,
// never under the teaching department's.
const BASIC_SCIENCES_DEPT = 'Basic Sciences';

// Underscore/space-tolerant department matcher — the client sends
// "Electronics_and_Communication_Engineering" while the DB may hold either
// spelling.
function deptPattern(dept) {
    const escaped = String(dept || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped.replace(/[_\s]+/g, '[_ ]+'), 'i');
}

// Subject.dept is free text, and across a real deployment it holds anything
// from the timetable's full department name down to an abbreviation ("CSE",
// "ECE", "IT", "ICE") or a truncation ("Mechanical", "Industrial and
// Production") — while the page's Department dropdown is fed from
// TimeTable.dept, i.e. always the full name. Matching the full name alone
// therefore misses subjects that plainly belong to the department.
//
// So match the full name, every cumulative word-prefix of it (which is what a
// truncation is), and its initials. All anchored — a prefix match is exact
// against the whole field, never a substring of some other department.
function deptAliasPatterns(dept) {
    const escape = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const words = String(dept || '').replace(/_/g, ' ').split(/\s+/).filter(Boolean);
    if (!words.length) return [];

    const STOPWORDS = new Set(['and', 'of', 'for', 'the', '&']);
    const exact = (v) => new RegExp(`^\\s*${escape(v).replace(/\s+/g, '[_ ]+')}\\s*$`, 'i');

    const patterns = [deptPattern(dept)];
    for (let i = 1; i <= words.length; i += 1) {
        // A prefix ending on a stopword ("Industrial and") is not a name
        // anyone writes, so it is skipped.
        if (STOPWORDS.has(words[i - 1].toLowerCase())) continue;
        patterns.push(exact(words.slice(0, i).join(' ')));
    }
    const initials = words
        .filter((w) => !STOPWORDS.has(w.toLowerCase()))
        .map((w) => w[0]).join('');
    if (initials.length >= 2) patterns.push(exact(initials));
    return patterns;
}

// Codes of every timetable owned by a department, across all sessions.
//
// Subject.code is the owning timetable's code — the same link
// getFirstYearCodes() uses for Basic Sciences — and lets collectSubjectsForDept
// find a department's subjects regardless of what Subject.dept contains.
//
// Deliberately NOT restricted to the current session: subject records are
// created once and keep the code of whichever timetable they were imported
// with, so most of them point at earlier sessions' timetables. Filtering to
// the current session made this path match almost nothing. Including older
// codes is safe — department and semester still constrain the result.
async function timetableCodesForDept(dept) {
    if (!dept) return [];
    const alias = deptAliasPatterns(dept);
    if (!alias.length) return [];
    try {
        const tts = await TimeTable.find({
            $or: [{ dept: { $in: alias } }, { name: { $in: alias } }],
        }).select('code').lean();
        return [...new Set(tts.map((t) => t.code).filter(Boolean))];
    } catch (err) {
        console.warn(`[ErpSync] Timetable code lookup failed for ${dept}: ${err.message}`);
        return [];
    }
}

// Subject names the department's LOCKED TIMETABLE lists for a semester —
// LockSem.slotData.subject, the same source the Semester dropdown itself is
// fed from (/timetablemodule/lock/sems-by-dept). This is the authoritative
// answer to "which subjects run in this dept this semester", and the only one
// of the three resolution paths that cannot be defeated by a Subject document
// whose dept/code/sem was filled in differently — whatever semester value the
// dropdown offered came from these very records.
//
// Mirrors /timetablemodule/lock/subjects-by-dept-sem's cascade (ref-join then
// code-join, current session preferred) so both pages see the same subjects.
// Returns [{ abbreviation, sem }] — the subject abbreviations as they appear
// in the timetable's slots, paired with the LockSem semester string they run
// in. Both are exactly what the ERP wants (`abbreviation` and `semester`), so
// a roster can be requested for one of these WITHOUT any Subject document —
// which is how the Manual Generation tab has always worked.
async function timetableSubjects(dept, sem) {
    if (!dept) return [];
    const re = deptPattern(dept);
    const deptFilter = [{ 'timetableData.dept': re }, { 'timetableData.name': re }];
    const head = sem ? [{ $match: { sem: String(sem) } }] : [];
    const joinByRef = [
        { $lookup: { from: 'timetables', localField: 'timetable', foreignField: '_id', as: 'timetableData' } },
        { $unwind: '$timetableData' },
    ];
    const joinByCode = [
        { $lookup: { from: 'timetables', localField: 'code', foreignField: 'code', as: 'timetableData' } },
        { $unwind: '$timetableData' },
    ];
    const tail = [
        { $unwind: '$slotData' },
        { $match: { 'slotData.subject': { $exists: true, $ne: '' } } },
        // Grouped on sem too: without a semester filter the same abbreviation
        // can run in several, and each is its own ERP request.
        { $group: { _id: { abbreviation: '$slotData.subject', sem: '$sem' } } },
        { $sort: { '_id.sem': 1, '_id.abbreviation': 1 } },
    ];

    try {
        for (const join of [joinByRef, joinByCode]) {
            for (const extra of [{ 'timetableData.currentSession': true }, {}]) {
                const records = await LockSem.aggregate([
                    ...head, ...join, { $match: { ...extra, $or: deptFilter } }, ...tail,
                ]);
                const rows = records
                    .map((r) => ({ abbreviation: r._id.abbreviation, sem: r._id.sem }))
                    .filter((r) => r.abbreviation);
                if (rows.length) return rows;
            }
        }
    } catch (err) {
        console.warn(`[ErpSync] Timetable subject lookup failed for ${dept}/${sem}: ${err.message}`);
    }
    return [];
}

// Semester dropdown value vs Subject.sem. Both normally hold the ERP's own
// format ("B.Tech-ECE-5"), but the dropdown is fed from LockSem.sem, which is
// sometimes a bare number — so a bare number on either side is compared on the
// semester digits alone. Two formatted-but-different strings never match: that
// would collapse distinct classes (e.g. B.Tech-ECE-5 and M.Tech-ECE-5) into one.
function semMatches(subjectSem, requested) {
    const want = String(requested || '').trim();
    if (!want) return true;
    const have = String(subjectSem || '').trim();
    if (have.toLowerCase() === want.toLowerCase()) return true;
    if (!/^\d+$/.test(have) && !/^\d+$/.test(want)) return false;
    const a = have.match(/\d+/)?.[0];
    const b = want.match(/\d+/)?.[0];
    return !!a && a === b;
}

async function getFirstYearCodes() {
    try {
        let tts = await TimeTable.find({ dept: BASIC_SCIENCES_DEPT, currentSession: true })
            .select('code').lean();
        if (!tts.length) {
            // Fallback: current academic session by date (Aug–Jul), same
            // convention the schedulers use.
            const now = new Date();
            const start = (now.getMonth() + 1) >= 8 ? now.getFullYear() : now.getFullYear() - 1;
            const session = `${start}-${String(start + 1).slice(2)}`;
            tts = await TimeTable.find({ dept: BASIC_SCIENCES_DEPT, session })
                .select('code').lean();
        }
        return new Set(tts.map((t) => t.code).filter(Boolean));
    } catch (err) {
        console.warn(`[ErpSync] First-year timetable lookup failed: ${err.message}`);
        return new Set();
    }
}

const GROUND_TRUTH_DIR = path.join(__dirname, '..', '..', '..', '..', 'ml-data', 'ground_truth');

const ERP_STUDENTS_API_URL = process.env.ERP_STUDENTS_API_URL
    || 'https://v1.nitj.ac.in/erp/modules/academic/faculty/exam_dec_2026_att_portal/get_students_api.php';
// PORTAL_KEY is accepted as an alias so a .env written against the ERP team's
// own sample script works unchanged.
const ERP_PORTAL_KEY = process.env.ERP_PORTAL_KEY || process.env.PORTAL_KEY || '';

// The endpoint URL has a built-in default, so what actually gates the ERP is
// whether we hold a portal key.
function erpConfigured() {
    return !!(ERP_PORTAL_KEY.trim() && ERP_STUDENTS_API_URL.trim());
}

// Which student semester (1 or 2) first-year subjects are running in right
// now — Aug–Dec = odd (1), Jan–Jul = even (2). Same odd/even-session
// convention the Map First Year Subjects page uses; first-year Subject.sem
// itself holds a SECTION string (e.g. "B.Tech-CH+VLSI-SectionB6"), not a
// semester number.
function firstYearStudentSem() {
    return (new Date().getMonth() + 1) >= 8 ? 1 : 2;
}

// Maps a Subject document onto the ERP request's four non-secret fields.
//   degree      — the Degree dropdown wins, else Subject.degree, else the
//                 sem string's own prefix ("B.Tech-ECE-5" → "B.Tech").
//   department  — the client sends dept underscore-separated
//                 ("Electronics_and_Communication_Engineering"); the ERP wants
//                 the full spaced name.
//   semester    — Subject.sem verbatim; it is already stored in the ERP's
//                 format ("B.Tech-ECE-5").
//   abbreviation— Subject.subName ("AWP(ECE)"), falling back to subCode.
function buildErpPayload(subject, degreeOverride = null) {
    const semester     = String(subject.sem || '').trim();
    const department   = String(subject.dept || '').replace(/_/g, ' ').trim();
    const abbreviation = String(subject.subName || subject.subCode || '').trim();
    const degree = String(degreeOverride || '').trim()
        || String(subject.degree || '').trim()
        || semester.split('-')[0].trim();
    return { degree, department, semester, abbreviation };
}

// Which of the four the ERP cannot do without — reported up front so an
// incomplete Subject record fails with an actionable message instead of an
// opaque ERP-side error.
function missingPayloadFields(payload) {
    return ['degree', 'department', 'semester', 'abbreviation']
        .filter((field) => !String(payload[field] || '').trim());
}

// Last resort for a student object whose roll field uses a spelling we don't
// know yet — any key that reads like a roll/registration number.
function pickRollLikeValue(item) {
    const key = Object.keys(item).find((k) => /roll|regn?o/i.test(k));
    return key ? item[key] : '';
}

// Accepts every response shape listed in the header comment; returns
// { rollNos, faculty } — rollNos normalized (trimmed, uppercased, deduped),
// faculty the ERP-reported faculty name (or null).
function parseErpResponse(payload) {
    let faculty = null;
    let list = payload;
    if (list && typeof list === 'object' && !Array.isArray(list)) {
        faculty = list.faculty ?? list.facultyName ?? list.faculty_name
               ?? list.teacher ?? list.instructor ?? null;
        // `rollnos` is the key the ERP actually sends — the camelCase variants
        // below are only tolerated alternatives.
        list = list.rollnos || list.rollNos || list.roll_nos || list.data
            || list.students || list.student_list || list.rows || list.result || [];
    }
    if (!Array.isArray(list)) list = [];

    const rolls = [];
    for (const item of list) {
        let value = item;
        if (item && typeof item === 'object') {
            value = item.rollNo ?? item.roll_no ?? item.rollno ?? item.rollNumber
                 ?? item.roll_number ?? item.RollNo ?? item.roll ?? item.regno
                 ?? item.registration_no ?? pickRollLikeValue(item);
        }
        const roll = String(value ?? '').trim().toUpperCase();
        if (roll.length > 3) rolls.push(roll);
    }
    return {
        rollNos: [...new Set(rolls)],
        faculty: faculty ? String(faculty).trim() : null,
    };
}

// POSTs the roster request and returns { rollNos, faculty, payload } — payload
// echoed back (portalKey-free) so callers can show what was actually asked.
// The response is read as raw text and parsed here rather than by axios: the
// endpoint is PHP and answers a bad request with an HTML error page, which
// axios' JSON parsing would surface as an unhelpful SyntaxError.
async function fetchRollsFromErp(subject, degreeOverride = null) {
    const payload = buildErpPayload(subject, degreeOverride);
    const missing = missingPayloadFields(payload);
    if (missing.length) {
        throw new Error(
            `Cannot query ERP for "${subject.subjectFullName || subject.subName}" — `
            + `missing ${missing.join(', ')} on the subject record.`);
    }

    const res = await axios.post(
        ERP_STUDENTS_API_URL,
        { portalKey: ERP_PORTAL_KEY, ...payload },
        {
            headers: { 'Content-Type': 'application/json' },
            timeout: 20000,
            responseType: 'text',
            transformResponse: [(data) => data],
        },
    );

    let data;
    try {
        data = JSON.parse(res.data);
    } catch {
        // Never interpolate the request — the snippet is response-side only,
        // so the portal key cannot leak into the error or the logs.
        const snippet = String(res.data || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        throw new Error(`ERP returned a non-JSON response (HTTP ${res.status}): ${snippet}`);
    }

    // The ERP reports failures in band, with HTTP 200 and a non-success
    // status — without this check a rejected request would look like a
    // subject that simply has no students enrolled.
    const status = (data && typeof data === 'object') ? String(data.status ?? '').trim() : '';
    if (status && !/^(success|ok|true)$/i.test(status)) {
        const detail = data.message || data.error || data.msg || status;
        throw new Error(`ERP request rejected: ${detail}`);
    }

    const parsed = parseErpResponse(data);

    // The ERP states its own count; a disagreement means the roster was
    // parsed wrongly, which would otherwise show up as a silently short
    // roster and, downstream, students missing from attendance.
    const claimed = Number(data?.total_students);
    if (Number.isFinite(claimed) && claimed !== parsed.rollNos.length) {
        console.warn(`[ErpSync] ${payload.semester}/${payload.abbreviation}: ERP reported `
            + `${claimed} students but ${parsed.rollNos.length} roll numbers were parsed.`);
    }

    return { ...parsed, payload };
}

// ── Timetable faculty lookup (sem + abbreviation) ────────────────────────────
// Finds the faculty the timetable module (LockSem, current session) records
// for this subject: matches slotData.subject against the subject's
// abbreviation (subName) or full name, on LockSem docs whose sem contains the
// same semester number. Prefers entries from this department's timetable;
// multiple distinct names are joined with ", ".
async function lookupTimetableFaculty(subject, semOverride = null) {
    const semNum = semOverride != null
        ? String(semOverride)
        : (String(subject.sem || '').match(/\d+/)?.[0] || String(subject.sem || ''));
    const escape = (v) => String(v).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const namePatterns = [subject.subName, subject.subjectFullName]
        .filter(Boolean)
        .map((s) => new RegExp(`^\\s*${escape(s)}\\s*$`, 'i'));
    if (!namePatterns.length || !semNum) return null;

    const records = await LockSem.aggregate([
        { $match: { sem: { $regex: new RegExp(escape(semNum)) } } },
        { $lookup: { from: 'timetables', localField: 'timetable', foreignField: '_id', as: 'tt' } },
        { $unwind: '$tt' },
        { $match: { 'tt.currentSession': true } },
        { $unwind: '$slotData' },
        { $match: { $or: namePatterns.map((re) => ({ 'slotData.subject': re })) } },
        { $project: { faculty: '$slotData.faculty', dept: '$tt.dept' } },
    ]);
    if (!records.length) return null;

    const norm = (v) => String(v || '').toUpperCase().replace(/[\s_]+/g, '');
    const deptMatching = records.filter((r) => norm(r.dept) === norm(subject.dept));
    const pool = deptMatching.length ? deptMatching : records;
    const names = [...new Set(pool.map((r) => String(r.faculty || '').trim()).filter(Boolean))];
    return names.length ? names.join(', ') : null;
}

// For a first-year subject, resolve the department(s) of the faculty
// actually teaching it: timetable faculty names (LockSem, first-year sem)
// → Faculty collection's dept field. No "Basic Sciences" department exists,
// so first-year subjects belong, for listing purposes, to whichever
// department their teacher comes from.
const Faculty = require('../../../models/faculty');

async function resolveFirstYearTeachingDepts(subject) {
    const depts = new Set();
    try {
        const facultyJoined = await lookupTimetableFaculty(subject, firstYearStudentSem());
        if (!facultyJoined) return depts;
        for (const name of facultyJoined.split(',').map((n) => n.trim()).filter(Boolean)) {
            const fac = await Faculty.findOne({ name: new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') })
                .select('dept').lean();
            if (fac?.dept) depts.add(String(fac.dept));
        }
    } catch (err) {
        console.warn(`[ErpSync] First-year teaching-dept lookup failed for ${subject.subjectFullName}: ${err.message}`);
    }
    return depts;
}

// Case/space/honorific-insensitive comparison — the timetable side may hold
// several names (joined with ", "), so a match on any one counts.
function facultyNamesMatch(erpFaculty, timetableFaculty) {
    if (!erpFaculty || !timetableFaculty) return null;
    const clean = (v) => String(v)
        .toLowerCase()
        .replace(/\b(dr|prof|professor|mr|mrs|ms)\b\.?/g, '')
        .replace(/[^a-z]/g, '');
    const erp = clean(erpFaculty);
    if (!erp) return null;
    return timetableFaculty.split(',').some((name) => {
        const tt = clean(name);
        return tt && (tt === erp || tt.includes(erp) || erp.includes(tt));
    });
}

// Set-based symmetric-difference comparison (same idiom as
// erpEmbeddingSyncHelper.js's getErpStatus) — NOT array/string equality,
// since syncSubjectRolls doesn't sort before persisting and the ERP is free
// to return the same roster in a different order on every call. Used by
// erpAutoSyncScheduler.js to decide whether a subject's roster actually
// changed since the last sync, so it only regenerates embeddings for
// subjects that need it instead of every subject on every run.
function rollSetsEqual(a, b) {
    const setA = new Set((a || []).map((r) => String(r).trim().toUpperCase()));
    const setB = new Set((b || []).map((r) => String(r).trim().toUpperCase()));
    if (setA.size !== setB.size) return false;
    for (const roll of setA) {
        if (!setB.has(roll)) return false;
    }
    return true;
}

// Same scan the xlsx upload flow uses (embeddingController.uploadRollNosXlsx):
// a roll is "missed" when no ground_truth/{batch}/{roll} folder exists —
// across all batch folders when instituteWise, else dept-matching ones only.
function computeMissedGroundTruth(rollNos, dept, instituteWise) {
    if (!fs.existsSync(GROUND_TRUTH_DIR)) return [...rollNos];
    const allBatches = fs.readdirSync(GROUND_TRUTH_DIR);
    const batches = instituteWise
        ? allBatches
        : allBatches.filter(b => b.toUpperCase().includes((dept || '').toUpperCase()));
    const missed = [];
    for (const rollNo of rollNos) {
        const found = batches.some(batch =>
            fs.existsSync(path.join(GROUND_TRUTH_DIR, batch, rollNo)));
        if (!found) missed.push(rollNo);
    }
    return missed;
}

async function syncSubjectRolls(subject, instituteWise, isFirstYear = false, degreeOverride = null) {
    const previousRollNos = subject.enrolledRollNos || [];
    const { rollNos, faculty: erpFaculty } = await fetchRollsFromErp(subject, degreeOverride);
    if (rollNos.length === 0) {
        return { subjectId: subject._id, subject: subject.subjectFullName,
                 ok: false, error: 'ERP returned no roll numbers' };
    }
    // Roster diff — used by erpAutoSyncScheduler.js to skip embedding
    // regeneration entirely when nothing actually changed since last sync.
    const rollsChanged = !rollSetsEqual(previousRollNos, rollNos);

    // First-year subjects always scan institute-wide — their students' GT
    // folders never live under the teaching department's batch folders.
    const effectiveInstituteWise = instituteWise || isFirstYear;
    const missedGroundTruth = computeMissedGroundTruth(rollNos, subject.dept, effectiveInstituteWise);

    // Faculty cross-check against the timetable module (sem + abbreviation);
    // first-year subjects match on the derived student semester (1/2), since
    // their sem field holds a section string.
    let timetableFaculty = null;
    try {
        timetableFaculty = await lookupTimetableFaculty(
            subject, isFirstYear ? firstYearStudentSem() : null);
    } catch (err) {
        console.warn(`[ErpSync] Timetable faculty lookup failed for ${subject.subjectFullName}: ${err.message}`);
    }
    const facultyMatch = facultyNamesMatch(erpFaculty, timetableFaculty);

    await Subject.findByIdAndUpdate(subject._id, {
        enrolledRollNos:    rollNos,
        missedGroundTruth,
        erpSyncedAt:        new Date(),
        erpFaculty,
        timetableFaculty,
        facultyMatch,
    });
    return {
        subjectId: subject._id,
        subject:   subject.subjectFullName,
        ok:        true,
        rollsChanged,
        rollNos,
        total:     rollNos.length,
        missedCount: missedGroundTruth.length,
        missedGroundTruth,
        erpFaculty,
        timetableFaculty,
        facultyMatch,
    };
}

// ── Route handlers ───────────────────────────────────────────────────────────

// Collect the subjects the ERP tab shows for a department. The tab has no
// subject picker — dept + semester is the whole selection — so this is what
// decides which subjects get a roster request sent to the ERP, both for the
// per-row buttons and for Fetch/Generate all:
//   • regular subjects whose Subject.dept matches, OR which belong to one of
//     the department's own timetables via Subject.code (optionally
//     sem-filtered). The second path exists because Subject.dept is optional
//     and often blank — see timetableCodesForDept.
//   • PLUS first-year (Basic Sciences timetable) subjects taught by this
//     department's faculty — they carry no owning dept, so the link comes
//     from the timetable faculty's Faculty.dept, mirroring the timetable
//     module's first-year allotment. Marked with __isFirstYear.
// First-year subjects are included when no sem filter is set, or when the
// filter equals the current first-year student semester (1/2).
// Sentinel the frontend's Semester dropdown sends for its explicit
// "First Year" entry — first-year subjects have no real semester number
// (their Subject.sem holds a section string like "B.Tech-CH+VLSI-SectionB6"),
// so they can't be reached via the normal numeric dropdown at all.
const FIRST_YEAR_SENTINEL = 'FIRST_YEAR';

// diagnostics — optional object filled in with how the subject set was
// resolved (which join key produced what). Surfaced by GET /subjects so an
// empty listing can be explained instead of guessed at.
async function collectSubjectsForDept(dept, sem, diagnostics = null) {
    const normDept = (v) => String(v || '').toUpperCase().replace(/[\s_]+/g, '');
    const firstYearOnly = sem === FIRST_YEAR_SENTINEL;
    const firstYearCodes = await getFirstYearCodes();

    // ── Explicit "First Year" selection — ONLY first-year subjects taught
    // by this department's faculty, regardless of the derived student sem.
    if (firstYearOnly) {
        if (firstYearCodes.size === 0) return [];
        const fyCandidates = await Subject.find({ code: { $in: [...firstYearCodes] } }).lean();
        const subjects = [];
        for (const fy of fyCandidates) {
            const teachingDepts = await resolveFirstYearTeachingDepts(fy);
            if ([...teachingDepts].some((d) => normDept(d) === normDept(dept))) {
                subjects.push({ ...fy, dept: fy.dept || dept, __isFirstYear: true });
            }
        }
        subjects.sort((a, b) => String(a.subjectFullName).localeCompare(String(b.subjectFullName)));
        return subjects;
    }

    // ── Resolving "every subject under this dept + sem" ──────────────────────
    // Three independent paths, unioned, because each join key is unreliable on
    // its own and a subject missed here never gets a roster request at all:
    //   1. Subject.dept        — optional, frequently blank or written as an
    //                            abbreviation/truncation (deptAliasPatterns).
    //   2. Subject.code        — the owning timetable's code, any session;
    //                            absent when the subject was created outside a
    //                            timetable import.
    //   3. timetable subject   — LockSem.slotData.subject for this dept+sem,
    //      names               joined back to Subject by abbreviation/full
    //                            name. Independent of BOTH fields above, and
    //                            the same source the Semester dropdown uses.
    const deptCodes = await timetableCodesForDept(dept);
    const ttNames = [...new Set((await timetableSubjects(dept, sem)).map((r) => r.abbreviation))];
    const nameRes = ttNames.map(
        (n) => new RegExp(`^\\s*${String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'));

    const deptAlias = deptAliasPatterns(dept);
    const deptOr = [{ dept: { $in: deptAlias } }];
    if (deptCodes.length) deptOr.push({ code: { $in: deptCodes } });
    if (nameRes.length) deptOr.push({ subName: { $in: nameRes } }, { subjectFullName: { $in: nameRes } });

    const candidates = await Subject.find({ $or: deptOr }).lean();

    // Semester is filtered here rather than in the query so a bare-number
    // dropdown value still matches an ERP-formatted Subject.sem (semMatches).
    // Timetable-name matches are held to the looser digit comparison only:
    // the name was already read from the requested semester's own timetable
    // rows, so the semester is established — it is Subject.sem that may be
    // written in some third format.
    const nameMatched = (s) => nameRes.some(
        (re) => re.test(String(s.subName || '')) || re.test(String(s.subjectFullName || '')));
    const semDigits = (v) => String(v || '').match(/\d+/)?.[0] || '';
    const subjects = candidates
        .filter((s) => semMatches(s.sem, sem)
            || (nameMatched(s) && (!sem || semDigits(s.sem) === semDigits(sem))))
        // A blank Subject.dept would leave the ERP request without its
        // `department` field; the department being listed is the right answer
        // for a subject reached through that department's timetable. Only the
        // in-memory copy is patched — nothing is written back to the Subject.
        .map((s) => ({ ...s, dept: s.dept || dept, __isFirstYear: false }));

    // Why an empty (or short) list came out — the three join keys fail
    // silently and independently, so guessing between them is not viable.
    console.log(`[ErpSync] subjects dept=${dept} sem=${sem || 'ALL'} → ${subjects.length}`
        + ` (timetable codes=${deptCodes.length}, timetable subject names=${ttNames.length},`
        + ` subject-collection candidates=${candidates.length})`);
    if (diagnostics) {
        Object.assign(diagnostics, {
            timetableCodes: deptCodes,
            timetableSubjectNames: ttNames,
            subjectCollectionCandidates: candidates.length,
            // Timetable subjects with no Subject document at all — these cannot
            // be synced (there is nothing to persist a roster onto) and are the
            // usual reason this page looks emptier than the timetable does.
            timetableNamesWithoutSubjectRecord: ttNames.filter(
                (n) => !candidates.some((s) => [s.subName, s.subjectFullName]
                    .some((v) => String(v || '').trim().toLowerCase() === String(n).trim().toLowerCase()))),
        });
    }

    const includeFY = firstYearCodes.size > 0 && !sem;
    if (includeFY) {
        const seen = new Set(subjects.map((s) => String(s._id)));
        const fyCandidates = await Subject.find({ code: { $in: [...firstYearCodes] } }).lean();
        for (const fy of fyCandidates) {
            if (seen.has(String(fy._id))) {
                const existing = subjects.find((s) => String(s._id) === String(fy._id));
                if (existing) existing.__isFirstYear = true;
                continue;
            }
            const teachingDepts = await resolveFirstYearTeachingDepts(fy);
            if ([...teachingDepts].some((d) => normDept(d) === normDept(dept))) {
                // Same blank-dept stand-in as above — for a first-year subject
                // the teaching department is what put it in this list.
                subjects.push({ ...fy, dept: fy.dept || dept, __isFirstYear: true });
            }
        }
    } else {
        // Still mark dept-matched subjects that happen to be first-year.
        for (const s of subjects) {
            if (firstYearCodes.has(s.code)) s.__isFirstYear = true;
        }
    }
    subjects.sort((a, b) => {
        // First Year group leads, then numeric semesters ascending.
        const keyOf = (s) => s.__isFirstYear
            ? -1
            : parseInt(String(s.sem).match(/\d+/)?.[0] || '99', 10);
        const ka = keyOf(a), kb = keyOf(b);
        if (ka !== kb) return ka - kb;
        return String(a.subjectFullName).localeCompare(String(b.subjectFullName));
    });
    return subjects;
}

// The rows the ERP tab renders — the timetable is the source of truth for
// "which subjects run in this dept this semester", exactly as it is for the
// Manual Generation tab's subject dropdown.
//
// A timetable subject with no Subject document is still a row: the ERP request
// needs only department + semester + abbreviation, all three of which come
// from the timetable, so its roster can be fetched and its embeddings
// generated. What it cannot do is PERSIST that roster (there is no document to
// write enrolledRollNos onto), so such a row is marked hasSubjectRecord:false
// and the page keeps its roster in memory for the session.
//
// Subject documents the timetable never mentions are appended afterwards, so
// nothing that resolved before this became timetable-driven disappears.
async function buildSubjectRows(dept, sem, diagnostics = null) {
    const docs = await collectSubjectsForDept(dept, sem, diagnostics);
    const ttRows = sem === FIRST_YEAR_SENTINEL ? [] : await timetableSubjects(dept, sem);

    const norm = (v) => String(v || '').trim().toLowerCase();
    const semDigits = (v) => String(v || '').match(/\d+/)?.[0] || '';
    const used = new Set();

    const rows = [];
    for (const tt of ttRows) {
        const match = docs.find((d, i) => !used.has(i)
            && (norm(d.subName) === norm(tt.abbreviation) || norm(d.subjectFullName) === norm(tt.abbreviation))
            && (norm(d.sem) === norm(tt.sem) || semDigits(d.sem) === semDigits(tt.sem)));
        if (match) {
            used.add(docs.indexOf(match));
            // The timetable's semester string is the one the ERP understands
            // ("B.Tech-CSE-5A"); Subject.sem may be written some other way.
            rows.push({ ...match, __ttSem: tt.sem, __hasRecord: true, __inTimetable: true });
        } else {
            rows.push({
                _id: null,
                subjectFullName: tt.abbreviation,
                subName: tt.abbreviation,
                subCode: '',
                type: '',
                sem: tt.sem,
                dept,
                __ttSem: tt.sem,
                __hasRecord: false,
                __inTimetable: true,
                __isFirstYear: false,
            });
        }
    }
    docs.forEach((d, i) => {
        if (!used.has(i)) rows.push({ ...d, __hasRecord: true, __inTimetable: false });
    });

    // The page draws a header each time the semester group changes, so rows of
    // the same semester have to stay adjacent — the appended leftovers above
    // would otherwise repeat a group that has already been drawn.
    rows.sort((a, b) => {
        if (!!a.__isFirstYear !== !!b.__isFirstYear) return a.__isFirstYear ? -1 : 1;
        const semOf = (s) => String(s.__ttSem || s.sem || '');
        const na = parseInt(semOf(a).match(/\d+/)?.[0] || '99', 10);
        const nb = parseInt(semOf(b).match(/\d+/)?.[0] || '99', 10);
        if (na !== nb) return na - nb;
        const bySem = semOf(a).localeCompare(semOf(b));
        if (bySem !== 0) return bySem;
        return String(a.subjectFullName || '').localeCompare(String(b.subjectFullName || ''));
    });
    return rows;
}

// GET /erp-sync/subjects?dept=&sem=
// sem optional — omitted returns ALL semesters for the department, sorted
// sem-wise (the ERP tab renders them grouped by semester, First Year first).
async function listSubjects(req, res) {
    try {
        const { dept, sem } = req.query;
        if (!dept) return res.status(400).json({ error: 'dept is required' });

        const diagnostics = {};
        const subjects = await buildSubjectRows(dept, sem, diagnostics);
        const fySem = firstYearStudentSem();

        res.json({
            erpConfigured: erpConfigured(),
            // How the set was resolved — the page shows this when it comes back
            // empty, so "no subjects" says which join key came up short rather
            // than leaving it to be guessed.
            diagnostics: { ...diagnostics, matched: subjects.length },
            subjects: subjects.map(s => ({
                _id:              s._id,
                // false → no Subject document backs this row. Its roster can
                // still be fetched and generated (the ERP request is fully
                // specified by dept + semester + abbreviation) but cannot be
                // persisted, so the page holds it for the session only.
                hasSubjectRecord: s.__hasRecord !== false,
                inTimetable:      !!s.__inTimetable,
                isFirstYear:      !!s.__isFirstYear,
                studentSem:       s.__isFirstYear ? fySem : null,
                groupLabel:       s.__isFirstYear ? 'First Year' : `Semester ${s.__ttSem || s.sem}`,
                subjectFullName:  s.subjectFullName,
                subName:          s.subName,
                subCode:          s.subCode,
                type:             s.type,
                sem:              s.sem,
                dept:             s.dept,
                // The timetable's semester string is what the ERP understands,
                // so it wins over Subject.sem when the two disagree.
                erpLookup:        buildErpPayload({ ...s, sem: s.__ttSem || s.sem }),
                rollCount:        (s.enrolledRollNos || []).length,
                missedCount:      (s.missedGroundTruth || []).length,
                missedGroundTruth: s.missedGroundTruth || [],
                enrolledRollNos:  s.enrolledRollNos || [],
                embeddingFile:    s.embeddingFile || null,
                embeddingUpdatedAt: s.embeddingUpdatedAt || null,
                erpSyncedAt:      s.erpSyncedAt || null,
                erpFaculty:       s.erpFaculty || null,
                timetableFaculty: s.timetableFaculty || null,
                facultyMatch:     s.facultyMatch ?? null,
            })),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

// POST /erp-sync/fetch-rolls
//   { subjectId, instituteWise, degree?, dept? }            — backed by a Subject
//   { dept, sem, abbreviation, instituteWise, degree? }     — timetable only
//
// Two shapes, because the ERP needs no Subject document: department + semester
// + abbreviation fully specify a roster request, and the timetable supplies
// all three. This is precisely what the Manual Generation tab posts to
// /embeddings/erp-rolls, and it is why that tab can fetch rolls for a subject
// that was never entered into the Subject collection.
//
// The difference is persistence. With a real subjectId the roster is written
// back (enrolledRollNos / missedGroundTruth / erpSyncedAt / faculty) via the
// same syncSubjectRolls the nightly job uses. Without one there is nowhere to
// write it, so the rolls are returned for the caller to hold (persisted:false).
//
// dept also stands in for a blank Subject.dept, which the ERP request cannot
// do without — subjects reached through the department's timetable rather than
// Subject.dept routinely have no dept of their own.
async function fetchRolls(req, res) {
    try {
        if (!erpConfigured()) {
            return res.status(503).json({ error: 'ERP_PORTAL_KEY not configured on the server.' });
        }
        const { subjectId, instituteWise, degree, dept, sem, abbreviation } = req.body;
        const hasRealSubject = subjectId && mongoose.Types.ObjectId.isValid(subjectId);

        if (hasRealSubject) {
            const found = await Subject.findById(subjectId).lean();
            if (!found) return res.status(404).json({ error: 'Subject not found' });
            // The timetable's semester string is the one the ERP understands.
            const subject = {
                ...found,
                dept: found.dept || dept || '',
                sem:  sem || found.sem,
            };

            const firstYearCodes = await getFirstYearCodes();
            const isFirstYear = firstYearCodes.has(subject.code);
            const result = await syncSubjectRolls(subject, !!instituteWise, isFirstYear, degree);
            return res.json({ ...result, persisted: true });
        }

        // ── Timetable-only subject ───────────────────────────────────────────
        if (!dept || !sem || !abbreviation) {
            return res.status(400).json({
                error: 'Either subjectId, or dept + sem + abbreviation, is required',
            });
        }
        const subject = { dept, sem, subName: abbreviation };
        const payload = buildErpPayload(subject, degree);
        const missing = missingPayloadFields(payload);
        if (missing.length) {
            return res.status(400).json({ error: `Cannot query ERP — missing ${missing.join(', ')}.` });
        }

        const { rollNos, faculty } = await fetchRollsFromErp(subject, degree);
        if (rollNos.length === 0) {
            return res.json({
                ok: false, subject: abbreviation, persisted: false, total: 0, rollNos: [],
                error: 'ERP returned no roll numbers',
            });
        }
        const missedGroundTruth = computeMissedGroundTruth(rollNos, dept, !!instituteWise);
        return res.json({
            ok: true,
            subject: abbreviation,
            persisted: false,
            rollNos,
            total: rollNos.length,
            missedGroundTruth,
            missedCount: missedGroundTruth.length,
            erpFaculty: faculty,
            payload,
        });
    } catch (err) {
        const status = err.response?.status;
        res.status(502).json({
            error: `ERP fetch failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`,
        });
    }
}

// POST /erp-sync/fetch-rolls-bulk  { dept, sem?, instituteWise, degree? }
// sem optional — omitted syncs every semester's subjects for the department.
// Sequential on purpose — kinder to the ERP server than a parallel burst.
async function fetchRollsBulk(req, res) {
    try {
        if (!erpConfigured()) {
            return res.status(503).json({ error: 'ERP_PORTAL_KEY not configured on the server.' });
        }
        const { dept, sem, instituteWise, degree } = req.body;
        if (!dept) return res.status(400).json({ error: 'dept is required' });

        // Same subject set the tab lists — dept-owned subjects plus
        // first-year subjects taught by this department's faculty.
        const subjects = await collectSubjectsForDept(dept, sem);

        const results = [];
        for (const subject of subjects) {
            try {
                results.push(await syncSubjectRolls(
                    subject, !!instituteWise, !!subject.__isFirstYear, degree));
            } catch (err) {
                results.push({
                    subjectId: subject._id,
                    subject:   subject.subjectFullName,
                    ok:        false,
                    error:     err.response?.status ? `HTTP ${err.response.status}` : err.message,
                });
            }
        }
        res.json({ total: subjects.length, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

// POST /attendancemodule/embeddings/erp-rolls
//   { subjectId?, degree?, department?, semester?, abbreviation?, instituteWise? }
//
// Backs the Embedding Generation page's Manual Generation tab, which uses it
// to fill the roll-number textarea from the ERP. The four ERP fields default
// off the Subject record and any supplied in the body override them — the tab
// exposes them as editable inputs so a mismatch with the ERP's own spelling
// can be corrected without a DB edit.
//
// When subjectId names a real Subject this runs the SAME syncSubjectRolls the
// ERP Sync page's Fetch button runs, so the roster it pulls is persisted
// (enrolledRollNos / missedGroundTruth / erpSyncedAt / faculty) and the two
// pages stay in step. An ad-hoc payload with no subjectId has nothing to
// persist against, so those rolls are returned for the textarea only.
//
// Mounted on the embeddings router rather than /erp-sync because that tab sits
// behind the embeddings menu, not the erpSync one.
async function previewRolls(req, res) {
    try {
        if (!erpConfigured()) {
            return res.status(503).json({ error: 'ERP_PORTAL_KEY not configured on the server.' });
        }
        const { subjectId, degree, department, semester, abbreviation, instituteWise } = req.body;

        // Overrides ride on a copy of the Subject so buildErpPayload sees them,
        // while _id (and so the persistence target) stays intact.
        const applyOverrides = (subject) => ({
            ...subject,
            dept:    department   || subject.dept,
            sem:     semester     || subject.sem,
            subName: abbreviation || subject.subName,
        });

        // The Manual Generation tab's subject dropdown can fall back to a
        // synthetic entry (timetable-derived subject name, no real Subject
        // doc yet) whose "_id" is just that name, not a Mongo ObjectId —
        // Subject.findById would throw a CastError on that. Treat anything
        // that isn't a real ObjectId the same as "no subjectId": fall through
        // to the explicit ERP fields the tab already fills in, and skip
        // persistence since there is no Subject doc to persist onto.
        const hasRealSubject = subjectId && mongoose.Types.ObjectId.isValid(subjectId);

        let subject = null;
        if (hasRealSubject) {
            const found = await Subject.findById(subjectId).lean();
            if (!found) return res.status(404).json({ error: 'Subject not found' });
            subject = applyOverrides(found);
        } else {
            subject = { dept: department, sem: semester, subName: abbreviation };
        }

        const payload = buildErpPayload(subject, degree);
        const missing = missingPayloadFields(payload);
        if (missing.length) {
            return res.status(400).json({
                error: `Cannot query ERP — missing ${missing.join(', ')}.`,
            });
        }

        // payload carries no portalKey — safe to echo back so the page can show
        // exactly what was asked of the ERP.
        if (!hasRealSubject) {
            const { rollNos, faculty } = await fetchRollsFromErp(subject, degree);
            return res.json({ rollNos, total: rollNos.length, faculty, payload, persisted: false });
        }

        const firstYearCodes = await getFirstYearCodes();
        const isFirstYear = firstYearCodes.has(subject.code);
        const result = await syncSubjectRolls(subject, !!instituteWise, isFirstYear, degree);
        if (!result.ok) return res.status(502).json({ error: result.error });

        res.json({
            rollNos: result.rollNos,
            total:   result.total,
            faculty: result.erpFaculty,
            missedGroundTruth: result.missedGroundTruth,
            missedCount: result.missedCount,
            payload,
            persisted: true,
        });
    } catch (err) {
        const status = err.response?.status;
        res.status(502).json({
            error: `ERP fetch failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`,
        });
    }
}

// GET /erp-sync/settings — on/off state of the nightly auto-sync scheduler
// (erpAutoSyncScheduler.js). Independent of ERP_PORTAL_KEY being configured —
// the toggle can be flipped either way regardless of reachability.
async function getSettings(req, res) {
    try {
        const settings = await ErpSyncSettings.getSettings();
        res.json({
            enabled: settings.enabled,
            lastRunAt: settings.lastRunAt,
            lastRunStats: settings.lastRunStats,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

// PATCH /erp-sync/settings  { enabled }
async function updateSettings(req, res) {
    try {
        const { enabled } = req.body;
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ error: 'enabled (boolean) is required' });
        }
        const settings = await ErpSyncSettings.getSettings();
        settings.enabled = enabled;
        await settings.save();
        res.json({ enabled: settings.enabled });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

module.exports = {
    listSubjects, fetchRolls, fetchRollsBulk, previewRolls, FIRST_YEAR_SENTINEL,
    getSettings, updateSettings,
    // Exported for erpAutoSyncScheduler.js — the nightly change-detected sync
    // reuses the exact same per-subject logic the manual Fetch/Generate
    // buttons use, rather than duplicating it.
    syncSubjectRolls, getFirstYearCodes, resolveFirstYearTeachingDepts,
    firstYearStudentSem, rollSetsEqual, erpConfigured,
    // Exported for the unit tests — the Subject → ERP-request mapping, the
    // defensive response parsing and the semester matching (the ERP tab's only
    // filter besides department) are the pieces worth pinning down.
    buildErpPayload, parseErpResponse, semMatches, timetableCodesForDept,
    deptAliasPatterns,
    // Exported for healthRoutes.js / uptimeDigestScheduler.js — the ERP
    // reachability probes hit this URL directly (no dedicated ERP health
    // route is assumed to exist on the ERP server).
    ERP_STUDENTS_API_URL,
};
