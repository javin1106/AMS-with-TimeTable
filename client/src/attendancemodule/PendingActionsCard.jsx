// client/src/attendancemodule/PendingActionsCard.jsx
// "Pending actions" summary card, shared by the department dashboard and the
// admin dashboard.
// Dependent filters:
// - Dept Admin: Auto-selected department badge, Batch selector is directly active.
// - Super Admin: Select Department first -> Unlocks filtered Batches side-by-side.
// Shows outstanding-work counts sourced from
// GET /attendancemodule/dept-admin/stats/today:
//   • Approved roll numbers   — sum of `approved` across batches (stats.groundTruthApproved)[cite: 5]
//   • Pending review          — clusters awaiting incharge review (stats.groundTruthPending)[cite: 5]
//   • Yet to be acquired      — ERP students with no ground truth captured (stats.pendingAcquisition)[cite: 5]
//   • Attendance verifications pending — overrides awaiting coordinator verification (stats.attendanceVerificationPending)[cite: 5]

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { theme, styles } from './config';
import getEnvironment from '../getenvironment';

const apiUrl = getEnvironment();
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
  const [stats, setStats] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [allSummaryBatches, setAllSummaryBatches] = useState([]);
  const [department, setDepartment] = useState('');
  const [batch, setBatch] = useState('');
  const [fullAccess, setFullAccess] = useState(false);
  const [error, setError] = useState('');

  // Fetch pending actions stats from API supporting department and batch query parameters
  const load = useCallback(async () => {
    setError('');
    try {
      const queryParams = new URLSearchParams();
      if (department) queryParams.append('department', department);
      if (batch) queryParams.append('batch', batch);

      const queryString = queryParams.toString() ? `?${queryParams.toString()}` : '';
      const res = await fetch(`${apiUrl}/attendancemodule/dept-admin/stats/today${queryString}`, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to load pending actions.');
      
      setStats(data);
      setFullAccess(Boolean(data.fullAccess));

      // Dept Admin Login: Auto-set department if not full access
      if (!data.fullAccess && data.department && data.department !== 'Institute') {
        setDepartment(data.department);
      }
    } catch (err) {
      setError(err.message);
    }
  }, [department, batch]);

  useEffect(() => { load(); }, [load]);

  // Load department list for full-access admin[cite: 5, 6]
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

  // Load all available batches once from summary[cite: 6]
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${apiUrl}/attendancemodule/roll-assign/summary`, { credentials: 'include' });
        const data = await res.json();
        if (res.ok) {
          setAllSummaryBatches((data.batches || []).map((b) => b.batch));
        }
      } catch (_) {}
    })();
  }, []);

  // Active department used to filter the batch list[cite: 6]
  const activeDept = fullAccess ? department : (stats?.department || department);

  // Filter batches dependent on active department[cite: 6]
  const filteredBatches = allSummaryBatches.filter((b) => {
    if (!activeDept || activeDept === 'Institute') return false;
    const deptNorm = activeDept.replace(/[\s_-]+/g, '').toUpperCase();
    const batchNorm = b.replace(/[\s_-]+/g, '').toUpperCase();
    return batchNorm.includes(deptNorm);
  });

  // Handle department selection change for Admin[cite: 6]
  const handleDepartmentChange = (e) => {
    const selectedDept = e.target.value;
    setDepartment(selectedDept);
    setBatch(''); // Reset batch selection when department changes[cite: 6]
  };

  return (
    <section style={{ ...styles.card, padding: 18, marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>Pending actions</div>
        
        {/* Strictly Side-by-Side Dependent Filters */}
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'nowrap' }}>
          
          {/* Step 1: Department Selector */}
          {fullAccess ? (
            <select
              value={department}
              onChange={handleDepartmentChange}
              style={{ padding: '7px 12px', borderRadius: 8, border: `1px solid ${theme.border}`, fontFamily: theme.fontBody, fontSize: '13px' }}
            >
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          ) : (
            stats?.department && stats.department !== 'Institute' && (
              <div
                style={{
                  padding: '7px 12px',
                  borderRadius: 8,
                  border: `1px solid ${theme.border}`,
                  background: theme.bg || '#f3f4f6',
                  fontFamily: theme.fontBody,
                  fontSize: '13px',
                  fontWeight: 600,
                  color: theme.text
                }}
              >
                Dept: {stats.department.replace(/_/g, ' ')}
              </div>
            )
          )}

          {/* Step 2: Batch Selector (Cascading / Dependent) */}
          <select
            value={batch}
            onChange={(e) => setBatch(e.target.value)}
            disabled={fullAccess && !department}
            style={{
              padding: '7px 12px',
              borderRadius: 8,
              border: `1px solid ${theme.border}`,
              fontFamily: theme.fontBody,
              fontSize: '13px',
              opacity: (fullAccess && !department) ? 0.6 : 1,
              cursor: (fullAccess && !department) ? 'not-allowed' : 'pointer'
            }}
          >
            <option value="">
              {(fullAccess && !department) ? 'Select Dept First' : 'All Batches (Dept Total)'}
            </option>
            {(fullAccess && department ? filteredBatches : (fullAccess ? [] : (activeDept ? filteredBatches : allSummaryBatches))).map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>

        </div>
      </div>

      {error ? (
        <div style={{ color: theme.danger, fontSize: 13 }}>{error}</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <PendingTile
            label="Approved"
            value={stats?.groundTruthApproved}
            detail="View summary"
            to={SUMMARY_LINK}
            color={theme.success}
          />
          <PendingTile
            label="Pending review"
            value={stats?.groundTruthPending}
            detail="Review acquisitions"
            to={SUMMARY_LINK}
            color={theme.warning}
          />
          <PendingTile
            label="Yet to be acquired"
            value={stats?.pendingAcquisition}
            detail="Capture ground truth"
            to="/attendance/groundtruth/rtsp"
            color={theme.danger}
          />
          <PendingTile
            label="Attendance verifications pending"
            value={stats?.attendanceVerificationPending}
            detail="Verify ERP overrides"
            to="/attendance/erp-overrides"
            color={theme.accent}
          />
        </div>
      )}
    </section>
  );
}