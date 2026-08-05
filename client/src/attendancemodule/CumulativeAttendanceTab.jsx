// client/src/attendancemodule/CumulativeAttendanceTab.jsx
// Dual cumulative attendance — XCEED's figure beside ERP's, semester-wise and
// subject-wise, with the divergence between them.
//
// Read-only throughout. XCEED's numbers come from our own attendance reports,
// ERP's from the separate ErpAttendanceRecord collection; this page never
// writes to either. There is deliberately no edit control anywhere on it.
//
// The two percentages are NOT computed over the same set of periods unless
// ERP has finalised every one of them, so the divergence column is computed
// from the ERP-covered subset only, and "Coverage" shows how much of the term
// that comparison rests on. A low coverage figure means the divergence is
// based on a small sample, not that the data is wrong.

import { useState, useEffect, useCallback } from 'react';
import { theme as T, styles, DEGREES } from './config';
import getEnvironment from '../getenvironment';

const apiUrl = getEnvironment();
const REPORTS_API = `${apiUrl}/attendancemodule/reports`;
const GT_API = `${apiUrl}/attendancemodule/ground-truth`;
const BATCHES_API = `${apiUrl}/attendancemodule/settings/batches`;

// Divergence is signed: positive means ERP records more attendance than we
// did. Near-zero is the expected state, so it stays visually quiet.
function divergenceColor(pct) {
  const abs = Math.abs(pct);
  if (abs < 1) return T.textMuted;
  if (abs < 5) return T.warning;
  return T.danger;
}

const fmtPct = (v) => `${Number(v ?? 0).toFixed(1)}%`;
const signed = (v) => `${v > 0 ? '+' : ''}${Number(v ?? 0).toFixed(1)}%`;

const th = {
  textAlign: 'left',
  padding: '10px 12px',
  fontSize: '11px',
  fontWeight: 700,
  color: T.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  borderBottom: `1px solid ${T.border}`,
  whiteSpace: 'nowrap',
};
const td = {
  padding: '10px 12px',
  fontSize: '13px',
  borderBottom: `1px solid ${T.border}`,
  verticalAlign: 'middle',
};

function StatTile({ label, value, color }) {
  return (
    <div style={{
      background: T.surfaceAlt,
      border: `1px solid ${T.border}`,
      borderRadius: 10,
      padding: '12px 16px',
      minWidth: 130,
      flex: '1 1 130px',
    }}
    >
      <div style={{ ...styles.label, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || T.text, fontFamily: T.fontMono }}>
        {value}
      </div>
    </div>
  );
}

export default function CumulativeAttendanceTab() {
  const [degree, setDegree] = useState('BTECH');
  const [dept, setDept] = useState('');
  const [year, setYear] = useState('');
  const [departments, setDepartments] = useState([]);
  const [years, setYears] = useState([]);

  const [semester, setSemester] = useState('');
  const [semesters, setSemesters] = useState([]);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Per-row student drill-down, keyed by the row's identity.
  const [expanded, setExpanded] = useState(null);
  const [students, setStudents] = useState(null);
  const [studentsLoading, setStudentsLoading] = useState(false);

  useEffect(() => {
    fetch(BATCHES_API, { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => {
        setYears((d.batches || []).map((b) => b.batchYear).filter(Boolean)
          .sort((a, b) => b.localeCompare(a)));
      })
      .catch(() => setError('Could not load batch years'));

    fetch(`${GT_API}/departments`, { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => {
        setDepartments((d.departments || [])
          .map((item) => (typeof item === 'string' ? item : item.dept))
          .filter(Boolean));
      })
      .catch(() => setError('Could not load departments'));
  }, []);

  const batch = degree && dept && year
    ? `${degree}_${dept.trim().replace(/\s+/g, '_').toUpperCase()}_${year}`
    : '';

  // Semester dropdown reuses the existing export-options endpoint rather than
  // adding a second way to ask the same question.
  useEffect(() => {
    if (!batch) { setSemesters([]); return; }
    fetch(`${REPORTS_API}/export-options?batch=${encodeURIComponent(batch)}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => setSemesters(d.semesters || []))
      .catch(() => setSemesters([]));
  }, [batch]);

  const load = useCallback(async () => {
    if (!batch) { setError('Select degree, department and batch year first.'); return; }
    setLoading(true);
    setError('');
    setExpanded(null);
    setStudents(null);
    try {
      const params = new URLSearchParams({ batch });
      if (semester) params.set('semester', semester);
      if (fromDate) params.set('from', fromDate);
      if (toDate) params.set('to', toDate);
      const res = await fetch(`${REPORTS_API}/cumulative?${params}`, { credentials: 'include' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Request failed');
      setData(json);
    } catch (e) {
      setError(e.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [batch, semester, fromDate, toDate]);

  async function toggleRow(row) {
    const key = `${row.semester}||${row.subCode || row.subject}`;
    if (expanded === key) { setExpanded(null); setStudents(null); return; }
    setExpanded(key);
    setStudents(null);
    setStudentsLoading(true);
    try {
      const params = new URLSearchParams({ batch });
      if (row.semester) params.set('semester', row.semester);
      if (row.subCode) params.set('subCode', row.subCode);
      else if (row.subject) params.set('subject', row.subject);
      if (fromDate) params.set('from', fromDate);
      if (toDate) params.set('to', toDate);
      const res = await fetch(`${REPORTS_API}/cumulative/students?${params}`, { credentials: 'include' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Request failed');
      setStudents(json.students || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setStudentsLoading(false);
    }
  }

  const rows = data?.rows || [];
  const totals = data?.totals;

  return (
    <div>
      <div style={{ ...styles.card, marginBottom: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 140px' }}>
            <label style={styles.label}>Degree</label>
            <select style={styles.select} value={degree} onChange={(e) => setDegree(e.target.value)}>
              {DEGREES.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div style={{ flex: '1 1 180px' }}>
            <label style={styles.label}>Department</label>
            <select style={styles.select} value={dept} onChange={(e) => setDept(e.target.value)}>
              <option value="">Select…</option>
              {departments.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div style={{ flex: '1 1 120px' }}>
            <label style={styles.label}>Batch Year</label>
            <select style={styles.select} value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="">Select…</option>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div style={{ flex: '1 1 120px' }}>
            <label style={styles.label}>Semester</label>
            <select style={styles.select} value={semester} onChange={(e) => setSemester(e.target.value)}>
              <option value="">All semesters</option>
              {semesters.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div style={{ flex: '1 1 140px' }}>
            <label style={styles.label}>From</label>
            <input type="date" style={styles.input} value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>
          <div style={{ flex: '1 1 140px' }}>
            <label style={styles.label}>To</label>
            <input type="date" style={styles.input} value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
          <button type="button" style={styles.btnPrimary} onClick={load} disabled={loading}>
            {loading ? 'Loading…' : 'Load'}
          </button>
        </div>

        {error && (
          <div style={{ marginTop: 12, ...styles.badge('danger') }}>{error}</div>
        )}
      </div>

      {totals && (
        <div style={{ ...styles.card, marginBottom: 16 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <StatTile label="XCEED %" value={fmtPct(totals.xceedPct)} color={T.accent} />
            <StatTile label="ERP %" value={fmtPct(totals.erpPct)} color={T.success} />
            <StatTile
              label="Divergence"
              value={signed(totals.divergencePct)}
              color={divergenceColor(totals.divergencePct)}
            />
            <StatTile label="Student mismatches" value={totals.studentMismatches} />
            <StatTile
              label="ERP coverage"
              value={`${totals.periods.erpCovered}/${totals.periods.total}`}
              color={totals.coveragePct < 50 ? T.warning : T.text}
            />
          </div>
          <p style={{ fontSize: 12, color: T.textMuted, margin: '12px 0 0' }}>
            Both percentages above are computed over the {totals.comparableMarks.toLocaleString()} marks
            ERP has finalised, so they compare like with like. XCEED&apos;s figure across
            <strong> all </strong>
            periods including those ERP has not finalised is {fmtPct(totals.overallXceedPct)}.
          </p>
        </div>
      )}

      {data && rows.length === 0 && !loading && (
        <div style={{ ...styles.card, textAlign: 'center', color: T.textMuted }}>
          No attendance reports found for this selection.
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ ...styles.card, padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
            <thead>
              <tr>
                <th style={th}>Sem</th>
                <th style={th}>Subject Code</th>
                <th style={th}>Subject</th>
                <th style={th}>Faculty</th>
                <th style={{ ...th, textAlign: 'right' }}>XCEED %</th>
                <th style={{ ...th, textAlign: 'right' }}>ERP %</th>
                <th style={{ ...th, textAlign: 'right' }}>Divergence</th>
                <th style={{ ...th, textAlign: 'right' }}>Mismatches</th>
                <th style={{ ...th, textAlign: 'right' }}>Coverage</th>
                <th style={th} aria-label="Expand" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const key = `${row.semester}||${row.subCode || row.subject}`;
                const isOpen = expanded === key;
                return [
                  <tr key={key} style={{ background: isOpen ? T.accentDim : 'transparent' }}>
                    <td style={td}>{row.semester || '—'}</td>
                    <td style={{ ...td, fontFamily: T.fontMono, fontWeight: 600 }}>
                      {row.subCode || <span style={{ color: T.textMuted }}>—</span>}
                    </td>
                    <td style={td}>{row.subject || row.subName || '—'}</td>
                    <td style={{ ...td, color: T.textMuted }}>{row.faculty || '—'}</td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: T.fontMono, color: T.accent }}>
                      {fmtPct(row.comparable.xceedPct)}
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: T.fontMono, color: T.success }}>
                      {row.periods.erpCovered ? fmtPct(row.comparable.erpPct) : '—'}
                    </td>
                    <td style={{
                      ...td,
                      textAlign: 'right',
                      fontFamily: T.fontMono,
                      fontWeight: 700,
                      color: divergenceColor(row.divergencePct),
                    }}
                    >
                      {row.periods.erpCovered ? signed(row.divergencePct) : '—'}
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: T.fontMono }}>
                      {row.studentMismatches || 0}
                    </td>
                    <td style={{
                      ...td,
                      textAlign: 'right',
                      fontFamily: T.fontMono,
                      color: row.periods.erpCovered === 0 ? T.warning : T.textMuted,
                    }}
                    >
                      {row.periods.erpCovered}/{row.periods.total}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <button
                        type="button"
                        style={{ ...styles.btnGhost, padding: '5px 12px', fontSize: 12 }}
                        onClick={() => toggleRow(row)}
                      >
                        {isOpen ? 'Hide' : 'Students'}
                      </button>
                    </td>
                  </tr>,
                  isOpen && (
                    <tr key={`${key}-detail`}>
                      <td colSpan={10} style={{ padding: 0, background: T.surfaceAlt }}>
                        {studentsLoading && (
                          <div style={{ padding: 16, color: T.textMuted, fontSize: 13 }}>
                            Loading students…
                          </div>
                        )}
                        {!studentsLoading && students && students.length === 0 && (
                          <div style={{ padding: 16, color: T.textMuted, fontSize: 13 }}>
                            No student records for this subject.
                          </div>
                        )}
                        {!studentsLoading && students && students.length > 0 && (
                          <div style={{ padding: 12, maxHeight: 340, overflowY: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                              <thead>
                                <tr>
                                  <th style={th}>Roll No</th>
                                  <th style={{ ...th, textAlign: 'right' }}>XCEED %</th>
                                  <th style={{ ...th, textAlign: 'right' }}>ERP %</th>
                                  <th style={{ ...th, textAlign: 'right' }}>Divergence</th>
                                  <th style={{ ...th, textAlign: 'right' }}>Mismatches</th>
                                  <th style={{ ...th, textAlign: 'right' }}>Marks compared</th>
                                </tr>
                              </thead>
                              <tbody>
                                {students.map((s) => (
                                  <tr key={s.rollNo}>
                                    <td style={{ ...td, fontFamily: T.fontMono }}>{s.rollNo}</td>
                                    <td style={{ ...td, textAlign: 'right', fontFamily: T.fontMono, color: T.accent }}>
                                      {fmtPct(s.xceed.pct)}
                                    </td>
                                    <td style={{ ...td, textAlign: 'right', fontFamily: T.fontMono, color: T.success }}>
                                      {s.erp.marks ? fmtPct(s.erp.pct) : '—'}
                                    </td>
                                    <td style={{
                                      ...td,
                                      textAlign: 'right',
                                      fontFamily: T.fontMono,
                                      fontWeight: 700,
                                      color: divergenceColor(s.divergencePct),
                                    }}
                                    >
                                      {s.comparable.marks ? signed(s.divergencePct) : '—'}
                                    </td>
                                    <td style={{ ...td, textAlign: 'right', fontFamily: T.fontMono }}>
                                      {s.mismatches}
                                    </td>
                                    <td style={{ ...td, textAlign: 'right', fontFamily: T.fontMono, color: T.textMuted }}>
                                      {s.comparable.marks}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
