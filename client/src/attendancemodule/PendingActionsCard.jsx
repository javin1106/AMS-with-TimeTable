// client/src/attendancemodule/PendingActionsCard.jsx
// "Pending actions" summary card, shared by the department dashboard and the
// admin dashboard.
//
// Previously showed two raw counts (ground-truth pending, attendance
// verification pending) sourced from GET /attendancemodule/dept-admin/stats/today
// — the ground-truth number in particular wasn't clear about what it meant.
// Now shows three roll-number-centric numbers, aggregated across every
// batch (all semesters) in the branch, sourced directly from the same
// summary table the Roll Assignment → Summary tab uses
// (GET /attendancemodule/roll-assign/summary):
//   • Approved roll numbers   — sum of `approved` across all batches
//   • Unprocessed roll numbers — sum of `unclustered` (ERP photos on file
//     that haven't been through acquisition/clustering at all yet)
//   • Pending approval        — sum of `pending` (matched, awaiting review)
// Clicking any tile goes to the Roll Assignment Summary tab for full detail.

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { theme, styles } from './config';
import getEnvironment from '../getenvironment';

const apiUrl = getEnvironment();
const SUMMARY_URL = `${apiUrl}/attendancemodule/roll-assign/summary`;
const STATS_URL   = `${apiUrl}/attendancemodule/dept-admin/stats/today`;
const SUMMARY_LINK = '/attendance/groundtruth/assign?tab=summary';

function PendingTile({ label, value, detail, to, color }) {
  return (
    <Link
      to={to}
      style={{
        ...styles.card, padding: 16, textDecoration: 'none', color: theme.text,
        display: 'flex', flexDirection: 'column', gap: 6, borderLeft: `3px solid ${color}`,
      }}
    >
      <div style={{ fontSize: 10, fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.03em', color: value ? color : theme.textMuted }}>
        {value == null ? '—' : value}
      </div>
      <div style={{ fontSize: 11, color: theme.accent, fontWeight: 600 }}>{detail} →</div>
    </Link>
  );
}

export default function PendingActionsCard() {
  const [rollStats, setRollStats] = useState(null); // { approved, unclustered, pending }
  const [attendanceVerificationPending, setAttendanceVerificationPending] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [department, setDepartment] = useState('');
  const [fullAccess, setFullAccess] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      // Attendance-verification count still comes from dept-admin stats
      // (unrelated to roll assignment) — also tells us fullAccess/dept scope.
      const statsParams = department ? `?department=${encodeURIComponent(department)}` : '';
      const statsRes = await fetch(`${STATS_URL}${statsParams}`, { credentials: 'include' });
      const statsData = await statsRes.json();
      if (!statsRes.ok) throw new Error(statsData.message || 'Failed to load pending actions.');
      setAttendanceVerificationPending(statsData.attendanceVerificationPending);
      setFullAccess(Boolean(statsData.fullAccess));

      // Roll-number stats — aggregated across every batch (all semesters)
      // returned for this branch by the same table the Summary tab uses.
      const summaryParams = (statsData.fullAccess && department) ? `?department=${encodeURIComponent(department)}` : '';
      const summaryRes = await fetch(`${SUMMARY_URL}${summaryParams}`, { credentials: 'include' });
      const summaryData = await summaryRes.json();
      if (!summaryRes.ok) throw new Error(summaryData.error || 'Failed to load roll assignment summary.');
      const batches = summaryData.batches || [];
      const totals = batches.reduce((acc, b) => ({
        approved:    acc.approved    + (b.approved    || 0),
        unclustered: acc.unclustered + (b.unclustered || 0),
        pending:     acc.pending     + (b.pending      || 0),
      }), { approved: 0, unclustered: 0, pending: 0 });
      setRollStats(totals);
    } catch (err) {
      setError(err.message);
    }
  }, [department]);

  useEffect(() => { load(); }, [load]);

  // Department options for the admin selector.
  useEffect(() => {
    if (!fullAccess) return;
    (async () => {
      try {
        const res = await fetch(`${apiUrl}/attendancemodule/ground-truth/departments`, { credentials: 'include' });
        const data = await res.json();
        if (res.ok) setDepartments((data.departments || []).map((d) => d.dept).filter(Boolean));
      } catch (_) { /* selector stays empty */ }
    })();
  }, [fullAccess]);

  return (
    <section style={{ ...styles.card, padding: 18, marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>Pending actions</div>
        {fullAccess && (
          <select
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: 8, border: `1px solid ${theme.border}`, fontFamily: theme.fontBody }}
          >
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        )}
      </div>

      {error ? (
        <div style={{ color: theme.danger, fontSize: 13 }}>{error}</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <PendingTile
            label="Approved roll numbers"
            value={rollStats?.approved}
            detail="View summary"
            to={SUMMARY_LINK}
            color={theme.success}
          />
          <PendingTile
            label="Unprocessed roll numbers"
            value={rollStats?.unclustered}
            detail="View summary"
            to={SUMMARY_LINK}
            color="#ef4444"
          />
          <PendingTile
            label="Pending approval"
            value={rollStats?.pending}
            detail="View summary"
            to={SUMMARY_LINK}
            color="#f59e0b"
          />
          <PendingTile
            label="Attendance verifications pending"
            value={attendanceVerificationPending}
            detail="Verify ERP overrides"
            to="/attendance/erp-overrides"
            color={theme.accent}
          />
        </div>
      )}
    </section>
  );
}