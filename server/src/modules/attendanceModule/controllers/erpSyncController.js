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
//   { portalKey, degree, department, semester, abbreviation, att_group }
//
//   e.g. { degree: "B.Tech",
//          department: "Electronics and Communication Engineering",
//          semester: "B.Tech-ECE-5",
//          abbreviation: "FPGA(DE/GE)",
//          att_group: "2" }
//
// The four class-identifying fields come off the Subject document (see
// buildErpPayload); portalKey is a server-side secret and must never be sent
// to the browser, echoed in a response, or written to a log.
//
// ── Attendance groups ───────────────────────────────────────────────────────
// att_group is REQUIRED by the ERP and addresses ONE attendance group of the
// class — a request without it, or with the wrong one, comes back empty. A
// subject's students are split across groups (electives especially), and
// nothing on our side records which groups a given subject actually uses, so
// there is no value to look up: every group in ERP_ATT_GROUPS (1–5 by
// default) is requested in turn and the rolls are UNIONED into one roster.
// That combined roster is what gets persisted, shown in the ERP Sync table
// and loaded into the Manual Generation textarea.
//
// A group the subject does not use answers with an in-band failure or an
// empty list; that is normal, not an error, so per-group failures are
// collected and reported alongside the roster instead of aborting the sweep.
// Only a sweep where EVERY group failed is an error.
//
// ── Configuration (env) ──────────────────────────────────────────────────────
//   ERP_PORTAL_KEY       required — the ERP portal key. `PORTAL_KEY` is
//                        accepted as an alias. Without it the ERP is treated
//                        as unconfigured and every fetch route answers 503.
//   ERP_PORTAL_KEY_FIELD optional — the JSON field the key is SENT under,
//                        default "portalKey". Distinct from the env var name
//                        above: this one is the ERP's, that one is ours.
//   ERP_REQUEST_FORMAT   optional — "json" (default) or "form". Only needed
//                        if the endpoint reads $_POST rather than
//                        php://input; POST /erp-sync/probe reports which.
//   ERP_STUDENTS_API_URL optional — overrides the built-in NITJ endpoint URL.
//   ERP_ATT_GROUPS       optional — comma-separated attendance groups to
//                        sweep, default "1,2,3,4,5".
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

// Codes of every timetable in the CURRENT session. Used to break ties between
// duplicate Subject documents (see dedupeErpRows): subject records are created
// once per timetable import and keep that timetable's code forever, so the
// copy whose code is current-session is the live one.
async function currentSessionCodes() {
    try {
        const tts = await TimeTable.find({ currentSession: true }).select('code').lean();
        return new Set(tts.map((t) => t.code).filter(Boolean));
    } catch (err) {
        console.warn(`[ErpSync] Current-session code lookup failed: ${err.message}`);
        return new Set();
    }
}

const GROUND_TRUTH_DIR = path.join(__dirname, '..', '..', '..', '..', 'ml-data', 'ground_truth');

const ERP_STUDENTS_API_URL = process.env.ERP_STUDENTS_API_URL
    || 'https://v1.nitj.ac.in/erp/modules/academic/faculty/exam_dec_2026_att_portal/get_students_api.php';
// PORTAL_KEY is accepted as an alias so a .env written against the ERP team's
// own sample script works unchanged.
const ERP_PORTAL_KEY = process.env.ERP_PORTAL_KEY || process.env.PORTAL_KEY || '';

// The JSON field the portal key rides in. Two different names are involved
// and only this one belongs to the ERP: the ENV VAR is called PORTAL_KEY (or
// ERP_PORTAL_KEY) and that is our own choice, while this is the key the ERP
// reads out of the request body.
//
// `portalKey` is what the previous endpoint took. The rest of the current API
// is snake_case (att_group, subject_code, total_students), so if
// exam_dec_2026_att_portal expects `portal_key` instead, set
// ERP_PORTAL_KEY_FIELD=portal_key rather than editing this file — a key sent
// under a field the portal does not read is indistinguishable from no key.
const ERP_PORTAL_KEY_FIELD = (process.env.ERP_PORTAL_KEY_FIELD || 'portalKey').trim() || 'portalKey';

// How the request body is ENCODED — 'json' (default) or 'form'.
//
// The endpoint is PHP, and PHP only populates $_POST for form-encoded bodies;
// a script reading $_POST sees nothing at all from an application/json body
// and answers "Subject mapping not found" for a request whose fields and key
// are both perfectly correct. That failure is indistinguishable from an
// unmapped subject, which is why this is a switch rather than a guess: if the
// same payload works from Postman as form-data or x-www-form-urlencoded, set
// ERP_REQUEST_FORMAT=form.
const ERP_REQUEST_FORMAT =
    /^form$/i.test(String(process.env.ERP_REQUEST_FORMAT || '').trim()) ? 'form' : 'json';

// Builds the axios body + Content-Type for one roster request under whichever
// encoding is configured. Form encoding flattens every value with String(),
// which is safe here: every field the ERP takes is already a string.
function encodeErpBody(fields, format = ERP_REQUEST_FORMAT) {
    if (format === 'form') {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(fields)) params.append(k, String(v ?? ''));
        return { body: params.toString(), contentType: 'application/x-www-form-urlencoded' };
    }
    return { body: fields, contentType: 'application/json' };
}

// Attendance groups swept per subject — see the header comment. Every roster
// request carries exactly one of these as att_group, and the results are
// unioned.
const ERP_ATT_GROUPS = String(process.env.ERP_ATT_GROUPS || '1,2,3,4,5')
    .split(',').map((g) => g.trim()).filter(Boolean);

// The endpoint URL has a built-in default, so what actually gates the ERP is
// whether we hold a portal key — plus at least one attendance group to ask
// for, since att_group is required and an empty ERP_ATT_GROUPS would make
// every request unanswerable.
function erpConfigured() {
    return !!(ERP_PORTAL_KEY.trim() && ERP_STUDENTS_API_URL.trim() && ERP_ATT_GROUPS.length);
}

// Which student semester (1 or 2) first-year subjects are running in right
// now — Aug–Dec = odd (1), Jan–Jul = even (2). Same odd/even-session
// convention the Map First Year Subjects page uses; first-year Subject.sem
// itself holds a SECTION string (e.g. "B.Tech-CH+VLSI-SectionB6"), not a
// semester number.
function firstYearStudentSem() {
    return (new Date().getMonth() + 1) >= 8 ? 1 : 2;
}

// Maps a Subject document onto the ERP request's four class-identifying
// fields. att_group is NOT one of them — it identifies an attendance group
// rather than a class, is not recorded on the Subject, and is added per
// request by the sweep in fetchRollsFromErp.
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

// Applies a caller's explicit ERP fields on top of a Subject document.
//
// The OVERRIDE WINS over the stored value for all three, which is the whole
// point: the caller's values come from the locked timetable — the full
// department name, the ERP-formatted semester, the timetable's abbreviation —
// while the Subject document's own fields are unreliable for exactly this
// purpose. Subject.dept is free text that routinely holds "ECE" or "CSE"
// rather than "Electronics and Communication Engineering" (see
// deptAliasPatterns, which exists solely to cope with that), Subject.sem is
// often a bare number, and Subject.subName can differ from the abbreviation
// the ERP knows.
//
// Both entry points use this. They drifted apart once — /erp-sync/fetch-rolls
// ignored the posted abbreviation entirely and preferred Subject.dept, so a
// subject that fetched fine from the Manual Generation tab came back "Subject
// mapping not found" from the ERP Sync page. One definition, no drift.
//
// This IS the Manual Generation tab's rule, unchanged — it was previously an
// inline `applyOverrides` inside previewRolls and is lifted here verbatim so
// the ERP Sync page runs the same one, rather than the two being written
// twice and diverging again. _id is untouched, so the persistence target
// stays intact.
function applyErpOverrides(subject, { dept, sem, abbreviation } = {}) {
    return {
        ...subject,
        dept:    dept         || subject.dept,
        sem:     sem          || subject.sem,
        subName: abbreviation || subject.subName,
    };
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

// What the ERP says about the class it just answered for — its OWN spelling of
// the subject code, name and department, echoed back on every roster response.
// Worth keeping per attendance group rather than discarding: a group is
// frequently a different department's students taking the subject as an
// elective, under that department's subject code, and the ERP Sync page shows
// exactly that so a surprising roster size is explainable.
function erpGroupMeta(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
    const pick = (...keys) => {
        for (const k of keys) {
            const v = payload[k];
            if (v != null && String(v).trim()) return String(v).trim();
        }
        return null;
    };
    return {
        subjectCode: pick('subject_code', 'subjectCode', 'subcode', 'code'),
        subjectName: pick('subject_name', 'subjectName', 'subname'),
        department:  pick('department', 'dept'),
        degree:      pick('degree'),
        semester:    pick('semester', 'sem'),
        abbreviation: pick('abbreviation', 'abbr'),
        claimedTotal: Number.isFinite(Number(payload.total_students))
            ? Number(payload.total_students) : null,
    };
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

// One roster request — ONE attendance group. Returns { rollNos, faculty };
// throws on a transport error, a non-JSON body or an in-band rejection, all of
// which the caller treats as "this group did not answer" rather than as a
// failed sync (see fetchRollsFromErp).
//
// The response is read as raw text and parsed here rather than by axios: the
// endpoint is PHP and answers a bad request with an HTML error page, which
// axios' JSON parsing would surface as an unhelpful SyntaxError.
async function fetchGroupRolls(payload) {
    // att_group is required by the ERP, and omitting it returns an empty
    // roster rather than an error — which would look exactly like a class
    // with no students. Refuse to send the request instead.
    if (!String(payload.att_group || '').trim()) {
        throw new Error('att_group is required for an ERP roster request.');
    }

    const { body, contentType } = encodeErpBody({
        [ERP_PORTAL_KEY_FIELD]: ERP_PORTAL_KEY, ...payload,
    });

    const res = await axios.post(
        ERP_STUDENTS_API_URL,
        body,
        {
            headers: { 'Content-Type': contentType },
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
    // group that simply has no students enrolled.
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
        console.warn(`[ErpSync] ${payload.semester}/${payload.abbreviation}`
            + ` att_group=${payload.att_group}: ERP reported ${claimed} students but `
            + `${parsed.rollNos.length} roll numbers were parsed.`);
    }

    return { ...parsed, meta: erpGroupMeta(data) };
}

// "Subject mapping not found" / "subject match not found" — the ERP saying it
// cannot resolve the CLASS at all, as opposed to resolving it and finding no
// students in that attendance group. The difference decides whether retrying
// with a different abbreviation is worth anything.
function isClassIdentityError(message) {
    return /(mapping|match|subject)\s+not\s+found|no\s+such\s+subject/i.test(String(message || ''));
}

// One abbreviation, every attendance group. The abbreviation is sent EXACTLY
// as the timetable spells it, parentheses and all — the ERP stores it the same
// way ("FPGA(DE/GE)", "AMP (Sec-B)"), so there is nothing to normalise and
// rewriting it would only hide a class the ERP genuinely has no mapping for.
async function sweepAttGroups(payloadBase) {
    const seen = new Set();
    const rollNos = [];
    const groups = [];
    const errors = [];
    let faculty = null;

    for (const attGroup of ERP_ATT_GROUPS) {
        try {
            // eslint-disable-next-line no-await-in-loop
            const one = await fetchGroupRolls({ ...payloadBase, att_group: String(attGroup) });
            let added = 0;
            for (const roll of one.rollNos) {
                if (seen.has(roll)) continue;
                seen.add(roll);
                rollNos.push(roll);
                added += 1;
            }
            // The ERP carries no faculty today; if it ever does, the first
            // group to report one speaks for the subject.
            if (!faculty && one.faculty) faculty = one.faculty;
            groups.push({
                attGroup: String(attGroup),
                ok: true,
                total: one.rollNos.length,
                added,
                // The ERP's own description of this group — routinely a
                // different department and subject code from the row's, since
                // a group is often another branch taking the subject.
                ...one.meta,
                faculty: one.faculty || null,
            });
        } catch (err) {
            groups.push({ attGroup: String(attGroup), ok: false, total: 0, added: 0, error: err.message });
            errors.push(`group ${attGroup}: ${err.message}`);
        }
    }

    return {
        rollNos,
        faculty,
        groups,
        errors,
        // True when the ERP could not resolve the CLASS at all, as opposed to
        // resolving it and finding no students. Only changes how the failure
        // is worded — the request itself is never retried differently.
        identityRejected: errors.length === ERP_ATT_GROUPS.length
            && groups.every((g) => !g.ok && isClassIdentityError(g.error)),
    };
}

// The full roster for a subject: every attendance group in ERP_ATT_GROUPS is
// requested in turn and the rolls are unioned, because one request only ever
// returns one group and nothing on our side knows which groups a subject uses.
//
// Returns { rollNos, faculty, payload, groups } — rollNos the combined roster,
// payload the class fields plus the groups asked for (portalKey-free, so
// callers can show what was actually requested), and groups the per-group
// outcome for display/diagnostics.
//
// Groups are asked for SEQUENTIALLY, matching fetchRollsBulk's deliberate
// choice not to burst the ERP server with parallel requests.
async function fetchRollsFromErp(subject, degreeOverride = null) {
    const base = buildErpPayload(subject, degreeOverride);
    const missing = missingPayloadFields(base);
    if (missing.length) {
        throw new Error(
            `Cannot query ERP for "${subject.subjectFullName || subject.subName}" — `
            + `missing ${missing.join(', ')} on the subject record.`);
    }

    const sweep = await sweepAttGroups(base);
    const payload = { ...base, att_groups: [...ERP_ATT_GROUPS] };

    // A group the subject doesn't use fails or comes back empty — expected.
    // Every group failing is not: that is a broken request or an unreachable
    // ERP, and reporting it as "no students" would silently wipe a roster.
    //
    // When they ALL fail the message is usually the ERP's own "Subject mapping
    // not found", which means the ERP has no mapping for this class under the
    // fields we sent — so those fields are named in the error and attached to
    // it. Without that the page can only say "it failed", leaving no way to
    // tell an unmapped subject from a wrong semester.
    if (sweep.errors.length === ERP_ATT_GROUPS.length) {
        const err = new Error(
            `ERP rejected every attendance group (${ERP_ATT_GROUPS.join(', ')}) for `
            + `degree="${base.degree}", department="${base.department}", `
            + `semester="${base.semester}", abbreviation="${base.abbreviation}". `
            + `ERP said: ${sweep.errors[0].replace(/^group \d+: /, '')}`
            + (sweep.identityRejected
                ? ' — the ERP has no mapping for this class; check that it is mapped in the ERP portal '
                  + 'under exactly this semester and abbreviation.'
                : ''));
        err.erpPayload = payload;
        err.erpGroups = sweep.groups;
        console.warn(`[ErpSync] ${err.message}`);
        throw err;
    }

    console.log(`[ErpSync] ${base.semester}/${base.abbreviation}: ${sweep.rollNos.length} rolls from `
        + `${sweep.groups.filter((g) => g.added > 0).map((g) => `group ${g.attGroup}(${g.added})`).join(', ') || 'no group'}`);

    return {
        rollNos: sweep.rollNos,
        faculty: sweep.faculty,
        payload,
        groups: sweep.groups,
    };
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
// a roll is "missed" when no ground_truth/{batch}/{roll} folder exists.
// Always scans every batch folder — dept-scoped filtering was dropped because
// Subject.dept is frequently blank or doesn't literally match the batch
// folder name, which silently marked every roll as missing unless Institute
// Wise was ticked.
function computeMissedGroundTruth(rollNos) {
    if (!fs.existsSync(GROUND_TRUTH_DIR)) return [...rollNos];
    const allBatches = fs.readdirSync(GROUND_TRUTH_DIR);
    const missed = [];
    for (const rollNo of rollNos) {
        const found = allBatches.some(batch =>
            fs.existsSync(path.join(GROUND_TRUTH_DIR, batch, rollNo)));
        if (!found) missed.push(rollNo);
    }
    return missed;
}

// What a sync actually changed about the roster, roll by roll — the page shows
// this for the faculty to approve before any embedding is regenerated, so
// "42 rolls" is never the only evidence that a class was reshuffled.
// Comparison is on the same normalized form rollSetsEqual uses.
function diffRollNos(previous, current) {
    const norm = (list) => new Set((list || []).map((r) => String(r).trim().toUpperCase()));
    const before = norm(previous);
    const after = norm(current);
    return {
        added:   [...after].filter((r) => !before.has(r)),
        removed: [...before].filter((r) => !after.has(r)),
        unchangedCount: [...after].filter((r) => before.has(r)).length,
        previousCount: before.size,
    };
}

async function syncSubjectRolls(subject, isFirstYear = false, degreeOverride = null) {
    const previousRollNos = subject.enrolledRollNos || [];
    const { rollNos, faculty: erpFaculty, groups } =
        await fetchRollsFromErp(subject, degreeOverride);
    if (rollNos.length === 0) {
        return { subjectId: subject._id, subject: subject.subjectFullName,
                 ok: false, groups,
                 error: `ERP returned no roll numbers for attendance groups ${ERP_ATT_GROUPS.join(', ')}` };
    }
    // Roster diff — used by erpAutoSyncScheduler.js to skip embedding
    // regeneration entirely when nothing actually changed since last sync,
    // and shown roll-by-roll on the ERP Sync page as the thing the faculty
    // approves before embeddings are regenerated.
    const rollsChanged = !rollSetsEqual(previousRollNos, rollNos);
    const diff = diffRollNos(previousRollNos, rollNos);

    const missedGroundTruth = computeMissedGroundTruth(rollNos);

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
        // Which rolls this sync added and which it removed, against the roster
        // the Subject held before it. Drives the approval gate on the page.
        diff,
        rollNos,
        // Per-attendance-group breakdown of the combined roster — which groups
        // answered, and how many rolls each contributed.
        groups,
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
// ── Duplicate rows ──────────────────────────────────────────────────────────
// The page was listing the same subject several times over. The cause is not
// the row assembly but the Subject collection itself: a subject record is
// created once per timetable import and keeps that timetable's code forever,
// so a subject taught across several sessions has one document per session.
// collectSubjectsForDept matches Subject.code against the department's
// timetables in EVERY session (deliberately — see timetableCodesForDept), so
// all of those copies come back, one timetable row consumes one of them, and
// the rest are appended by the leftovers pass below as extra rows.
//
// Two rows are the same row when they would send the ERP the same request:
// degree + department + semester + abbreviation is the whole class identity
// as far as the ERP is concerned, so rows sharing it necessarily have the
// same roster and collapsing them loses nothing.
//
// Which copy survives, in order: one with a real Subject record (only that
// can persist a roster), then one whose code is current-session, then the one
// the timetable matched, then the most recently synced/generated, then the
// largest roster, then the newest document.
//
// Current-session code deliberately outranks the timetable match: the match
// in buildSubjectRows consumes whichever copy it reaches first, which is
// insertion order and says nothing about which copy is live.
//
// The losers are reported on the survivor as __duplicates so the page can show
// that a collapse happened rather than silently hiding it.
function dedupeErpRows(rows, currentCodes) {
    const rank = (r) => [
        r.__hasRecord !== false ? 1 : 0,
        currentCodes.has(r.code) ? 1 : 0,
        r.__inTimetable ? 1 : 0,
        Math.max(new Date(r.erpSyncedAt || 0).getTime(),
                 new Date(r.embeddingUpdatedAt || 0).getTime()),
        (r.enrolledRollNos || []).length,
        String(r._id || ''),
    ];
    const better = (a, b) => {
        const ra = rank(a), rb = rank(b);
        for (let i = 0; i < ra.length; i += 1) {
            if (ra[i] === rb[i]) continue;
            return ra[i] > rb[i];
        }
        return false;
    };

    const byClass = new Map();
    for (const row of rows) {
        const erp = buildErpPayload({ ...row, sem: row.__ttSem || row.sem });
        const key = ['degree', 'department', 'semester', 'abbreviation']
            .map((f) => String(erp[f] || '').trim().toLowerCase()).join('|');
        const kept = byClass.get(key);
        if (!kept) { byClass.set(key, { ...row, __duplicates: [] }); continue; }
        // Whichever loses becomes a __duplicates entry on the winner; the
        // winner inherits the loser's own duplicates so nothing is dropped.
        const [win, lose] = better(row, kept) ? [{ ...row, __duplicates: [] }, kept] : [kept, row];
        win.__duplicates = [
            ...(win.__duplicates || []),
            ...(lose.__duplicates || []),
            { _id: lose._id || null, subCode: lose.subCode || '', sem: lose.sem || '', code: lose.code || '' },
        ];
        byClass.set(key, win);
    }
    return [...byClass.values()];
}

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

    // Collapse the same class appearing more than once — see dedupeErpRows.
    const before = rows.length;
    const deduped = dedupeErpRows(rows, await currentSessionCodes());
    if (deduped.length !== before) {
        console.log(`[ErpSync] rows dept=${dept} sem=${sem || 'ALL'}: `
            + `${before} → ${deduped.length} after collapsing duplicate subject records`);
    }
    if (diagnostics) diagnostics.duplicateRowsCollapsed = before - deduped.length;
    rows.length = 0;
    rows.push(...deduped);

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
                // How many other Subject documents describe this same ERP
                // class (older sessions' copies, usually) and were collapsed
                // into this row — see dedupeErpRows.
                duplicateCount:   (s.__duplicates || []).length,
                duplicates:       s.__duplicates || [],
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
                erpLookup:        { ...buildErpPayload({ ...s, sem: s.__ttSem || s.sem }),
                                    att_groups: [...ERP_ATT_GROUPS] },
                // Exactly what the Manual Generation tab would post to
                // /embeddings/generate for this subject. The .pkl is named
                // {sem}_{subject}.pkl (buildEmbeddingPath), so these two
                // fields ARE the embedding's identity — a page that picks
                // them differently writes a file nothing else can find. This
                // page used to send the subject's full name and its
                // ERP-formatted semester, which produced a second, orphaned
                // .pkl for every subject already generated manually.
                //   sem     — the locked timetable's semester, the same value
                //             the Manual tab's Semester dropdown carries
                //             (first-year subjects use their derived student
                //             semester, since Subject.sem is a section string)
                //   subject — the ABBREVIATION (subName), which is what the
                //             Manual tab's subject dropdown holds
                generation: {
                    sem:         s.__isFirstYear ? String(fySem) : String(s.__ttSem || s.sem || ''),
                    subject:     s.subName || s.subjectFullName || '',
                    subjectCode: s.subCode || '',
                },
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
//   { subjectId, dept, sem, abbreviation, degree? }  — backed by a Subject
//   { dept, sem, abbreviation, degree? }             — timetable only
//
// dept + sem + abbreviation are read in BOTH shapes, not just the second: they
// come from the locked timetable and override the Subject document's own
// copies, which are unreliable for addressing the ERP (see applyErpOverrides).
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
// Subject.dept routinely have no dept of their own, and when they do have one
// it is as likely to read "ECE" as the full name the ERP wants.
async function fetchRolls(req, res) {
    try {
        if (!erpConfigured()) {
            return res.status(503).json({ error: 'ERP_PORTAL_KEY not configured on the server.' });
        }
        // previousRollNos — only meaningful for a timetable-only row, whose
        // roster lives in the browser for the session because there is no
        // Subject document to hold it. Sending it back lets the response carry
        // the same added/removed diff a persisted subject gets. Ignored when
        // subjectId names a real Subject: the stored roster is the truth there.
        const { subjectId, degree, dept, sem, abbreviation, previousRollNos } = req.body;
        const hasRealSubject = subjectId && mongoose.Types.ObjectId.isValid(subjectId);

        if (hasRealSubject) {
            const found = await Subject.findById(subjectId).lean();
            if (!found) return res.status(404).json({ error: 'Subject not found' });
            // The page's dept/sem/abbreviation all come from the locked
            // timetable and are what the ERP understands — they win over the
            // Subject document's own copies. See applyErpOverrides.
            const subject = applyErpOverrides(found, { dept, sem, abbreviation });

            const firstYearCodes = await getFirstYearCodes();
            const isFirstYear = firstYearCodes.has(subject.code);
            const result = await syncSubjectRolls(subject, isFirstYear, degree);
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

        const { rollNos, faculty, groups, payload: asked } =
            await fetchRollsFromErp(subject, degree);
        if (rollNos.length === 0) {
            return res.json({
                ok: false, subject: abbreviation, persisted: false, total: 0, rollNos: [], groups,
                error: `ERP returned no roll numbers for attendance groups ${ERP_ATT_GROUPS.join(', ')}`,
            });
        }
        const missedGroundTruth = computeMissedGroundTruth(rollNos);
        return res.json({
            ok: true,
            subject: abbreviation,
            persisted: false,
            rollNos,
            diff: diffRollNos(Array.isArray(previousRollNos) ? previousRollNos : [], rollNos),
            groups,
            total: rollNos.length,
            missedGroundTruth,
            missedCount: missedGroundTruth.length,
            erpFaculty: faculty,
            payload: asked,
        });
    } catch (err) {
        const status = err.response?.status;
        res.status(502).json({
            error: `ERP fetch failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`,
            // The exact class fields sent and what each attendance group
            // answered — the only way to see WHICH field the ERP disagrees
            // with. portalKey is never part of erpPayload.
            payload: err.erpPayload || null,
            groups:  err.erpGroups || null,
        });
    }
}

// POST /erp-sync/fetch-rolls-bulk  { dept, sem?, degree? }
// sem optional — omitted syncs every semester's subjects for the department.
// Sequential on purpose — kinder to the ERP server than a parallel burst.
async function fetchRollsBulk(req, res) {
    try {
        if (!erpConfigured()) {
            return res.status(503).json({ error: 'ERP_PORTAL_KEY not configured on the server.' });
        }
        const { dept, sem, degree } = req.body;
        if (!dept) return res.status(400).json({ error: 'dept is required' });

        // Same subject set the tab lists — dept-owned subjects plus
        // first-year subjects taught by this department's faculty.
        const subjects = await collectSubjectsForDept(dept, sem);

        const results = [];
        for (const subject of subjects) {
            try {
                results.push(await syncSubjectRolls(
                    subject, !!subject.__isFirstYear, degree));
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
//   { subjectId?, degree?, department?, semester?, abbreviation? }
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
        const { subjectId, degree, department, semester, abbreviation } = req.body;

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
            // Same override rule the ERP Sync page's fetch uses — the tab
            // exposes these three as editable inputs precisely so the ERP's
            // own spelling can be supplied when the Subject record's differs.
            subject = applyErpOverrides(found, { dept: department, sem: semester, abbreviation });
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
            const { rollNos, faculty, groups, payload: asked } =
            await fetchRollsFromErp(subject, degree);
            return res.json({
                rollNos, total: rollNos.length, faculty, groups,
                payload: asked, persisted: false,
            });
        }

        const firstYearCodes = await getFirstYearCodes();
        const isFirstYear = firstYearCodes.has(subject.code);
        const result = await syncSubjectRolls(subject, isFirstYear, degree);
        if (!result.ok) return res.status(502).json({ error: result.error });

        res.json({
            rollNos: result.rollNos,
            total:   result.total,
            faculty: result.erpFaculty,
            // Which attendance groups the combined roster came from, and what
            // this fetch changed against the roster the Subject already held.
            groups:  result.groups,
            diff:    result.diff,
            missedGroundTruth: result.missedGroundTruth,
            missedCount: result.missedCount,
            payload: { ...payload, att_groups: [...ERP_ATT_GROUPS] },
            persisted: true,
        });
    } catch (err) {
        const status = err.response?.status;
        res.status(502).json({
            error: `ERP fetch failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`,
            payload: err.erpPayload || null,
            groups:  err.erpGroups || null,
        });
    }
}

// POST /erp-sync/probe
//   { degree, department, semester, abbreviation, att_group, portalKeyField? }
//
// Sends ONE roster request built from exactly the fields in the body and
// returns the raw ERP response, unparsed and uninterpreted, alongside the
// request that produced it. Nothing is persisted and nothing is normalised.
//
// This exists because every other path here interprets the answer, so a
// disagreement between "the request that works when you make it by hand" and
// "the request this server makes" had no way to be seen. Paste the known-good
// payload in and compare.
//
// portalKeyField overrides the field the portal key rides in (default
// ERP_PORTAL_KEY_FIELD). The key's VALUE is never echoed back; only which
// field name carried it.
//
// By default BOTH body encodings are tried — json and form — because "works in
// Postman, fails here" is almost always this: a PHP script reading $_POST sees
// nothing from an application/json body and rejects a request whose fields are
// perfectly correct. Running both side by side names the culprit outright
// instead of leaving it to be guessed at one attempt per round trip. Pass
// `format` to try just one.
async function probeErp(req, res) {
    try {
        if (!erpConfigured()) {
            return res.status(503).json({ error: 'ERP_PORTAL_KEY not configured on the server.' });
        }
        const { degree, department, semester, abbreviation, att_group: attGroup,
                portalKeyField, format } = req.body;

        const keyField = String(portalKeyField || ERP_PORTAL_KEY_FIELD).trim() || ERP_PORTAL_KEY_FIELD;
        const fields = {
            degree:       String(degree || '').trim(),
            department:   String(department || '').trim(),
            semester:     String(semester || '').trim(),
            abbreviation: String(abbreviation || '').trim(),
            att_group:    String(attGroup ?? '').trim(),
        };
        const missing = Object.entries(fields).filter(([, v]) => !v).map(([k]) => k);
        if (missing.length) {
            return res.status(400).json({ error: `Missing ${missing.join(', ')}.` });
        }

        const formats = format ? [String(format).toLowerCase()] : ['json', 'form'];
        const attempts = [];
        for (const fmt of formats) {
            const { body, contentType } = encodeErpBody(
                { [keyField]: ERP_PORTAL_KEY, ...fields }, fmt);
            const started = Date.now();
            try {
                // eslint-disable-next-line no-await-in-loop
                const response = await axios.post(ERP_STUDENTS_API_URL, body, {
                    headers: { 'Content-Type': contentType },
                    timeout: 20000,
                    responseType: 'text',
                    transformResponse: [(d) => d],
                    // Every status is a result worth seeing here, not an exception.
                    validateStatus: () => true,
                });
                const raw = String(response.data ?? '');
                let parsedStatus = null;
                try { parsedStatus = JSON.parse(raw)?.status ?? null; } catch { /* not JSON */ }
                attempts.push({
                    format: fmt,
                    sentContentType: contentType,
                    httpStatus: response.status,
                    erpStatus: parsedStatus,
                    // The one field that answers "did this encoding work?"
                    worked: /^(success|ok|true)$/i.test(String(parsedStatus || '')),
                    responseContentType: response.headers?.['content-type'] || null,
                    latencyMs: Date.now() - started,
                    rawResponse: raw.slice(0, 4000),
                });
            } catch (err) {
                attempts.push({ format: fmt, sentContentType: contentType, error: err.message });
            }
        }

        res.json({
            url: ERP_STUDENTS_API_URL,
            portalKeyField: keyField,
            portalKeyLength: ERP_PORTAL_KEY.length,   // presence/shape, never the value
            configuredFormat: ERP_REQUEST_FORMAT,
            // Exactly the fields that were sent, with the key's value replaced
            // — so spelling can be compared against a request known to work.
            requestSent: { [keyField]: '<redacted>', ...fields },
            attempts,
            // Names the fix directly when the two encodings disagree.
            verdict: (() => {
                const ok = attempts.filter((a) => a.worked).map((a) => a.format);
                if (!ok.length) return 'Neither encoding was accepted — the class fields or the portal key are the problem, not the transport.';
                if (ok.length === formats.length) return 'Both encodings work — the transport is fine; a failing subject is unmapped in the ERP.';
                return `Only ${ok[0]} was accepted — set ERP_REQUEST_FORMAT=${ok[0]} in the server .env.`;
            })(),
        });
    } catch (err) {
        res.status(502).json({
            error: `Probe failed: ${err.message}`,
            url: ERP_STUDENTS_API_URL,
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
    getSettings, updateSettings, probeErp,
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
    // The caller-fields-win rule shared by both fetch entry points. They
    // drifted apart once and a whole page stopped fetching, so it is pinned.
    applyErpOverrides,
    // The roster diff the approval gate is built on, the per-group metadata
    // the page attributes each attendance group with, and the duplicate-row
    // collapse — all pure, all worth pinning.
    diffRollNos, erpGroupMeta, dedupeErpRows,
    // Distinguishes "the ERP has no mapping for this class" from "this group
    // has no students" — it only changes how a failure is worded, but getting
    // it wrong misdirects every diagnosis.
    isClassIdentityError,
    // Exported for healthRoutes.js / uptimeDigestScheduler.js — the ERP
    // reachability probes hit this URL directly (no dedicated ERP health
    // route is assumed to exist on the ERP server).
    ERP_STUDENTS_API_URL,
    // Which JSON field carries the portal key — the ERP's name for it, not
    // the env var's. Exported so the tests can pin the default.
    ERP_PORTAL_KEY_FIELD,
    // Request-body encoding, and the encoder itself — exported so the tests
    // can pin that 'form' really produces urlencoded and 'json' an object.
    ERP_REQUEST_FORMAT, encodeErpBody,
    // The attendance groups every roster request sweeps — exported so the
    // tests can pin the sweep and callers can report which groups were asked.
    ERP_ATT_GROUPS,
};
