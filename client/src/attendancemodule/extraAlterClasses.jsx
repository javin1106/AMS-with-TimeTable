// client/src/attendancemodule/extraAlterClasses.jsx
//
// Standalone sidebar pages for Extra Classes and Altering Classes.
// These were previously tabs inside SchedulerPage; they now live as their own
// sidebar entries (both on the AMS admin side and the dept-admin side).
//
// Both pages share the same global acquisition-control config and reuse the
// form/modal components exported from SchedulerPage.jsx, so there is a single
// source of truth for the add/edit UI.

import { useState, useEffect, useCallback } from 'react';
import { theme, styles, cssReset } from './config';
import BackButton from './BackButton';
import {
  AC_API,
  CAMERA_API,
  SLOT_LABELS,
  Toast,
  SectionHead,
  ConflictModal,
  ConfirmModal,
  ExtraClassForm,
  AlterClassForm,
} from './SchedulerPage';

// ── Shared data + action layer ──────────────────────────────────────────────
// Holds the acquisition config plus the add/delete handlers for extra classes
// and alterations. Both pages call the same handlers against the same global
// config, matching the previous in-tab behaviour exactly.
function useAcquisitionExtras() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [allRooms, setAllRooms] = useState([]);
  const [confirmDialog, setConfirmDialog] = useState(null); // conflict modal state
  const [deleteTarget, setDeleteTarget] = useState(null); // extra class id pending deletion

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  // Promise-based replacement for window.confirm(); resolves 'cancel' | 'changeRoom' | 'replace'.
  const askConfirm = (message, isRegular) =>
    new Promise((resolve) => setConfirmDialog({ message, isRegular, resolve }));

  const closeConfirm = (choice) => {
    confirmDialog?.resolve(choice);
    setConfirmDialog(null);
  };

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(AC_API);
      const data = await res.json();
      setConfig(data);
    } catch (e) {
      showToast('Failed to load config: ' + e.message, 'error');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // Rooms with cameras — used to seed the extra-class room picker.
  useEffect(() => {
    fetch(CAMERA_API)
      .then((r) => r.json())
      .then((data) => {
        const cams = Array.isArray(data) ? data : [];
        const distinct = [
          ...new Set(cams.map((c) => c.roomId).filter(Boolean)),
        ].sort();
        setAllRooms(distinct);
      })
      .catch(() => setAllRooms([]));
  }, []);

  const postExtraClass = (body) =>
    fetch(`${AC_API}/extra-class`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  // Returns { success } | { changeRoom } so ExtraClassForm knows how much to reset.
  const addExtraClass = async (form) => {
    let res = await postExtraClass(form);
    let data = await res.json();

    if (res.status === 409 && data.conflict) {
      const isRegular = data.type === 'regular_timetable';
      const choice = await askConfirm(
        data.message || 'This slot is already booked.',
        isRegular,
      );

      if (choice === 'cancel') {
        showToast('Extra class not added — slot left unchanged', 'error');
        return { success: false };
      }
      if (choice === 'changeRoom') {
        showToast(
          'Pick a different room for this class — the regular class stays untouched',
          'warning',
        );
        return { changeRoom: true };
      }
      // choice === 'replace' — only path that can displace a regular class.
      // Backend must swap attendance records to the new subject/faculty on this flag.
      res = await postExtraClass({ ...form, confirm: true });
      data = await res.json();
    }

    if (data.error) {
      showToast(data.error, 'error');
      return { success: false };
    }
    setConfig((p) => ({ ...p, extraClasses: data }));
    const replaced = data.find?.((ec) => ec.replacedRegular);
    showToast(
      replaced
        ? `Extra class added for "${form.subject}" — this replaced the regular timetable slot in ${form.room}`
        : `Extra class added for "${form.subject}" in ${form.room}`,
      replaced ? 'warning' : 'success',
    );
    return { success: true };
  };

  const postAlteration = (body) =>
    fetch(`${AC_API}/alteration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const addAlteration = async (form) => {
    let res = await postAlteration(form);
    let data = await res.json();

    if (res.status === 409 && data.conflict) {
      if (
        data.type === 'faculty_regular_busy' ||
        data.type === 'faculty_already_altered'
      ) {
        showToast(data.message, 'error');
        return { success: false };
      }
      // duplicate_slot — same replace-confirm pattern as extra classes
      const choice = await askConfirm(data.message, false);
      if (choice !== 'replace') {
        showToast('Alteration not added', 'error');
        return { success: false };
      }
      res = await postAlteration({ ...form, confirm: true });
      data = await res.json();
    }

    if (data.error) {
      showToast(data.error, 'error');
      return { success: false };
    }
    setConfig((p) => ({ ...p, extraClasses: data }));
    showToast(`${form.faculty} now covering "${form.subject}" — swap saved`);
    return { success: true };
  };

  const deleteExtraClass = (id) => setDeleteTarget(id);

  const confirmDeleteExtraClass = async () => {
    const id = deleteTarget;
    setDeleteTarget(null);
    if (!id) return;
    const res = await fetch(`${AC_API}/extra-class/${id}`, {
      method: 'DELETE',
    });
    const data = await res.json();
    if (data.error) {
      showToast(data.error, 'error');
      return;
    }
    setConfig((p) => ({ ...p, extraClasses: data }));
    showToast('Extra class removed');
  };

  return {
    config,
    loading,
    toast,
    allRooms,
    confirmDialog,
    deleteTarget,
    setDeleteTarget,
    closeConfirm,
    addExtraClass,
    addAlteration,
    deleteExtraClass,
    confirmDeleteExtraClass,
  };
}

// ── Shared page chrome ──────────────────────────────────────────────────────
function PageHeader({ title, sub }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div>
          <div style={{ ...styles.heading, marginBottom: 4 }}>{title}</div>
          <div style={styles.subheading}>{sub}</div>
        </div>
        <BackButton />
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div
      style={{
        ...styles.page,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '60vh',
      }}
    >
      <div style={{ color: theme.textMuted, fontSize: 14 }}>Loading config…</div>
    </div>
  );
}

// ── Extra Classes page ──────────────────────────────────────────────────────
export function ExtraClassPage() {
  const {
    config,
    loading,
    toast,
    allRooms,
    confirmDialog,
    deleteTarget,
    setDeleteTarget,
    closeConfirm,
    addExtraClass,
    deleteExtraClass,
    confirmDeleteExtraClass,
  } = useAcquisitionExtras();

  if (loading) return <Loading />;

  return (
    <div style={styles.page}>
      <style>{cssReset}</style>
      <Toast toast={toast} />
      <ConflictModal
        open={!!confirmDialog}
        message={confirmDialog?.message}
        isRegular={confirmDialog?.isRegular}
        onCancel={() => closeConfirm('cancel')}
        onChangeRoom={() => closeConfirm('changeRoom')}
        onReplace={() => closeConfirm('replace')}
      />
      <ConfirmModal
        open={!!deleteTarget}
        title="Delete this extra class?"
        message="This will permanently remove the scheduled extra class. This action cannot be undone."
        confirmLabel="Delete"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDeleteExtraClass}
      />

      <PageHeader
        title="Extra Classes"
        sub="Schedule extra classes outside the normal timetable."
      />

      <SectionHead
        title="Extra Classes"
        sub="Schedule extra classes outside the normal timetable. Data routes automatically to the correct subject."
        color={theme.warning}
      />
      <div style={{ marginBottom: 20 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: theme.textMuted,
            marginBottom: 10,
          }}
        >
          Add New Extra Class
        </div>
        <ExtraClassForm onAdd={addExtraClass} allRooms={allRooms} />
      </div>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: theme.textMuted,
          marginBottom: 12,
        }}
      >
        Scheduled Extra Classes (
        {(config?.extraClasses || []).filter((e) => e.active).length} active)
      </div>
      {(config?.extraClasses || []).length === 0 ? (
        <div
          style={{
            ...styles.card,
            padding: 40,
            textAlign: 'center',
            color: theme.textMuted,
            borderStyle: 'dashed',
          }}
        >
          No extra classes scheduled yet.
        </div>
      ) : (
        <div style={{ ...styles.card, padding: 0, overflow: 'hidden' }}>
          <table
            style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}
          >
            <thead>
              <tr style={{ borderBottom: `1px solid ${theme.border}` }}>
                {[
                  'Date',
                  'Period',
                  'Room',
                  'Subject',
                  'Faculty',
                  'Sem',
                  'Time',
                  'Type',
                  'Status',
                  '',
                ].map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: '10px 12px',
                      textAlign: 'left',
                      fontSize: 10,
                      color: theme.textMuted,
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                      fontWeight: 600,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(config?.extraClasses || []).map((ec) => (
                <tr
                  key={ec._id}
                  style={{ borderBottom: `1px solid ${theme.border}` }}
                >
                  <td
                    style={{
                      padding: '10px 12px',
                      fontFamily: theme.fontMono,
                      fontSize: 12,
                    }}
                  >
                    {ec.date}
                  </td>
                  <td
                    style={{
                      padding: '10px 12px',
                      fontSize: 12,
                      color: theme.textMuted,
                    }}
                  >
                    {SLOT_LABELS[ec.periodKey] || ec.periodKey}
                  </td>
                  <td style={{ padding: '10px 12px', fontWeight: 700 }}>
                    {ec.room}
                  </td>
                  <td style={{ padding: '10px 12px', color: theme.textMuted }}>
                    {ec.subject || '—'}
                  </td>
                  <td style={{ padding: '10px 12px', color: theme.textMuted }}>
                    {ec.faculty || '—'}
                  </td>
                  <td style={{ padding: '10px 12px', color: theme.textMuted }}>
                    {ec.semester || '—'}
                  </td>
                  <td
                    style={{
                      padding: '10px 12px',
                      fontFamily: theme.fontMono,
                      fontSize: 11,
                    }}
                  >
                    {ec.startTime && ec.endTime
                      ? `${ec.startTime}–${ec.endTime}`
                      : '—'}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: 99,
                        fontSize: 10,
                        fontWeight: 700,
                        background: ec.isLunchHour
                          ? theme.warningDim
                          : theme.accentDim,
                        color: ec.isLunchHour ? theme.warning : theme.accent,
                      }}
                    >
                      {ec.isLunchHour ? '🍱 Special' : 'Extra'}
                    </span>
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: 99,
                        fontSize: 10,
                        fontWeight: 700,
                        background: ec.active
                          ? theme.successDim
                          : theme.dangerDim,
                        color: ec.active ? theme.success : theme.danger,
                      }}
                    >
                      {ec.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <button
                      onClick={() => deleteExtraClass(ec._id)}
                      style={{
                        ...styles.btnDanger,
                        padding: '4px 10px',
                        fontSize: 11,
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Altering Classes page ───────────────────────────────────────────────────
export function AlterClassPage() {
  const {
    config,
    loading,
    toast,
    confirmDialog,
    deleteTarget,
    setDeleteTarget,
    closeConfirm,
    addAlteration,
    deleteExtraClass,
    confirmDeleteExtraClass,
  } = useAcquisitionExtras();

  if (loading) return <Loading />;

  return (
    <div style={styles.page}>
      <style>{cssReset}</style>
      <Toast toast={toast} />
      <ConflictModal
        open={!!confirmDialog}
        message={confirmDialog?.message}
        isRegular={confirmDialog?.isRegular}
        onCancel={() => closeConfirm('cancel')}
        onChangeRoom={() => closeConfirm('changeRoom')}
        onReplace={() => closeConfirm('replace')}
      />
      <ConfirmModal
        open={!!deleteTarget}
        title="Delete this alteration?"
        message="This will permanently remove the scheduled alteration. This action cannot be undone."
        confirmLabel="Delete"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDeleteExtraClass}
      />

      <PageHeader
        title="Altering Classes"
        sub="One-time faculty/subject swap for an already-scheduled class."
      />

      <SectionHead
        title="Altering Classes"
        sub="One-time faculty/subject swap for an already-scheduled class"
        color={theme.warning}
      />
      <div style={{ marginBottom: 20 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: theme.textMuted,
            marginBottom: 10,
          }}
        >
          Add New Alteration
        </div>
        <AlterClassForm onAdd={addAlteration} />
      </div>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: theme.textMuted,
          marginBottom: 12,
        }}
      >
        Active Alterations (
        {
          (config?.extraClasses || []).filter(
            (e) => e.isAlteration && e.active,
          ).length
        }
        )
      </div>
      {(config?.extraClasses || []).filter((e) => e.isAlteration).length ===
      0 ? (
        <div
          style={{
            ...styles.card,
            padding: 40,
            textAlign: 'center',
            color: theme.textMuted,
            borderStyle: 'dashed',
          }}
        >
          No alterations scheduled yet.
        </div>
      ) : (
        <div style={{ ...styles.card, padding: 0, overflow: 'hidden' }}>
          <table
            style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}
          >
            <thead>
              <tr style={{ borderBottom: `1px solid ${theme.border}` }}>
                {[
                  'Date',
                  'Period',
                  'Room',
                  'Original → New Subject',
                  'New Faculty',
                  'Sem',
                  'Status',
                  '',
                ].map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: '10px 12px',
                      textAlign: 'left',
                      fontSize: 10,
                      color: theme.textMuted,
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                      fontWeight: 600,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(config?.extraClasses || [])
                .filter((e) => e.isAlteration)
                .map((ec) => (
                  <tr
                    key={ec._id}
                    style={{ borderBottom: `1px solid ${theme.border}` }}
                  >
                    <td
                      style={{
                        padding: '10px 12px',
                        fontFamily: theme.fontMono,
                        fontSize: 12,
                      }}
                    >
                      {ec.date}
                    </td>
                    <td
                      style={{
                        padding: '10px 12px',
                        fontSize: 12,
                        color: theme.textMuted,
                      }}
                    >
                      {SLOT_LABELS[ec.periodKey] || ec.periodKey}
                    </td>
                    <td style={{ padding: '10px 12px', fontWeight: 700 }}>
                      {ec.room}
                    </td>
                    <td style={{ padding: '10px 12px', color: theme.textMuted }}>
                      {ec.originalSubject || '—'} → {ec.subject}
                    </td>
                    <td style={{ padding: '10px 12px' }}>{ec.faculty}</td>
                    <td style={{ padding: '10px 12px', color: theme.textMuted }}>
                      {ec.semester || '—'}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <span
                        style={{
                          padding: '2px 8px',
                          borderRadius: 99,
                          fontSize: 10,
                          fontWeight: 700,
                          background: ec.active
                            ? theme.successDim
                            : theme.dangerDim,
                          color: ec.active ? theme.success : theme.danger,
                        }}
                      >
                        {ec.active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <button
                        onClick={() => deleteExtraClass(ec._id)}
                        style={{
                          ...styles.btnDanger,
                          padding: '4px 10px',
                          fontSize: 11,
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
