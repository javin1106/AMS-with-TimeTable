import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { theme, styles, cssReset } from './config';
import getEnvironment from '../getenvironment';

const apiUrl = getEnvironment();
const LIVE_API = `${apiUrl}/attendancemodule/scheduler/live-status`;

// ── helpers ──────────────────────────────────────────────────────────────────
function todayStr() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().split('T')[0];
}

function isPeriodPast(slot, date, periods) {
  if (!slot || !date) return false;
  const today = todayStr();
  if (date < today) return true;
  if (date > today) return false;
  const period = (periods || []).find(p => p.periodKey === slot);
  if (!period?.endTime) return false;
  const [h, m] = period.endTime.split(':').map(Number);
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() > h * 60 + m;
}

function Dot({ color, blink }) {
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
      background: color, flexShrink: 0,
      boxShadow: blink ? `0 0 0 2px ${color}30` : 'none',
      animation: blink ? 'lrPulse 1.4s ease-in-out infinite' : 'none',
    }} />
  );
}

function CamChip({ info }) {
  if (!info) return null;
  const { status, total, online } = info;
  const cfg = {
    online:    { color: '#10b981', bg: 'rgba(16,185,129,0.1)',  label: `Camera OK (${online}/${total})` },
    offline:   { color: '#ef4444', bg: 'rgba(239,68,68,0.1)',   label: `Offline (${online}/${total} online)` },
    no_camera: { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)',  label: 'No camera' },
  }[status] || { color: theme.textMuted, bg: theme.border, label: 'Unknown' };
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0,
      padding: '3px 9px', borderRadius: 99, fontSize: 10, fontWeight: 700,
      background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.color}30`,
    }}>
      <Dot color={cfg.color} blink={status === 'online'} />
      {cfg.label}
    </div>
  );
}

function StatusBadge({ label, color }) {
  return (
    <span style={{
      fontSize: 9, fontWeight: 800, padding: '3px 8px', borderRadius: 99,
      background: `${color}18`, color, textTransform: 'uppercase',
      letterSpacing: '.07em', flexShrink: 0, whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

// ── Preflight checklist ──────────────────────────────────────────────────────
// The five conditions the scheduler evaluates before it calls the ML service,
// in the order it evaluates them. The list stops at the first failure — that
// line is the reason attendance is not starting, and its detail names the
// field to fix. Everything after it was never reached, so it is not shown.
function PreflightList({ checks }) {
  if (!checks || checks.length === 0) return null;
  const firstFailIdx = checks.findIndex(c => !c.ok);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4,
      background: theme.bg, borderRadius: 8, padding: '9px 10px',
    }}>
      {checks.map((c, i) => {
        const isBlocker = i === firstFailIdx;
        const color = c.ok ? '#10b981' : isBlocker ? '#ef4444' : theme.textMuted;
        return (
          <div key={c.key} style={{ display: 'flex', gap: 7, alignItems: 'flex-start' }}>
            <span style={{
              fontSize: 11, lineHeight: '15px', color, fontWeight: 800,
              flexShrink: 0, width: 11, textAlign: 'center',
            }}>{c.ok ? '✓' : '✕'}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{
                fontSize: 11, lineHeight: '15px', color: c.ok ? theme.text : color,
                fontWeight: isBlocker ? 700 : 600,
              }}>{c.label}</div>
              {c.detail && (
                <div style={{
                  fontSize: 10, lineHeight: '14px', color: isBlocker ? color : theme.textMuted,
                  wordBreak: 'break-word',
                }}>{c.detail}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Period window ────────────────────────────────────────────────────────────
// Start and end come from the server in campus (IST) minutes, so this agrees
// with the scheduler even when the browser is in another timezone.
function PeriodTiming({ timing }) {
  if (!timing) return null;
  const { state, startTime, endTime, minsToStart, minsToEnd, wouldFireNow, tooLateToStart, runDurationMin } = timing;

  const cfg = {
    upcoming: { color: '#f59e0b', text: `Starts in ${minsToStart} min` },
    live:     { color: '#6366f1', text: `Ends in ${minsToEnd} min` },
    over:     { color: theme.textMuted, text: 'Period over' },
  }[state];

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      background: theme.bg, borderRadius: 8, padding: '8px 12px',
      border: `1px solid ${cfg.color}25`,
    }}>
      <Dot color={cfg.color} blink={state === 'live'} />
      <span style={{ fontSize: 12, fontWeight: 700, color: theme.text, fontFamily: "'IBM Plex Mono',monospace" }}>
        {startTime} – {endTime} IST
      </span>
      <span style={{ fontSize: 11, fontWeight: 700, color: cfg.color }}>{cfg.text}</span>
      {state !== 'over' && (
        <span style={{ fontSize: 10, color: theme.textMuted, marginLeft: 'auto' }}>
          {wouldFireNow
            ? 'Scheduler would fire a run now'
            : tooLateToStart
              ? `Under ${runDurationMin} min left — too late to start a run`
              : 'Waiting for the period to begin'}
        </span>
      )}
    </div>
  );
}

// ── Global gates ─────────────────────────────────────────────────────────────
// When one of these fails, every room is waiting for the same reason, so it is
// shown once above the grid rather than repeated on each card.
function GateBar({ gates }) {
  const failing = (gates || []).filter(g => !g.ok);
  if (failing.length === 0) return null;
  return (
    <div style={{
      background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.25)',
      borderRadius: 10, padding: '10px 14px', marginBottom: 14,
      display: 'flex', flexDirection: 'column', gap: 5,
    }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: '#ef4444', textTransform: 'uppercase', letterSpacing: '.06em' }}>
        No room can run — {failing.length} blocking condition{failing.length > 1 ? 's' : ''}
      </div>
      {failing.map(g => (
        <div key={g.key} style={{ fontSize: 12, color: theme.text }}>
          <strong style={{ fontWeight: 700 }}>{g.label}:</strong>{' '}
          <span style={{ color: theme.textMuted }}>{g.detail}</span>
        </div>
      ))}
    </div>
  );
}

function RunProgress({ completed, target }) {
  const pct = target > 0 ? Math.min(100, (completed / target) * 100) : 0;
  const isDone = completed >= target && target > 0;
  const color = isDone ? '#10b981' : '#6366f1';
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: theme.textMuted, marginBottom: 4 }}>
        <span>Runs completed</span>
        <span style={{ fontWeight: 700, color: isDone ? '#10b981' : theme.text }}>{completed} / {target}</span>
      </div>
      <div style={{ height: 5, background: theme.border, borderRadius: 3, overflow: 'hidden' }}>
        <div style={{
          width: `${pct}%`, height: '100%', background: color, borderRadius: 3,
          transition: 'width .4s ease',
          animation: !isDone && completed > 0 ? 'lrBar 2s ease-in-out infinite' : 'none',
        }} />
      </div>
    </div>
  );
}

function AttendanceCounts({ record }) {
  if (!record) return null;
  const pct = record.attendancePct ?? 0;
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6,
      background: theme.bg, borderRadius: 8, padding: '10px 8px', marginTop: 10,
    }}>
      {[
        { label: 'Present', value: record.present, color: '#10b981' },
        { label: 'Absent',  value: record.absent,  color: '#ef4444' },
        { label: 'Review',  value: record.review,  color: '#f59e0b' },
        { label: 'Attend%', value: `${pct}%`, color: pct >= 75 ? '#10b981' : '#ef4444' },
      ].map(({ label, value, color }) => (
        <div key={label} style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 17, fontWeight: 800, color, fontFamily: "'IBM Plex Mono',monospace", lineHeight: 1.1 }}>
            {value ?? '—'}
          </div>
          <div style={{ fontSize: 9, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '.06em', marginTop: 2 }}>
            {label}
          </div>
        </div>
      ))}
    </div>
  );
}

function RoomCard({ r, onClickReport, pastPeriod }) {
  const isSkipped   = r.status === 'skipped';
  const isPending   = r.status === 'pending';
  const isFinalized = r.status === 'finalized';
  const isDone      = !isFinalized && r.runsCompleted >= r.targetRuns && r.targetRuns > 0;
  // "Running" only makes sense for an ongoing period; past periods with partial runs = "Partial"
  const isRunning   = !pastPeriod && !isSkipped && !isPending && !isDone && !isFinalized && r.runsCompleted > 0;
  const isPartial   = pastPeriod  && !isSkipped && !isPending && !isDone && !isFinalized && r.runsCompleted > 0;
  const hasClass    = !!r.ctx;
  const camStatus   = r.cameraInfo?.status;
  const noCam       = camStatus === 'no_camera';
  const camOffline  = camStatus === 'offline';
  const noRun       = isPending && pastPeriod;  // past period with no data = no run happened

  const accentColor =
    isFinalized              ? '#10b981' :
    isDone                   ? '#10b981' :
    isRunning                ? '#6366f1' :
    isPartial                ? theme.border :
    noRun                    ? theme.border :
    isPending && hasClass && !noCam && !camOffline ? '#f59e0b' :
    noCam || camOffline      ? '#f97316' :
    theme.border;

  const badgeLabel  =
    isFinalized ? 'Finalized' :
    isDone      ? 'Completed' :
    isRunning   ? 'Running'   :
    isPartial   ? 'Partial'   :
    noRun       ? 'No Run'    :
    isPending && hasClass ? 'Waiting' :
    isSkipped   ? 'Skipped'   : 'Pending';

  const badgeColor  =
    isFinalized ? '#10b981' :
    isDone      ? '#10b981' :
    isRunning   ? '#6366f1' :
    isPartial   ? theme.textMuted :
    noRun       ? theme.textMuted :
    isPending && hasClass ? '#f59e0b' :
    theme.textMuted;

  const clickable = !isSkipped && hasClass;

  return (
    <div
      onClick={() => clickable && onClickReport(r)}
      style={{
        background: theme.surface,
        border: `1px solid ${accentColor}25`,
        borderTop: `3px solid ${accentColor}`,
        borderRadius: 12, padding: '16px 18px',
        cursor: clickable ? 'pointer' : 'default',
        display: 'flex', flexDirection: 'column', gap: 10,
        opacity: isSkipped ? 0.7 : 1,
        transition: 'box-shadow .15s',
      }}
    >
      {/* Row 1: room + badge */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 15, color: theme.text, letterSpacing: '-0.01em' }}>{r.room}</div>
          {hasClass && (
            <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 2 }}>
              {r.ctx.dept}{r.ctx.sem ? ` · Sem ${r.ctx.sem}` : ''}
            </div>
          )}
        </div>
        <StatusBadge label={badgeLabel} color={badgeColor} />
      </div>

      {/* Camera chip */}
      <CamChip info={r.cameraInfo} />

      {/* Skip reason */}
      {isSkipped && (
        <>
          <div style={{
            fontSize: 12, color: theme.danger, fontWeight: 600,
            background: 'rgba(239,68,68,0.07)', padding: '6px 10px', borderRadius: 6,
          }}>
            {r.reason || 'Skipped'}
          </div>
          {/* "No Class Scheduled" alone doesn't say whether it's a free
              period or a lookup that missed — the checklist does. */}
          <PreflightList checks={r.preflight} />
        </>
      )}

      {/* Class info + run data */}
      {!isSkipped && hasClass && (
        <>
          <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: theme.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.ctx.subject || '—'}
            </div>
            <div style={{ fontSize: 11, color: theme.textMuted }}>{r.ctx.batch}</div>
            {r.ctx.faculty && (
              <div style={{ fontSize: 11, color: theme.textMuted }}>Faculty: {r.ctx.faculty}</div>
            )}
          </div>

          {(noCam || camOffline) && !pastPeriod && (
            <div style={{
              fontSize: 11, color: '#f97316', fontWeight: 600,
              background: 'rgba(249,115,22,0.08)', padding: '5px 10px', borderRadius: 6,
            }}>
              {noCam ? 'No camera registered — run may fail' : 'Camera offline — run may fail'}
            </div>
          )}

          {isPending ? (
            <div style={{ fontSize: 11, color: theme.textMuted, fontStyle: 'italic' }}>
              {noRun ? 'No attendance recorded for this period.' : 'Waiting for attendance run to start…'}
            </div>
          ) : (
            <RunProgress completed={r.runsCompleted} target={r.targetRuns} />
          )}

          {/* Why it has or hasn't started — always available, expanded by
              default while pending since that is when it is being asked. */}
          {r.preflight?.length > 0 && (
            <details open={isPending}>
              <summary style={{
                fontSize: 10, color: theme.textMuted, cursor: 'pointer',
                textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700,
                marginBottom: 6, userSelect: 'none',
              }}>
                Preflight checks
              </summary>
              <PreflightList checks={r.preflight} />
            </details>
          )}

          <AttendanceCounts record={r.lastRecord} />
        </>
      )}

      {!isSkipped && !hasClass && (
        <div style={{ fontSize: 12, color: theme.textMuted, fontStyle: 'italic' }}>
          No class scheduled for this period
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
export default function LiveReportPage() {
  const navigate = useNavigate();
  const [data,      setData]     = useState(null);
  const [loading,   setLoading]  = useState(true);   // true only on first load / date-slot change
  const [fetching,  setFetching] = useState(false);  // true during any fetch (incl. background poll)
  const [error,     setError]    = useState(null);
  const [lastUpd,   setLastUpd]  = useState(null);
  const [selSlot,   setSelSlot]  = useState(null);  // null = auto-detect
  const [selDate,   setSelDate]  = useState(todayStr());

  const fetchStatus = useCallback(async (slot, date) => {
    setFetching(true);
    try {
      const params = new URLSearchParams({ _t: Date.now() });
      if (slot) params.set('slot', slot);
      if (date) params.set('date', date);
      const res = await fetch(`${LIVE_API}?${params}`, { cache: 'no-store' });
      if (!res.ok) throw new Error((await res.json()).error || 'Fetch failed');
      const json = await res.json();
      setData(json);
      setLastUpd(new Date().toLocaleTimeString());
      setError(null);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
    setFetching(false);
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchStatus(selSlot, selDate);
    const id = setInterval(() => fetchStatus(selSlot, selDate), 15000);
    return () => clearInterval(id);
  }, [selSlot, selDate, fetchStatus]);

  const periods    = (data?.periods || []).filter(p => p.enabled !== false);
  const rooms      = data?.rooms || [];
  const slot       = data?.slot;
  const pastPeriod = isPeriodPast(selSlot || slot, selDate, periods);

  const partialFilter = r =>
    !['skipped','pending','finalized'].includes(r.status) && r.runsCompleted > 0 && r.runsCompleted < r.targetRuns;

  const stats = {
    done:    rooms.filter(r => r.status === 'finalized' || (r.runsCompleted >= r.targetRuns && r.targetRuns > 0)).length,
    running: !pastPeriod ? rooms.filter(partialFilter).length : 0,
    partial: pastPeriod  ? rooms.filter(partialFilter).length : 0,
    noRun:   pastPeriod  ? rooms.filter(r => r.status === 'pending' && !!r.ctx).length : 0,
    waiting: !pastPeriod ? rooms.filter(r => r.status === 'pending' && !!r.ctx).length : 0,
    skipped: rooms.filter(r => r.status === 'skipped').length,
  };

  return (
    <div style={{ ...styles.page, position: 'relative' }}>
      <style dangerouslySetInnerHTML={{ __html: `
        ${cssReset}
        @keyframes lrPulse  { 0%,100%{ opacity:1; } 50%{ opacity:.3; } }
        @keyframes lrBar    { 0%,100%{ opacity:1; } 50%{ opacity:.6; } }
        @keyframes lrFadeUp { from{ opacity:0; transform:translateY(6px); } to{ opacity:1; transform:none; } }
        @keyframes lrSpin   { to{ transform:rotate(360deg); } }
      ` }} />

      {/* ── Header ── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={styles.heading}>Live Attendance Status</div>
            <div style={styles.subheading}>
              Real-time view of all classrooms — camera status, run progress, and attendance counts.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="date"
              value={selDate}
              onChange={e => { setSelDate(e.target.value); setSelSlot(null); }}
              style={{ ...styles.input, width: 'auto', fontSize: 12, padding: '6px 10px' }}
            />
            <span style={{ fontSize: 11, color: theme.textMuted, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 5 }}>
              {fetching && <span style={{ display: 'inline-block', width: 10, height: 10, border: `2px solid ${theme.accent}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'lrSpin .7s linear infinite', flexShrink: 0 }} />}
              {fetching ? 'Refreshing…' : lastUpd ? `Updated ${lastUpd}` : '—'}
            </span>
          </div>
        </div>
      </div>

      {/* ── Banners ── */}
      {data && !data.isWorkingDay && (
        <div style={{
          marginBottom: 14, padding: '12px 18px', borderRadius: 10,
          background: 'rgba(239,68,68,0.07)', border: `1px solid ${theme.danger}35`,
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span style={{ fontSize: 20 }}>⛔</span>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: theme.danger }}>Non-Working Day</div>
            {data.workingDayReason && (
              <div style={{ fontSize: 12, color: theme.danger, opacity: 0.8 }}>
                {data.workingDayReason}
                {data.workingDaySource === 'allotment' ? ' (allotment schedule)' : ''}
              </div>
            )}
          </div>
        </div>
      )}

      {data && !data.acquisitionActive && (
        <div style={{
          marginBottom: 14, padding: '10px 16px', borderRadius: 10,
          background: 'rgba(239,68,68,0.07)', border: `1px solid #ef444435`,
          display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: '#ef4444',
        }}>
          <span style={{ fontWeight: 800 }}>⚠</span>
          Global Acquisition is OFF — no new ML runs will execute.
        </div>
      )}

      {error && (
        <div style={{
          marginBottom: 14, padding: '10px 16px', borderRadius: 10,
          background: theme.dangerDim, color: theme.danger, fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {/* ── Period selector ── */}
      {periods.length > 0 && (
        <div style={{
          marginBottom: 20, padding: '12px 16px', background: theme.surface,
          border: `1px solid ${theme.border}`, borderRadius: 12,
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '.08em', flexShrink: 0 }}>
            Period
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              onClick={() => setSelSlot(null)}
              style={{
                padding: '5px 12px', borderRadius: 99, fontSize: 11, fontWeight: 600,
                cursor: 'pointer', border: `1.5px solid ${!selSlot ? '#6366f1' : theme.border}`,
                background: !selSlot ? 'rgba(99,102,241,0.1)' : 'transparent',
                color: !selSlot ? '#6366f1' : theme.textMuted, transition: 'all .15s',
              }}
            >
              Auto {!selSlot && slot && <span style={{ marginLeft: 4, fontSize: 8, color: '#10b981' }}>●</span>}
            </button>
            {periods.map(p => {
              const isActive  = selSlot === p.periodKey || (!selSlot && slot === p.periodKey);
              const isCurrent = !selSlot && slot === p.periodKey;
              const label = p.startTime
                ? `${p.periodKey.replace('period','P').replace('lunch','Lunch')} ${p.startTime}`
                : p.periodKey.replace('period','P').replace('lunch','Lunch');
              return (
                <button
                  key={p.periodKey}
                  onClick={() => setSelSlot(selSlot === p.periodKey ? null : p.periodKey)}
                  style={{
                    padding: '5px 12px', borderRadius: 99, fontSize: 11, fontWeight: 600,
                    cursor: 'pointer', border: `1.5px solid ${isActive ? '#6366f1' : theme.border}`,
                    background: isActive ? 'rgba(99,102,241,0.1)' : 'transparent',
                    color: isActive ? '#6366f1' : theme.textMuted,
                    transition: 'all .15s', whiteSpace: 'nowrap',
                  }}
                >
                  {label}
                  {isCurrent && <span style={{ marginLeft: 4, fontSize: 8, color: '#10b981' }}>●</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── When this period starts and ends, on the campus clock ── */}
      {data?.timing && (
        <div style={{ marginBottom: 14 }}>
          <PeriodTiming timing={data.timing} />
        </div>
      )}

      {/* ── Conditions that block every room at once ── */}
      <GateBar gates={data?.gates} />

      {/* ── Summary chips ── */}
      {rooms.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap', alignItems: 'center' }}>
          {[
            { label: 'Done',    value: stats.done,    color: '#10b981' },
            ...(pastPeriod
              ? [
                  { label: 'Partial', value: stats.partial, color: theme.textMuted },
                  { label: 'No Run',  value: stats.noRun,   color: theme.textMuted },
                ]
              : [
                  { label: 'Running', value: stats.running, color: '#6366f1' },
                  { label: 'Waiting', value: stats.waiting, color: '#f59e0b' },
                ]),
            { label: 'Skipped', value: stats.skipped, color: theme.textMuted },
          ].map(({ label, value, color }) => (
            <div key={label} style={{
              padding: '5px 12px', borderRadius: 8, background: theme.surface,
              border: `1px solid ${theme.border}`, display: 'flex', alignItems: 'center', gap: 7,
            }}>
              <span style={{ fontSize: 15, fontWeight: 800, color, fontFamily: "'IBM Plex Mono',monospace" }}>{value}</span>
              <span style={{ fontSize: 11, color: theme.textMuted }}>{label}</span>
            </div>
          ))}
          <span style={{ fontSize: 11, color: theme.textMuted, marginLeft: 4 }}>
            {slot ? `${slot} · ${selDate}` : selDate}
          </span>
        </div>
      )}

      {/* ── Empty states ── */}
      {!loading && data && !slot && rooms.length === 0 && (
        <div style={{
          textAlign: 'center', padding: '50px 20px', color: theme.textMuted, fontSize: 14,
          background: theme.surface, borderRadius: 12, border: `1.5px dashed ${theme.border}`,
        }}>
          No active lecture period at this time.
          <div style={{ fontSize: 12, marginTop: 8 }}>Select a specific period above to view its status.</div>
        </div>
      )}

      {loading && rooms.length === 0 && (
        <div style={{ textAlign: 'center', padding: 50, color: theme.textMuted, fontSize: 14 }}>
          Loading…
        </div>
      )}

      {/* ── Room grid ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
        {rooms.map((r, i) => (
          <div key={i} style={{ animation: `lrFadeUp .3s ease ${i * 25}ms both` }}>
            <RoomCard
              r={r}
              pastPeriod={pastPeriod}
              onClickReport={room => navigate('/attendance/reports', {
                state: {
                  reportId:    room.reportId,
                  prefillDate: selDate,
                  prefillSlot: slot,
                  prefillRoom: room.room,
                },
              })}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
