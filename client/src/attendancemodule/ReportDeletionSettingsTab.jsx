import { useEffect, useState } from 'react';
import getEnvironment from '../getenvironment';
import { theme as T } from './config';

const SETTINGS_API = `${getEnvironment()}/attendancemodule/settings/report-deletion`;

export default function ReportDeletionSettingsTab() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(SETTINGS_API, {
      credentials: 'include',
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to load setting');
        setEnabled(data.enabled === true);
      })
      .catch((error) => {
        if (error.name !== 'AbortError') {
          setMessage({ type: 'error', text: error.message });
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const toggle = async () => {
    const nextEnabled = !enabled;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(SETTINGS_API, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to update setting');
      setEnabled(data.enabled === true);
      setMessage({
        type: 'success',
        text: nextEnabled
          ? 'Saved-report deletion is now available to department administrators.'
          : 'Saved-report deletion is no longer available to department administrators.',
      });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: 20 }}>
      <div
        style={{
          background: T.surface,
          border: `1px solid ${enabled ? '#fecaca' : T.border}`,
          borderRadius: 12,
          padding: 20,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 20,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: '1 1 420px' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 6 }}>
            Saved Attendance Report Deletion
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.6, color: T.textMuted }}>
            Admin and iams-admin users can always delete saved reports. As an
            iams-admin, enable this control to also allow iams-dept-admin users
            to delete reports and linked unknown-face records from their own department.
          </div>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={loading || saving}
          onClick={toggle}
          style={{
            border: 0,
            borderRadius: 999,
            padding: '9px 16px',
            minWidth: 110,
            cursor: loading || saving ? 'not-allowed' : 'pointer',
            background: enabled ? '#dc2626' : '#e5e7eb',
            color: enabled ? '#fff' : T.textMuted,
            fontSize: 12,
            fontWeight: 700,
            opacity: loading || saving ? 0.65 : 1,
          }}
        >
          {loading ? 'Loading…' : saving ? 'Saving…' : enabled ? 'Enabled' : 'Disabled'}
        </button>
      </div>

      {message && (
        <div
          style={{
            marginTop: 12,
            padding: '10px 12px',
            borderRadius: 8,
            fontSize: 12,
            color: message.type === 'error' ? '#b91c1c' : '#047857',
            background: message.type === 'error' ? '#fef2f2' : '#ecfdf5',
          }}
        >
          {message.text}
        </div>
      )}
    </div>
  );
}
