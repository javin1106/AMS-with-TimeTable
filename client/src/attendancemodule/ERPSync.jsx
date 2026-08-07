// client/src/attendancemodule/ERPSync.jsx
// ERP Sync — fetch each subject's enrolled roll numbers from the external
// ERP server (which addresses a class by degree + department + semester +
// subject abbreviation, e.g. B.Tech / Electronics and Communication
// Engineering / B.Tech-ECE-5 / AWP(ECE)) and
// generate that subject's embeddings for every model (InsightFace mean +
// top-K, AdaFace mean + top-K, subject PKLs for both spaces) using the same
// stateless generation pipeline as the Embedding Generation page.
//
// Mirrors EmbeddingGeneration.jsx's functionality: dept → semester cascade,
// live SSE per-student progress. Ground-truth photo lookup always scans
// every department's batch folders — Subject.dept is too unreliable to
// scope that search by.

import { useState, useRef, useCallback, useEffect } from 'react';
import { theme, styles, cssReset } from './config';
import getEnvironment from '../getenvironment';
import { useDepartments } from './useDepartments';

const apiUrl = getEnvironment();
const ERP_SYNC_API = `${apiUrl}/attendancemodule/erp-sync`;

// Sentinel for the Semester dropdown's explicit "First Year" entry — must
// match FIRST_YEAR_SENTINEL in erpSyncController.js. First-year subjects
// have no real semester number (Subject.sem holds a section string), so
// they're unreachable through the normal numeric dropdown; this value picks
// them out explicitly, regardless of which numeric semesters the dept's
// timetable happens to expose.
const FIRST_YEAR_SENTINEL = 'FIRST_YEAR';
const EMB_API      = `${apiUrl}/attendancemodule/embeddings`;

// 'none'    — never generated
// 'stale'   — embeddings exist but predate the last ERP sync (roster may
//             have changed since); a failed/skipped generate also shows here
//             since embeddingUpdatedAt then stays behind erpSyncedAt
// 'current' — embeddings generated at or after the last sync
function embeddingStatus(s) {
  if (!s.embeddingUpdatedAt) return 'none';
  if (s.erpSyncedAt && new Date(s.embeddingUpdatedAt) < new Date(s.erpSyncedAt)) return 'stale';
  return 'current';
}

// Identifies a table row. A subject the timetable schedules but the Subject
// collection never got has no _id, so it is keyed by what does identify it to
// the ERP: its semester and abbreviation.
function rowKey(s) {
  return s._id ? String(s._id) : `tt:${s.erpLookup?.semester || s.sem}:${s.subName}`;
}

// The ERP serves ONE attendance group per request, so the server asks for
// every group (1–5) and returns the union. `groups` is that per-group
// breakdown; only the groups that actually contributed rolls are worth
// naming — the rest are groups this subject simply doesn't use.
function groupSummary(groups) {
  const contributing = (groups || []).filter((g) => g.added > 0);
  if (!contributing.length) return '';
  return ` from group${contributing.length > 1 ? 's' : ''} `
    + contributing.map((g) => `${g.attGroup} (${g.added})`).join(' + ');
}

// ── Roll number chips ───────────────────────────────────────────────────────
// Same presentation the View Embedding Summary tab uses for its roll lists
// (EmbeddingGeneration.jsx's RollChips): monospace chips, wrapped, tinted by
// what the list means. A comma-joined string of eighty roll numbers is
// unreadable, and this page shows four such lists — roster, missing ground
// truth, added, removed — which only tell each other apart by colour.
function RollChips({ rolls, color, bg, border }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {rolls.map((r) => (
        <span key={r} style={{
          fontFamily: theme.fontMono, fontSize: 10,
          padding: '2px 7px', borderRadius: 4,
          background: bg, color, border: `1px solid ${border}`,
        }}>{r}</span>
      ))}
    </div>
  );
}

// One titled block of chips inside the expanded panel — heading, count, and
// an explicit empty state, so "nothing here" never reads as "not loaded".
function RollSection({ title, rolls, color, bg, hint, empty }) {
  return (
    <div>
      <div style={{
        fontSize: 11, fontWeight: 700, color, marginBottom: 6,
        textTransform: 'uppercase', letterSpacing: '0.06em',
      }}>
        {title} ({rolls.length})
      </div>
      {hint && <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: 8 }}>{hint}</div>}
      {rolls.length === 0
        ? <span style={{ fontSize: 12, color: theme.textMuted }}>{empty}</span>
        : <RollChips rolls={rolls} color={color} bg={bg} border={`${color}44`} />}
    </div>
  );
}

// ── Where each value comes from ─────────────────────────────────────────────
// This page shows three different systems' data side by side and they
// routinely disagree: the ERP has its own spelling of a subject and its own
// idea of who is enrolled, the timetable module owns the schedule and the
// faculty allotment, and the attendance module owns the ground-truth photos
// and the embedding files. Every column is labelled with its source so a
// mismatch is read as a mismatch rather than as a bug in one of them.
const SOURCES = {
  erp: { label: 'ERP', bg: '#ede9fe', color: '#6d28d9',
         title: 'Fetched live from the NITJ ERP roster API' },
  tt:  { label: 'Timetable', bg: '#dbeafe', color: '#1d4ed8',
         title: 'From the timetable module — the locked timetable (LockSem) and the Subject collection' },
  ams: { label: 'Attendance', bg: '#dcfce7', color: '#15803d',
         title: 'From the attendance module — ground-truth photo folders and generated embedding files stored here' },
};

function SourceTag({ source }) {
  const cfg = SOURCES[source];
  if (!cfg) return null;
  return (
    <span
      title={cfg.title}
      style={{
        display: 'inline-block', marginTop: 3, padding: '0 5px', borderRadius: 3,
        fontSize: 8, fontWeight: 800, letterSpacing: '0.04em',
        background: cfg.bg, color: cfg.color,
      }}
    >
      {cfg.label}
    </span>
  );
}

const COLUMNS = [
  { label: 'Subject',        source: 'tt' },
  { label: 'ERP lookup',     source: 'tt' },
  { label: 'Att. groups',    source: 'erp' },
  { label: 'Faculty',        source: 'erp' },
  { label: 'Enrolled',       source: 'erp' },
  { label: 'Missing GT',     source: 'ams' },
  { label: 'Embedding file', source: 'ams' },
  { label: 'Last synced',    source: 'ams' },
  { label: 'Actions',        source: null },
];

function StatusBadge({ status }) {
  const cfg = {
    done:       { bg: '#dcfce7', color: '#16a34a', label: 'done' },
    processing: { bg: '#e0e7ff', color: '#4f46e5', label: 'processing' },
    failed:     { bg: '#fee2e2', color: '#ef4444', label: 'failed' },
  }[status] || { bg: '#f1f5f9', color: '#64748b', label: status };
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700,
      background: cfg.bg, color: cfg.color,
    }}>
      {cfg.label}
    </span>
  );
}

// `embedded` — rendered inside another page (the Subject Embeddings page's
// "ERP Embedding Generation" tab): skips the page wrapper, css reset and the
// big heading, which the host page already provides.
export default function ERPSync({ fixedDepartment, embedded = false }) {
  const { departments, deptLoading, deptError } = useDepartments();
  const [dept, setDept] = useState(fixedDepartment || '');
  const [semester, setSemester] = useState('');
  const [availableSems, setAvailableSems] = useState([]);
  const [semsLoading, setSemsLoading] = useState(false);

  const [subjects, setSubjects] = useState([]);
  const [erpConfigured, setErpConfigured] = useState(true);
  const [subjectsLoading, setSubjectsLoading] = useState(false);
  // How the server resolved the subject set (which join key produced what) —
  // rendered when the list comes back empty, since the three keys involved
  // fail silently and independently.
  const [diagnostics, setDiagnostics] = useState(null);
  // rowKey → { rollNos, missedGroundTruth, error }. Holds this session's fetch
  // result for every row: it IS the roster for rows with no Subject record
  // (nothing persisted it), and for the rest it records that a fetch happened
  // and how it went, which is what lets the table say "Not available" rather
  // than showing an indistinguishable zero.
  const [rosters, setRosters] = useState({});
  // rowKey → true once the faculty has approved that row's roll-number
  // changes. Cleared for a row whenever it is re-fetched, so every sync that
  // moves students is reviewed on its own terms rather than inheriting the
  // last approval.
  const [approvals, setApprovals] = useState({});
  // rowKey of the row whose roll numbers are expanded. One panel per row
  // holding every list at once — roster, missing ground truth, added, removed
  // — rather than three separate in-cell expansions that could not be read
  // against each other.
  const [expandedRow, setExpandedRow] = useState(null);

  const [fetchingId, setFetchingId] = useState(null);
  const [bulkFetching, setBulkFetching] = useState(false);
  const [generatingId, setGeneratingId] = useState(null);
  const [bulkGenerating, setBulkGenerating] = useState(false);
  const [progressSubject, setProgressSubject] = useState(null);
  const [progressRows, setProgressRows] = useState([]);
  const [doneSummary, setDoneSummary] = useState(null);

  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const showToast = useCallback((msg, type = 'success') => {
    clearTimeout(toastTimer.current);
    setToast({ msg, type });
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // Dept → semester cascade (same endpoint the other pages use)
  useEffect(() => {
    if (!dept) { setAvailableSems([]); setSemester(''); return; }
    setSemsLoading(true);
    fetch(`${apiUrl}/timetablemodule/lock/sems-by-dept?dept=${encodeURIComponent(dept)}`)
      .then((r) => r.json())
      .then((d) => {
        const sems = d.sems || [];
        setAvailableSems(sems);
        if (semester && semester !== FIRST_YEAR_SENTINEL && !sems.includes(String(semester))) setSemester('');
      })
      .catch(() => showToast('Could not load semesters', 'error'))
      .finally(() => setSemsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dept, showToast]);

  const loadSubjects = useCallback(async () => {
    if (!dept) return;
    setSubjectsLoading(true);
    try {
      const semQ = semester ? `&sem=${encodeURIComponent(semester)}` : '';
      const res = await fetch(`${ERP_SYNC_API}/subjects?dept=${encodeURIComponent(dept)}${semQ}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load subjects');
      setSubjects(data.subjects || []);
      setDiagnostics(data.diagnostics || null);
      setErpConfigured(data.erpConfigured !== false);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setSubjectsLoading(false);
    }
  }, [dept, semester, showToast]);

  useEffect(() => { loadSubjects(); }, [loadSubjects]);

  // The roster in force for a row: the persisted one when a Subject record
  // holds it, otherwise whatever this session fetched.
  const rollsFor = useCallback((s) => {
    const fetched = rosters[rowKey(s)];
    if (fetched?.rollNos?.length) return fetched.rollNos;
    return s.enrolledRollNos || [];
  }, [rosters]);

  const missedFor = useCallback((s) => {
    const fetched = rosters[rowKey(s)];
    if (fetched?.rollNos?.length) return fetched.missedGroundTruth || [];
    return s.missedGroundTruth || [];
  }, [rosters]);

  // What a completed sync changed, when it changed anything: { added, removed,
  // unchangedCount, previousCount } against the roster the subject held
  // before. null when nothing has been fetched this session, or when the ERP
  // returned exactly the roster already on file.
  const pendingDiff = useCallback((s) => {
    const d = rosters[rowKey(s)]?.diff;
    if (!d) return null;
    if (!(d.added || []).length && !(d.removed || []).length) return null;
    return d;
  }, [rosters]);

  // The approval gate: a sync that moved roll numbers must be approved by the
  // faculty before Generate will rebuild that subject's embeddings. A sync
  // that changed nothing has nothing to approve and does not gate.
  const needsApproval = useCallback(
    (s) => !!pendingDiff(s) && !approvals[rowKey(s)],
    [pendingDiff, approvals]);

  // The subject identity to generate under — server-supplied so it is
  // literally the same choice the Manual Generation tab makes (locked
  // timetable semester + subject abbreviation), since {sem}_{subject} names
  // the .pkl. The fallbacks only matter for a response predating this field.
  const generationFields = useCallback((s) => ({
    sem:         s.generation?.sem ?? (s.isFirstYear ? String(s.studentSem) : String(s.sem || '')),
    subject:     s.generation?.subject || s.subName || s.subjectFullName || '',
    subjectCode: s.generation?.subjectCode ?? (s.subCode || ''),
  }), []);

  // What the Enrolled column shows: a count, "Not available" once a fetch came
  // back empty or failed, or "—" when nothing has been asked for yet.
  //
  // groups is only known for a roster fetched in THIS session — a persisted
  // one was loaded from the Subject record, which stores the combined roster
  // and not which attendance groups it came from.
  const rollStatus = useCallback((s) => {
    const count = rollsFor(s).length;
    const fetched = rosters[rowKey(s)];
    if (count > 0) return { count, groups: fetched?.groups };
    if (fetched) {
      return {
        unavailable: true,
        error: fetched.error,
        // Present when the ERP rejected the request outright: the class
        // fields sent, and each attendance group's own reply.
        erpPayload: fetched.erpPayload,
        erpGroups: fetched.erpGroups,
      };
    }
    return {};
  }, [rollsFor, rosters]);

  // subject param carries the live row so fetchingId reflects real per-subject
  // progress — used both for the single "Fetch from ERP" button and, looped
  // sequentially, for "Fetch all from ERP" below.
  //
  // Rows without a Subject record (a subject the timetable schedules but the
  // Subject collection never got) come back unpersisted, so their roster is
  // kept here in `rosters` for the session — enough to display it and to
  // generate embeddings from it.
  const fetchRolls = async (subject, { silent = false } = {}) => {
    const key = rowKey(subject);
    setFetchingId(key);
    const label = subject.subName || subject.subjectFullName;
    try {
      const res = await fetch(`${ERP_SYNC_API}/fetch-rolls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Degree is not sent: the server derives it from the subject record,
        // or from the semester prefix ("B.Tech-ECE-5" → "B.Tech").
        //
        // dept + sem + abbreviation are always sent. They back the ERP
        // request's department/semester/abbreviation when no Subject record
        // does — the same three fields the Manual Generation tab posts — and
        // the timetable's semester string is the one the ERP understands.
        body: JSON.stringify({
          subjectId: subject._id || undefined,
          dept,
          sem: subject.erpLookup?.semester || subject.sem,
          abbreviation: subject.erpLookup?.abbreviation || subject.subName,
          // A timetable-only row's roster lives here in the browser (nothing
          // persisted it), so the server has no "before" to diff against
          // unless we send it. Ignored when subjectId names a real Subject.
          previousRollNos: subject.hasSubjectRecord === false ? rollsFor(subject) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // A rejection carries the exact class fields that were sent and each
        // attendance group's reply — kept on the row so "subject match not
        // found" can be traced to the field the ERP spells differently.
        const err = new Error(data.error || 'ERP fetch failed');
        err.erpPayload = data.payload || null;
        err.erpGroups = data.groups || null;
        throw err;
      }

      // A fresh sync is a fresh thing to approve — never carry the previous
      // approval over to a roster nobody has looked at yet.
      setApprovals((prev) => {
        if (!prev[key]) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });

      // The ERP answers "no such class" as a 200 with an empty roster, so an
      // unsuccessful result is a normal response, not an exception.
      if (data.ok === false) {
        setRosters((prev) => ({ ...prev, [key]: { rollNos: [], error: data.error || 'No roll numbers' } }));
        if (!silent) showToast(`${label}: ${data.error || 'no roll numbers'}`, 'error');
        return false;
      }

      setRosters((prev) => ({
        ...prev,
        [key]: {
          rollNos: data.rollNos || [],
          missedGroundTruth: data.missedGroundTruth || [],
          // Per-attendance-group breakdown of the combined roster (the ERP
          // serves one group per request, so the server sweeps groups 1–5 and
          // unions them) — rendered under the roll count.
          groups: data.groups || [],
          // { added, removed, unchangedCount, previousCount } against the
          // roster held before this sync — what the faculty approves.
          diff: data.diff || null,
          error: null,
        },
      }));
      const changed = (data.diff?.added?.length || 0) + (data.diff?.removed?.length || 0);
      if (!silent) showToast(`${label}: ${data.total} rolls${groupSummary(data.groups)}`
        + ` (${data.missedCount} missing GT)`
        + (changed
          ? ` — ${data.diff.added.length} added, ${data.diff.removed.length} removed: approve to generate`
          : ' — no roster change'));
      // Only a persisted fetch changes what the server would return.
      if (data.persisted) await loadSubjects();
      return true;
    } catch (err) {
      setRosters((prev) => ({
        ...prev,
        [key]: {
          rollNos: [], error: err.message,
          erpPayload: err.erpPayload || null,
          erpGroups: err.erpGroups || null,
        },
      }));
      showToast(`${label}: ${err.message}`, 'error');
      return false;
    } finally {
      setFetchingId(null);
    }
  };

  // Sequential client-side loop (not the one-shot bulk endpoint) so each
  // subject's row shows its own "Syncing…" state as it's reached, instead of
  // the whole table going dark until the batch finishes.
  const fetchAllRolls = async () => {
    if (!subjects.length) { showToast('No subjects to sync', 'error'); return; }
    setBulkFetching(true);
    let ok = 0, failed = 0;
    for (const subject of subjects) {
      // eslint-disable-next-line no-await-in-loop
      const success = await fetchRolls(subject, { silent: true });
      if (success) ok += 1; else failed += 1;
    }
    setBulkFetching(false);
    showToast(`Fetched ${ok}/${subjects.length} subjects from ERP${failed ? ` — ${failed} failed` : ''}`,
      failed ? 'error' : 'success');
  };

  // Reuses the Embedding Generation page's SSE endpoint — with subjectId
  // (Subject bookkeeping) and rosterExact (PKL contains exactly this roster).
  //
  // sem/subject/subjectCode come from the server's `generation` block, which
  // is the SAME identity the Manual Generation tab posts: the locked
  // timetable's semester and the subject ABBREVIATION. The .pkl is named
  // {sem}_{subject}.pkl, so picking them differently here (this page used to
  // send the subject's full name and the ERP-formatted semester) writes a
  // second, orphaned file that neither the Manual tab's existing-embedding
  // check nor attendance can find.
  // skipConfirm: true when Generate-all already asked one blanket confirmation.
  const generateForSubject = async (subject, skipConfirm = false) => {
    const rollNos = rollsFor(subject);
    if (!rollNos.length) {
      showToast('Fetch rolls from ERP first', 'error');
      return false;
    }
    // Faculty approval gate — a sync that changed the roster must be reviewed
    // and approved before its embeddings are rebuilt, so students are never
    // added to or dropped from a subject's face recognition without someone
    // having seen exactly which roll numbers moved.
    if (needsApproval(subject)) {
      showToast(`${subject.subName || subject.subjectFullName}: approve the roll number changes first`, 'error');
      return false;
    }
    const gen = generationFields(subject);

    // Existing-embedding check, the same one the Manual Generation tab runs
    // (dept + subject + subCode) — Subject.embeddingFile only knows about
    // subjects that have a Subject record, and says nothing about a .pkl a
    // timetable-only row would overwrite.
    if (!skipConfirm) {
      let existing = subject.embeddingFile || null;
      try {
        const chkUrl = `${EMB_API}/check?dept=${encodeURIComponent(dept)}`
          + `&subject=${encodeURIComponent(gen.subject)}`
          + (gen.subjectCode ? `&subCode=${encodeURIComponent(gen.subjectCode)}` : '');
        const chkRes = await fetch(chkUrl);
        const chkData = await chkRes.json().catch(() => ({}));
        if (chkRes.ok && chkData.found) existing = chkData.filename || existing;
      } catch (_) { /* best-effort check — never blocks generation */ }
      if (existing) {
        const ok = window.confirm(
          `"${subject.subjectFullName}" already has embeddings (${existing}).\n\n`
          + 'Generating again will REPLACE the existing embedding file. Continue?'
        );
        if (!ok) return false;
      }
    }
    setGeneratingId(rowKey(subject));
    setProgressSubject(subject.subjectFullName || subject.subName);
    setProgressRows([]);
    setDoneSummary(null);
    try {
      const res = await fetch(`${EMB_API}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sem:         gen.sem,
          subject:     gen.subject,
          dept,
          subjectCode: gen.subjectCode,
          rollNos,
          // Absent for a timetable-only subject — there is no document to do
          // the bookkeeping on. The .pkl is still written either way. Guarded
          // the same way the Manual tab guards it: the subject dropdown can
          // put a NAME in _id when no Subject document exists.
          subjectId: /^[0-9a-fA-F]{24}$/.test(String(subject._id || '')) ? subject._id : undefined,
          // Kept (the Manual tab does not send it): this page always posts a
          // real ERP roster, and the .pkl must contain exactly those students
          // rather than every folder in the batch directory.
          rosterExact: true,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Server error ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try {
            const ev = JSON.parse(line.slice(6).trim());
            if (ev.type === 'student') {
              setProgressRows((prev) => {
                const others = prev.filter((r) => r.rollNo !== ev.rollNo);
                return [...others, { rollNo: ev.rollNo, status: ev.status, note: ev.reason || (ev.photosUsed ? `${ev.photosUsed} photos` : '') }];
              });
            } else if (ev.type === 'stage' || ev.type === 'warning') {
              setProgressRows((prev) => [...prev, { rollNo: '—', status: ev.type, note: ev.message }]);
            } else if (ev.type === 'done') {
              setDoneSummary(ev);
            } else if (ev.type === 'error') {
              throw new Error(ev.message);
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }
      showToast(`${subject.subName || subject.subjectFullName}: embeddings generated`);
      await loadSubjects();
      return true;
    } catch (err) {
      showToast(`Generate failed: ${err.message}`, 'error');
      return false;
    } finally {
      setGeneratingId(null);
    }
  };

  const generateAll = async () => {
    const withRolls = subjects.filter((s) => rollsFor(s).length > 0);
    if (!withRolls.length) { showToast('No subjects with ERP rolls yet', 'error'); return; }

    // The approval gate applies to Generate all too — subjects whose last sync
    // moved roll numbers are held back until reviewed, rather than the bulk
    // button quietly overriding a check the per-row button enforces.
    const held = withRolls.filter(needsApproval);
    const ready = withRolls.filter((s) => !needsApproval(s));
    if (!ready.length) {
      showToast(`All ${held.length} subjects have unapproved roll number changes — review them first`, 'error');
      return;
    }

    // One blanket confirmation for every subject whose embeddings would be
    // replaced — individual runs below are then not re-confirmed.
    const replacing = ready.filter((s) => s.embeddingFile);
    if (replacing.length > 0) {
      const preview = replacing.slice(0, 6).map((s) => s.subjectFullName).join(', ');
      const more = replacing.length > 6 ? ` and ${replacing.length - 6} more` : '';
      const ok = window.confirm(
        `${replacing.length} of ${ready.length} subjects already have embeddings `
        + `(${preview}${more}).\n\nGenerating will REPLACE their existing embedding files. `
        + 'Continue for all subjects?'
      );
      if (!ok) return;
    }

    setBulkGenerating(true);
    for (const subject of ready) {
      // sequential — one SSE run at a time, progress panel shows the current one
      // eslint-disable-next-line no-await-in-loop
      await generateForSubject(subject, true);
    }
    setBulkGenerating(false);
    showToast(`Generate-all finished${held.length ? ` — ${held.length} skipped, awaiting approval` : ''}`,
      held.length ? 'error' : 'success');
  };

  // Approves this row's pending roll-number changes, unblocking Generate.
  const approveDiff = (subject) => {
    setApprovals((prev) => ({ ...prev, [rowKey(subject)]: true }));
    showToast(`${subject.subName || subject.subjectFullName}: roll number changes approved`);
  };

  // Approves every row currently holding unapproved changes — the bulk
  // counterpart, for a faculty who has just reviewed a whole semester.
  const approveAll = () => {
    const pending = subjects.filter(needsApproval);
    if (!pending.length) { showToast('Nothing is awaiting approval', 'error'); return; }
    setApprovals((prev) => {
      const next = { ...prev };
      for (const s of pending) next[rowKey(s)] = true;
      return next;
    });
    showToast(`Approved roll number changes for ${pending.length} subject${pending.length === 1 ? '' : 's'}`);
  };

  const busy = bulkFetching || bulkGenerating || !!generatingId || !!fetchingId;

  return (
    <div style={embedded ? undefined : styles.page}>
      {!embedded && <style>{cssReset}</style>}
      {toast && (
        <div style={{
          position: 'fixed', top: 96, left: '50%', transform: 'translateX(-50%)', zIndex: 9000,
          padding: '12px 24px', borderRadius: 8, fontSize: 13, fontWeight: 700,
          background: toast.type === 'error' ? theme.danger : theme.success, color: '#fff',
        }}>
          {toast.msg}
        </div>
      )}

      <div style={{ marginBottom: embedded ? 14 : 24 }}>
        {!embedded && <div style={styles.heading}>ERP Sync</div>}
        <div style={{ ...styles.subheading, marginBottom: 0 }}>
          Fetch each subject&rsquo;s enrolled roll numbers from the ERP server (looked up by degree,
          department, semester and subject abbreviation) and generate embeddings for every model —
          InsightFace, top-K galleries and AdaFace — over the fetched roster. The ERP returns one
          attendance group per request, so every group is asked for and the rolls are combined into
          a single roster.
        </div>
      </div>

      {!erpConfigured && (
        <div style={{ ...styles.card, marginBottom: 16, borderLeft: `4px solid ${theme.warning}`, fontSize: 13 }}>
          ⚠ <strong>ERP_PORTAL_KEY is not configured on the server.</strong> Subject listing works, but
          fetching rolls from the ERP will fail until the portal key (ERP_PORTAL_KEY, or its
          PORTAL_KEY alias — plus an optional ERP_STUDENTS_API_URL override) is set on the Node
          server and the server is restarted.
        </div>
      )}

      {/* Filters */}
      <section style={{ ...styles.card, marginBottom: 18 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
          <div style={{ minWidth: 220, flex: '2 1 220px' }}>
            <label style={styles.label}>Department</label>
            <select
              value={dept}
              onChange={(e) => { setDept(e.target.value); setSubjects([]); setRosters({}); }}
              style={styles.select}
              disabled={deptLoading || !!fixedDepartment || busy}
            >
              <option value="">{deptLoading ? 'Loading...' : deptError ? 'Error' : 'Select...'}</option>
              {departments.map((d) => <option key={d} value={d}>{d.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <div style={{ minWidth: 130, flex: '1 1 130px' }}>
            <label style={styles.label}>Semester</label>
            <select
              value={semester}
              onChange={(e) => { setSemester(e.target.value); setSubjects([]); setRosters({}); }}
              style={styles.select}
              disabled={!dept || semsLoading || busy}
            >
              <option value="">{!dept ? 'Select Dept First' : semsLoading ? 'Loading...' : 'All semesters'}</option>
              {dept && <option value={FIRST_YEAR_SENTINEL}>First Year</option>}
              {availableSems.map((sem) => <option key={sem} value={sem}>{sem}</option>)}
            </select>
          </div>
          {/* No Degree control — the ERP request's degree is derived from the
              subject record, falling back to its semester prefix
              ("B.Tech-ECE-5" → "B.Tech"). The per-row ERP lookup tooltip shows
              what was derived. */}
          <div style={{ flex: 1 }} />
          <button
            onClick={fetchAllRolls}
            disabled={!dept || busy || !erpConfigured}
            style={{ ...styles.btnPrimary, opacity: (!dept || busy || !erpConfigured) ? 0.6 : 1, whiteSpace: 'nowrap' }}
          >
            {bulkFetching ? 'Fetching from ERP…' : semester ? 'Fetch all from ERP' : 'Fetch all sems from ERP'}
          </button>
          {/* Only rendered when something is actually held back, so the
              approval step stays invisible on a sync that changed nothing. */}
          {subjects.some(needsApproval) && (
            <button
              onClick={approveAll}
              disabled={busy}
              title="Approve the roll number changes on every subject that is waiting, unblocking Generate for them"
              style={{ ...styles.btnPrimary, background: theme.warning, opacity: busy ? 0.6 : 1, whiteSpace: 'nowrap' }}
            >
              Approve all changes ({subjects.filter(needsApproval).length})
            </button>
          )}
          <button
            onClick={generateAll}
            disabled={!dept || busy || subjects.every((s) => !rollsFor(s).length)}
            style={{ ...styles.btnPrimary, background: theme.success, opacity: (!dept || busy) ? 0.6 : 1, whiteSpace: 'nowrap' }}
          >
            {bulkGenerating ? 'Generating all…' : 'Generate all'}
          </button>
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: theme.textMuted }}>
          {/* There is no subject picker here — department + semester resolves
              the subject set, and every one of them gets its own ERP roster
              request. Stating the count makes that set visible before a
              bulk run is started. */}
          {dept && !subjectsLoading && (
            <div style={{ marginBottom: 4 }}>
              <strong>{subjects.length}</strong> subject{subjects.length !== 1 ? 's' : ''} resolved for{' '}
              {dept.replace(/_/g, ' ')}
              {semester === FIRST_YEAR_SENTINEL
                ? ' · First Year'
                : semester ? ` · semester ${semester}` : ' · all semesters'}
              {subjects.length > 0 && ' — Fetch all sends one ERP roster request per subject.'}
              {subjects.some((s) => s.hasSubjectRecord === false) && (
                <> Subjects marked <strong>NO SUBJECT RECORD</strong> are fetched and generated the same
                way, but their roster is not saved.</>
              )}
              {subjects.some((s) => s.duplicateCount > 0) && (
                <> Rows marked <strong>+N DUPLICATE</strong> collapse older Subject records that describe
                the same ERP class.</>
              )}
            </div>
          )}
          {/* Source legend — the table interleaves three systems' data and
              each column is tagged with which one it came from. */}
          {dept && !subjectsLoading && subjects.length > 0 && (
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginTop: 2 }}>
              <span style={{ fontWeight: 700 }}>Where the data comes from:</span>
              {Object.entries(SOURCES).map(([k, cfg]) => (
                <span key={k} style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                  <SourceTag source={k} />
                  <span>{cfg.title}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Subject table — grouped semester-wise */}
      <section style={{ ...styles.card, marginBottom: 18, padding: 0, overflowX: 'auto' }}>
        {!dept ? (
          <div style={{ padding: 32, textAlign: 'center', color: theme.textMuted, fontSize: 13 }}>
            Select a department to list its subjects semester-wise.
          </div>
        ) : subjectsLoading ? (
          <div style={{ padding: 32, textAlign: 'center', color: theme.textMuted, fontSize: 13 }}>Loading subjects…</div>
        ) : subjects.length === 0 ? (
          // An empty set is the one failure this page cannot act on, so it
          // reports which of the three join keys came up short rather than
          // just saying "none" — see collectSubjectsForDept.
          <div style={{ padding: 32, color: theme.textMuted, fontSize: 13 }}>
            <div style={{ textAlign: 'center', fontWeight: 600, marginBottom: diagnostics ? 14 : 0 }}>
              No subjects found for this department{semester ? '/semester' : ''}.
            </div>
            {diagnostics && (
              <div style={{ maxWidth: 620, margin: '0 auto', fontSize: 12, lineHeight: 1.7 }}>
                <div>
                  Timetables matched for this department:{' '}
                  <strong>{diagnostics.timetableCodes?.length || 0}</strong>
                  {diagnostics.timetableCodes?.length > 0 && (
                    <span style={{ fontFamily: theme.fontMono }}> ({diagnostics.timetableCodes.join(', ')})</span>
                  )}
                </div>
                <div>
                  Subjects in the locked timetable for{' '}
                  {semester === FIRST_YEAR_SENTINEL ? 'First Year' : semester ? `semester ${semester}` : 'all semesters'}:{' '}
                  <strong>{diagnostics.timetableSubjectNames?.length || 0}</strong>
                </div>
                <div>
                  Subject records considered: <strong>{diagnostics.subjectCollectionCandidates || 0}</strong>
                </div>
                {(diagnostics.timetableCodes?.length || 0) === 0
                  && (diagnostics.timetableSubjectNames?.length || 0) === 0 && (
                  <div style={{ marginTop: 10 }}>
                    No timetable was matched for this department at all — check that a timetable exists
                    for it (and is marked as the current session).
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <table className="ams-table" style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: theme.surfaceAlt || '#f8fafc' }}>
                {COLUMNS.map((c) => (
                  <th key={c.label} style={{ textAlign: 'left', padding: '10px 12px', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: theme.textMuted, borderBottom: `1px solid ${theme.border}` }}>
                    <div>{c.label}</div>
                    {/* Where this column's value actually comes from. The page
                        mixes three sources and they disagree often enough
                        (the ERP's spelling of a subject, the timetable's
                        faculty, our own ground-truth folders) that reading a
                        column without knowing its origin is misleading. */}
                    {c.source && <SourceTag source={c.source} />}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(() => {
                const rows = [];
                let lastGroup = null;
                for (const s of subjects) {
                  const group = s.groupLabel || `Semester ${s.sem}`;
                  if (group !== lastGroup) {
                    lastGroup = group;
                    rows.push(
                      <tr key={`group-${group}`}>
                        <td colSpan={COLUMNS.length} style={{
                          padding: '8px 12px', background: theme.surfaceAlt || '#f1f5f9',
                          fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
                          letterSpacing: '0.06em', color: theme.text,
                          borderBottom: `1px solid ${theme.border}`,
                        }}>
                          {group}
                          {s.isFirstYear && (
                            <span style={{ marginLeft: 8, fontWeight: 400, textTransform: 'none', color: theme.textMuted }}>
                              — taught by this department&rsquo;s faculty; institute-wide search applied automatically
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  }
                  const key = rowKey(s);
                  const roll = rollStatus(s);
                  const missed = missedFor(s);
                  const diff = pendingDiff(s);
                  rows.push(
                    <tr key={key} style={{ borderBottom: `1px solid ${theme.border}` }}>
                      <td style={{ padding: '9px 12px' }}>
                        <div style={{ fontWeight: 600 }}>
                          {s.subjectFullName}
                          {s.hasSubjectRecord === false && (
                            <span
                              title="Scheduled in the timetable but absent from the Subject collection. Its roster can be fetched and its embeddings generated, but the roster is not saved — it is kept only until this page is reloaded."
                              style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: '#f1f5f9', color: '#64748b', verticalAlign: 'middle' }}
                            >
                              NO SUBJECT RECORD
                            </span>
                          )}
                          {s.duplicateCount > 0 && (
                            <span
                              title={`${s.duplicateCount} other Subject record${s.duplicateCount === 1 ? '' : 's'} describe the same ERP class `
                                + '(usually copies from earlier sessions, each carrying that session\'s timetable code) and '
                                + 'were collapsed into this row, which would otherwise be listed once per copy: '
                                + (s.duplicates || []).map((d) => `${d.subCode || '(no code)'} · sem ${d.sem || '?'} · ${d.code || 'no timetable code'}`).join(' | ')}
                              style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: '#fee2e2', color: '#b91c1c', verticalAlign: 'middle' }}
                            >
                              +{s.duplicateCount} DUPLICATE
                            </span>
                          )}
                          {s.isFirstYear && (
                            <span
                              title="First-year (Basic Sciences) subject — ground-truth search runs institute-wide automatically"
                              style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: '#e0e7ff', color: '#4f46e5', verticalAlign: 'middle' }}
                            >
                              FIRST YEAR
                            </span>
                          )}
                          {s.embeddingFile && embeddingStatus(s) === 'current' && (
                            <span
                              title={`Embeddings up to date (${s.embeddingFile}) — generating again will replace them`}
                              style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: '#dcfce7', color: '#16a34a', verticalAlign: 'middle' }}
                            >
                              EMBEDDED
                            </span>
                          )}
                          {s.embeddingFile && embeddingStatus(s) === 'stale' && (
                            <span
                              title={`Roster changed since these embeddings were generated (${s.embeddingFile}) — regenerate`}
                              style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: '#fef3c7', color: '#b45309', verticalAlign: 'middle' }}
                            >
                              STALE
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 10, color: theme.textMuted }}>{s.subCode} · {s.type}</div>
                      </td>
                      {/* Exactly what gets POSTed to the ERP for this row —
                          degree/department are shown on hover to keep the
                          column narrow. */}
                      <td
                        style={{ padding: '9px 12px', fontFamily: theme.fontMono, fontWeight: 600 }}
                        title={s.erpLookup ? `degree: ${s.erpLookup.degree}\ndepartment: ${s.erpLookup.department}` : undefined}
                      >
                        {s.erpLookup?.semester || s.sem}
                        <span style={{ color: theme.textMuted }}> / </span>
                        {s.erpLookup?.abbreviation || s.subName}
                        {/* The .pkl this row would write is named after the
                            Manual Generation tab's own fields, which are not
                            always the ones sent to the ERP. Showing both stops
                            the two from silently drifting apart again. */}
                        <div style={{ fontSize: 9, color: theme.textMuted, fontFamily: theme.fontBody, fontWeight: 400, marginTop: 2 }}>
                          generates as <span style={{ fontFamily: theme.fontMono }}>
                            {generationFields(s).sem}_{generationFields(s).subject}
                          </span>
                        </div>
                      </td>
                      {/* Attendance groups — the ERP serves one group per
                          request, so all of them are asked for and unioned.
                          A group is frequently another department's students
                          taking this subject, under that department's own
                          subject code, which is why each group's ERP-reported
                          dept/code is shown rather than just a count. */}
                      <td style={{ padding: '9px 12px', fontSize: 11 }}>
                        {(() => {
                          const groups = (rosters[key]?.groups || []).filter((g) => g.added > 0 || g.total > 0);
                          if (!rosters[key]) {
                            return <span style={{ color: theme.textMuted }} title="Fetch this subject to see which attendance groups it spans">—</span>;
                          }
                          if (!groups.length) {
                            return <span style={{ color: theme.textMuted }} title={`No attendance group returned students (asked for ${(s.erpLookup?.att_groups || []).join(', ')})`}>none</span>;
                          }
                          return (
                            <div>
                              <div style={{ fontWeight: 700 }}>
                                {groups.length} group{groups.length === 1 ? '' : 's'}
                              </div>
                              {groups.map((g) => (
                                <div key={g.attGroup} style={{ fontSize: 10, color: theme.textMuted, marginTop: 2 }}>
                                  <span style={{ fontFamily: theme.fontMono, fontWeight: 700, color: theme.text }}>#{g.attGroup}</span>
                                  {' · '}{g.total} student{g.total === 1 ? '' : 's'}
                                  {g.subjectCode && <> · <span style={{ fontFamily: theme.fontMono }}>{g.subjectCode}</span></>}
                                  {g.department && g.department !== s.erpLookup?.department && (
                                    <> · <span title="This group belongs to a different department than the row's" style={{ color: theme.warning, fontWeight: 700 }}>{g.department}</span></>
                                  )}
                                </div>
                              ))}
                            </div>
                          );
                        })()}
                      </td>
                      <td style={{ padding: '9px 12px', fontSize: 11 }}>
                        {s.erpFaculty ? (
                          <span>
                            {s.erpFaculty}
                            {s.facultyMatch === true && (
                              <span title={`Matches timetable: ${s.timetableFaculty}`} style={{ color: theme.success, fontWeight: 700 }}> ✓</span>
                            )}
                            {s.facultyMatch === false && (
                              <span title={`Timetable says: ${s.timetableFaculty || 'no entry found for this sem+abbreviation'}`} style={{ color: theme.warning, fontWeight: 700 }}> ⚠</span>
                            )}
                          </span>
                        ) : <span style={{ color: theme.textMuted }}>—</span>}
                      </td>
                      {/* Enrolled — a count, or an explicit "Not available"
                          once the ERP has been asked and had no roster for
                          this class. A bare 0 could not tell the two apart. */}
                      <td style={{ padding: '9px 12px', fontFamily: theme.fontMono }}>
                        {fetchingId === key ? (
                          <span style={{ color: theme.accent, fontWeight: 700, fontFamily: theme.fontBody }}>⏳</span>
                        ) : roll.count ? (
                          <span>
                            {/* The count opens the roll-number panel below —
                                the roster, the missing ground truth and the
                                sync's added/removed lists all read together,
                                the way the View Embedding Summary tab shows
                                them. */}
                            <button
                              onClick={() => setExpandedRow(expandedRow === key ? null : key)}
                              title="Show this subject's roll numbers"
                              style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontFamily: theme.fontMono, fontSize: 12, fontWeight: 700, color: theme.text }}
                            >
                              {roll.count} <span style={{ color: theme.textMuted }}>{expandedRow === key ? '▲' : '▼'}</span>
                            </button>
                            {/* Which attendance groups this combined roster
                                came from — the ERP serves one group per
                                request, so a class split across groups only
                                adds up after the sweep. */}
                            {groupSummary(roll.groups) && (
                              <div
                                title="The ERP returns one attendance group per request; these groups were combined into the roster above."
                                style={{ fontSize: 9, color: theme.textMuted, fontFamily: theme.fontBody, marginTop: 2 }}
                              >
                                {groupSummary(roll.groups).trim()}
                              </div>
                            )}
                            {/* What the last sync changed, and the approval it
                                is waiting on. Embeddings are not rebuilt from
                                a roster whose changes nobody has looked at. */}
                            {diff && (
                              <div style={{ marginTop: 4, fontFamily: theme.fontBody, fontSize: 10 }}>
                                {diff.added.length > 0 && <span style={{ color: theme.success, fontWeight: 700 }}>+{diff.added.length} </span>}
                                {diff.removed.length > 0 && <span style={{ color: theme.danger, fontWeight: 700 }}>−{diff.removed.length} </span>}
                                {approvals[key] ? (
                                  <span style={{ color: theme.success, fontWeight: 700 }}>✓ approved</span>
                                ) : (
                                  <span style={{ color: theme.warning, fontWeight: 700 }}>needs approval</span>
                                )}
                              </div>
                            )}
                            {!diff && rosters[key] && (
                              <div style={{ marginTop: 4, fontSize: 9, color: theme.textMuted, fontFamily: theme.fontBody }}>
                                no roster change
                              </div>
                            )}
                          </span>
                        ) : roll.unavailable ? (
                          <span style={{ fontFamily: theme.fontBody }}>
                            <button
                              onClick={() => setExpandedRow(expandedRow === key ? null : key)}
                              title={roll.error || 'The ERP returned no roll numbers for this subject'}
                              style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: theme.danger, fontWeight: 700, fontSize: 11 }}
                            >
                              Not available <span style={{ color: theme.textMuted }}>{expandedRow === key ? '▲' : '▼'}</span>
                            </button>
                            {/* The ERP rejects a class it cannot match with
                                "subject match not found", which says nothing
                                about WHICH of the four fields it disagrees
                                with — so the fields actually sent are shown
                                next to the ERP's own reply per group. */}
                            {expandedRow === key && (
                              <div style={{ marginTop: 5, maxWidth: 320, fontSize: 10, color: theme.textMuted, wordBreak: 'break-word' }}>
                                <div style={{ marginBottom: 4 }}>{roll.error}</div>
                                {roll.erpPayload && (
                                  <div style={{ fontFamily: theme.fontMono }}>
                                    {['degree', 'department', 'semester', 'abbreviation'].map((f) => (
                                      <div key={f}>{f}: <strong>{roll.erpPayload[f] || '(empty)'}</strong></div>
                                    ))}
                                  </div>
                                )}
                                {(roll.erpGroups || []).map((g) => (
                                  <div key={g.attGroup} style={{ marginTop: 3 }}>
                                    <span style={{ fontFamily: theme.fontMono, fontWeight: 700 }}>att_group {g.attGroup}</span>
                                    {' → '}{g.error || 'no students'}
                                  </div>
                                ))}
                              </div>
                            )}
                          </span>
                        ) : (
                          <span style={{ color: theme.textMuted }}>—</span>
                        )}
                      </td>
                      <td style={{ padding: '9px 12px' }}>
                        {missed.length > 0 ? (
                          <button
                            onClick={() => setExpandedRow(expandedRow === key ? null : key)}
                            title="Show this subject's roll numbers"
                            style={{ background: 'transparent', border: 'none', color: theme.warning, fontWeight: 700, cursor: 'pointer', fontSize: 12, padding: 0 }}
                          >
                            {missed.length} {expandedRow === key ? '▲' : '▼'}
                          </button>
                        ) : (roll.count ? <span style={{ color: theme.success, fontWeight: 700 }}>0</span> : '—')}
                      </td>
                      <td style={{ padding: '9px 12px', fontFamily: theme.fontMono, fontSize: 11 }}>
                        {generatingId === key ? (
                          <span style={{ color: theme.accent, fontWeight: 700, fontFamily: theme.fontBody }}>⏳ Generating…</span>
                        ) : embeddingStatus(s) === 'current' ? (
                          <span title="Embeddings up to date with the last sync">
                            <span style={{ color: theme.success, fontWeight: 700 }}>✓ </span>{s.embeddingFile}
                          </span>
                        ) : embeddingStatus(s) === 'stale' ? (
                          <span title="Roster changed since these embeddings were generated — regenerate">
                            <span style={{ color: theme.warning, fontWeight: 700 }}>⚠ </span>{s.embeddingFile}
                          </span>
                        ) : (
                          <span style={{ color: theme.textMuted, fontFamily: theme.fontBody }}>— not generated</span>
                        )}
                      </td>
                      <td style={{ padding: '9px 12px', fontSize: 11, color: theme.textMuted }}>
                        {fetchingId === key ? (
                          <span style={{ color: theme.accent, fontWeight: 700 }}>⏳ Syncing…</span>
                        ) : s.erpSyncedAt ? (
                          <span>
                            <span style={{ color: theme.success, fontWeight: 700 }}>✓ </span>
                            {new Date(s.erpSyncedAt).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                          </span>
                        ) : rosters[key] ? (
                          // Fetched this session but nothing was written back —
                          // there is no Subject record to record a sync time on.
                          <span title="Fetched this session; not saved (no subject record)">this session</span>
                        ) : 'never'}
                      </td>
                      <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>
                        <button
                          onClick={() => fetchRolls(s)}
                          disabled={busy || !erpConfigured}
                          style={{ padding: '5px 10px', marginRight: 6, borderRadius: 6, border: `1px solid ${theme.accent}`, background: 'transparent', color: theme.accent, fontSize: 11, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer' }}
                        >
                          {fetchingId === key ? 'Fetching…' : 'Fetch from ERP'}
                        </button>
                        {/* Approval gate — a sync that moved roll numbers has
                            to be reviewed before its embeddings are rebuilt,
                            so nobody is silently added to or dropped from a
                            subject's face recognition. */}
                        {needsApproval(s) && (
                          <button
                            onClick={() => approveDiff(s)}
                            disabled={busy}
                            title={`Approve ${diff.added.length} added and ${diff.removed.length} removed roll number(s) — Generate stays blocked until you do`}
                            style={{ padding: '5px 10px', marginRight: 6, borderRadius: 6, border: 'none', background: theme.warning, color: '#fff', fontSize: 11, fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer' }}
                          >
                            Approve changes
                          </button>
                        )}
                        <button
                          onClick={() => generateForSubject(s)}
                          disabled={busy || !roll.count || needsApproval(s)}
                          title={needsApproval(s)
                            ? 'Approve this sync\'s roll number changes first'
                            : s.embeddingFile ? 'Embeddings exist — will ask before replacing' : undefined}
                          style={{ padding: '5px 10px', borderRadius: 6, border: 'none', background: (roll.count && !needsApproval(s)) ? theme.success : theme.border, color: '#fff', fontSize: 11, fontWeight: 700, cursor: (busy || !roll.count || needsApproval(s)) ? 'not-allowed' : 'pointer' }}
                        >
                          {generatingId === key ? 'Generating…' : s.embeddingFile ? 'Regenerate' : 'Generate'}
                        </button>
                      </td>
                    </tr>
                  );

                  // Expanded roll numbers — one panel spanning the table,
                  // laid out like the View Embedding Summary tab's: chips
                  // rather than a comma-joined line, each list titled and
                  // counted, and the sync's added/removed shown beside the
                  // roster they changed so the approval decision can be made
                  // from one place.
                  if (expandedRow === key && roll.count) {
                    const enrolled = rollsFor(s);
                    const missedSet = new Set(missed);
                    const present = enrolled.filter((r) => !missedSet.has(r));
                    rows.push(
                      <tr key={`${key}-rolls`} style={{ borderBottom: `1px solid ${theme.border}` }}>
                        <td colSpan={COLUMNS.length} style={{ padding: '14px 20px', background: theme.bg }}>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                            <RollSection
                              title="Ground truth present"
                              rolls={present}
                              color={theme.success}
                              bg={theme.successDim}
                              hint="On the roster and holding ground-truth photos — these are the students the embedding is built from."
                              empty="None — no roll on this roster has ground-truth photos."
                            />
                            <RollSection
                              title="Missing ground truth"
                              rolls={missed}
                              color={theme.danger}
                              bg={theme.dangerDim}
                              hint="Enrolled, but no ground_truth folder exists — they are skipped during generation and will never be recognised."
                              empty="All present."
                            />
                          </div>

                          {diff && (
                            <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${theme.border}`, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                              <RollSection
                                title="Added by this sync"
                                rolls={diff.added}
                                color={theme.success}
                                bg={theme.successDim}
                                hint={`Was ${diff.previousCount} · ${diff.unchangedCount} unchanged.`}
                                empty="None."
                              />
                              <RollSection
                                title="Removed by this sync"
                                rolls={diff.removed}
                                color={theme.danger}
                                bg={theme.dangerDim}
                                hint="No longer on the ERP's roster — they lose recognition for this subject once embeddings are rebuilt."
                                empty="None."
                              />
                            </div>
                          )}

                          <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${theme.border}` }}>
                            <RollSection
                              title="Full roster"
                              rolls={enrolled}
                              color={theme.accent}
                              bg={theme.accentDim}
                              hint={s.hasSubjectRecord === false
                                ? 'Held for this session only — there is no Subject record to save it onto.'
                                : 'Saved on the subject record; this is what attendance matches against.'}
                              empty="Empty."
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  }
                }
                return rows;
              })()}
            </tbody>
          </table>
        )}
      </section>

      {/* Live generation progress */}
      {(progressSubject || doneSummary) && (
        <section style={{ ...styles.card }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
            Generation progress — {progressSubject}
            {generatingId && <span style={{ marginLeft: 8, fontSize: 11, color: theme.textMuted }}>(running…)</span>}
          </div>
          {doneSummary && (
            <div style={{ marginBottom: 12, fontSize: 12, padding: '8px 10px', background: theme.surfaceAlt || '#f8fafc', borderRadius: 6 }}>
              <strong style={{ color: theme.success }}>{doneSummary.success} succeeded</strong>
              {' · '}
              <strong style={{ color: doneSummary.failed ? theme.danger : theme.textMuted }}>{doneSummary.failed} failed</strong>
              {' · '}saved as <span style={{ fontFamily: theme.fontMono }}>{doneSummary.embeddingFile}</span>
              {' '}(+ AdaFace sibling when its model is loaded)
            </div>
          )}
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            <table className="ams-table" style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Roll No', 'Status', 'Note'].map((h) => (
                    <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 10, textTransform: 'uppercase', color: theme.textMuted, borderBottom: `1px solid ${theme.border}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {progressRows.map((r, i) => (
                  <tr key={`${r.rollNo}-${i}`} style={{ borderBottom: `1px solid ${theme.border}` }}>
                    <td style={{ padding: '7px 12px', fontFamily: theme.fontMono, fontWeight: 600 }}>{r.rollNo}</td>
                    <td style={{ padding: '7px 12px' }}><StatusBadge status={r.status} /></td>
                    <td style={{ padding: '7px 12px', color: theme.textMuted }}>{r.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
