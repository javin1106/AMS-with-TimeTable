// client/src/attendancemodule/SchedulerLedgerPage.jsx
//
// "What happened in each period?" — the scheduler's own account of a day.
//
// Every acquisition run narrates itself as it goes (timetable context, subject
// roster, embeddings, camera resolution, the enrollment gate, the run plan,
// each check, the faculty mail). That trail used to exist only as console
// output on the server, so the moment a period went wrong the explanation was
// already gone. It is now persisted per attempt in the SchedulerLedger, and
// this page reads it back.
//
// The important cases this is meant to answer:
//   • a period produced no report at all — was it skipped, and why?
//   • a period produced fewer checks than configured — what stopped it?
//   • a run was interrupted by a crash or deploy — was it resumed, by whom?
//   • a room ran twice — was the second one a manual trigger?

import { useState, useEffect, useCallback, useMemo } from 'react';
import { theme, styles, cssReset, formatSlotLabel } from './config';
import BackButton from './BackButton';
import { usePeriods } from './usePeriods';
import getEnvironment from '../getenvironment';

const apiUrl = getEnvironment();
const SCHEDULER_API = `${apiUrl}/attendancemodule/scheduler`;

// ── Presentation of outcomes ─────────────────────────────────────────────────
// 'running' is deliberately distinct from 'done': a row that still says running
// long after its period ended is itself the finding — that is a process that
// died without closing its attempt.
const STATUS_META = {
    done:        { label: 'Completed',   color: theme.success, dim: theme.successDim },
    running:     { label: 'Running',     color: theme.accent,  dim: theme.accentDim },
    skipped:     { label: 'Skipped',     color: theme.warning, dim: theme.warningDim },
    error:       { label: 'Failed',      color: theme.danger,  dim: theme.dangerDim },
    interrupted: { label: 'Interrupted', color: theme.danger,  dim: theme.dangerDim },
};

const CLAIM_META = {
    claimed:     { label: 'Claimed / in flight', color: theme.accent },
    done:        { label: 'Closed for the day',  color: theme.success },
    interrupted: { label: 'Abandoned',           color: theme.danger },
};

const TRIGGER_META = {
    cron:   { label: 'Scheduled', title: 'Started by the minute cron at its period window' },
    resume: { label: 'Resumed',   title: 'Took over a period abandoned by a process that died' },
    manual: { label: 'Manual',    title: 'Started by an operator from the Attendance Live page' },
};

const fmtTime = (iso) =>
    iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function Pill({ meta, children, title }) {
    return (
        <span
            title={title}
            style={{
                display: 'inline-block',
                padding: '3px 10px',
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 0.3,
                whiteSpace: 'nowrap',
                color: meta?.color || theme.textMuted,
                background: meta?.dim || theme.surfaceAlt,
                border: `1px solid ${meta?.color || theme.border}33`,
            }}
        >
            {children ?? meta?.label ?? '—'}
        </span>
    );
}

// ── One attempt's step trail ─────────────────────────────────────────────────
// Rendered as a monospaced timeline because that is what it is: an ordered
// account of decisions, each with the time it was made. Warn steps carry the
// reasons a run skipped or failed, so they are the ones worth finding fast.
function StepTrail({ steps }) {
    if (!steps?.length) {
        return (
            <div style={{ fontSize: 12, color: theme.textMuted, fontStyle: 'italic', padding: '8px 0' }}>
                No steps recorded — this attempt did not get far enough to write any.
            </div>
        );
    }
    return (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {steps.map((s, i) => (
                <li
                    key={i}
                    style={{
                        display: 'flex',
                        gap: 12,
                        padding: '5px 10px',
                        borderLeft: `3px solid ${s.warn ? theme.warning : theme.border}`,
                        background: s.warn ? theme.warningDim : 'transparent',
                        fontFamily: theme.fontMono,
                        fontSize: 12,
                        lineHeight: 1.5,
                    }}
                >
                    <span style={{ color: theme.textMuted, flexShrink: 0 }}>{fmtTime(s.at)}</span>
                    <span style={{ color: s.warn ? theme.text : theme.textMuted, wordBreak: 'break-word' }}>
                        {s.msg}
                    </span>
                </li>
            ))}
        </ol>
    );
}

function AttemptCard({ attempt, index }) {
    const meta = STATUS_META[attempt.status] || STATUS_META.running;
    const trigger = TRIGGER_META[attempt.trigger] || TRIGGER_META.cron;
    const s = attempt.summary || {};
    const hasSummary = s.present != null || s.absent != null;

    return (
        <div
            style={{
                border: `1px solid ${theme.border}`,
                borderRadius: 10,
                overflow: 'hidden',
                marginBottom: 10,
            }}
        >
            <div
                style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 14px',
                    background: theme.surfaceAlt,
                }}
            >
                <span style={{ fontWeight: 700, fontSize: 13 }}>Attempt {index + 1}</span>
                <Pill meta={meta} />
                <Pill title={trigger.title}>{trigger.label}</Pill>
                <span style={{ fontSize: 12, color: theme.textMuted }}>
                    {fmtTime(attempt.startedAt)} → {fmtTime(attempt.finishedAt)}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 12, color: theme.textMuted }}>
                    {attempt.runsCompleted ?? 0}/{attempt.targetRuns ?? 0} checks
                    {attempt.startedAtCheck > 1 && (
                        <span style={{ color: theme.warning, fontWeight: 600 }}>
                            {' '}· picked up at check {attempt.startedAtCheck}
                        </span>
                    )}
                </span>
            </div>

            <div style={{ padding: '10px 14px' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, fontSize: 12, marginBottom: 8 }}>
                    {attempt.batch && (
                        <span><b style={{ color: theme.textMuted }}>Class:</b> {attempt.batch}</span>
                    )}
                    {attempt.subject && (
                        <span><b style={{ color: theme.textMuted }}>Subject:</b> {attempt.subject}</span>
                    )}
                    {attempt.faculty && (
                        <span><b style={{ color: theme.textMuted }}>Faculty:</b> {attempt.faculty}</span>
                    )}
                    {hasSummary && (
                        <span>
                            <b style={{ color: theme.textMuted }}>Result:</b>{' '}
                            <span style={{ color: theme.success }}>P:{s.present ?? 0}</span>{' '}
                            <span style={{ color: theme.danger }}>A:{s.absent ?? 0}</span>{' '}
                            <span style={{ color: theme.warning }}>R:{s.review ?? 0}</span>
                        </span>
                    )}
                </div>

                {attempt.reason && (
                    <div
                        style={{
                            padding: '8px 12px',
                            borderRadius: 8,
                            background: meta.dim,
                            border: `1px solid ${meta.color}33`,
                            fontSize: 12,
                            marginBottom: 10,
                        }}
                    >
                        <b>Outcome:</b> {attempt.reason}
                    </div>
                )}

                <div style={{ fontSize: 11, fontWeight: 700, color: theme.textMuted, marginBottom: 4 }}>
                    PRE-FLIGHT CHECKS &amp; RUN TRAIL
                </div>
                <StepTrail steps={attempt.steps} />
            </div>
        </div>
    );
}

// ── One ledger row: a period+room (or a period-wide task) ────────────────────
function LedgerRow({ row, periods, expanded, onToggle }) {
    const attempts = row.attempts || [];
    const last = attempts[attempts.length - 1];
    const meta = STATUS_META[last?.status] || (attempts.length ? STATUS_META.running : null);
    const claim = CLAIM_META[row.state];
    const isBunk = row.task === 'bunkCheck';

    return (
        <div
            style={{
                border: `1px solid ${theme.border}`,
                borderRadius: 12,
                marginBottom: 10,
                background: theme.surface,
                overflow: 'hidden',
            }}
        >
            <button
                onClick={onToggle}
                style={{
                    width: '100%',
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 12,
                    padding: '14px 16px',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: theme.fontBody,
                    color: theme.text,
                }}
            >
                <span style={{ color: theme.textMuted, fontSize: 12, width: 14 }}>
                    {expanded ? '▾' : '▸'}
                </span>

                <span style={{ fontWeight: 700, fontSize: 14, minWidth: 170 }}>
                    {formatSlotLabel(row.periodKey, periods)}
                </span>

                <span
                    style={{
                        fontFamily: theme.fontMono,
                        fontSize: 13,
                        fontWeight: 600,
                        color: isBunk ? theme.textMuted : theme.accent,
                        minWidth: 90,
                    }}
                >
                    {isBunk ? 'all rooms' : row.room}
                </span>

                {isBunk ? (
                    <Pill>Missed-class check</Pill>
                ) : row.task === 'manualRun' ? (
                    <Pill meta={TRIGGER_META.manual}>Manual run</Pill>
                ) : null}

                {meta && <Pill meta={meta} />}
                {claim && (
                    <Pill title="State of this period's claim — what stops it being run twice">
                        {claim.label}
                    </Pill>
                )}
                {row.resumedCount > 0 && (
                    <Pill
                        meta={STATUS_META.interrupted}
                        title="A previous holder of this period died and it was taken over"
                    >
                        Taken over ×{row.resumedCount}
                    </Pill>
                )}

                <span style={{ marginLeft: 'auto', fontSize: 12, color: theme.textMuted }}>
                    {!isBunk && `${row.checksSaved ?? 0}/${row.targetRuns ?? 0} checks · `}
                    {attempts.length} attempt{attempts.length === 1 ? '' : 's'}
                </span>
            </button>

            {expanded && (
                <div style={{ padding: '0 16px 14px', borderTop: `1px solid ${theme.border}` }}>
                    <div
                        style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: 18,
                            fontSize: 12,
                            color: theme.textMuted,
                            padding: '10px 0',
                        }}
                    >
                        <span><b>Claimed:</b> {fmtTime(row.claimedAt)}</span>
                        <span><b>Last heartbeat:</b> {fmtTime(row.heartbeatAt)}</span>
                        <span><b>Finished:</b> {fmtTime(row.finishedAt)}</span>
                        {/* Which process held it. Two different owners across attempts is
                            the visible signature of a restart mid-period. */}
                        <span style={{ fontFamily: theme.fontMono }}><b>Owner:</b> {row.owner || '—'}</span>
                    </div>

                    {row.lastError && (
                        <div
                            style={{
                                padding: '8px 12px',
                                borderRadius: 8,
                                background: theme.dangerDim,
                                border: `1px solid ${theme.danger}33`,
                                fontSize: 12,
                                marginBottom: 12,
                            }}
                        >
                            <b>Last error:</b> {row.lastError}
                        </div>
                    )}

                    {attempts.length === 0 ? (
                        <div style={{ fontSize: 12, color: theme.textMuted, fontStyle: 'italic' }}>
                            Claimed, but no attempt was ever recorded — the process died between
                            taking the period and starting the run.
                        </div>
                    ) : (
                        attempts.map((a, i) => <AttemptCard key={i} attempt={a} index={i} />)
                    )}
                </div>
            )}
        </div>
    );
}

export default function SchedulerLedgerPage() {
    const [date, setDate] = useState(todayStr());
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [expanded, setExpanded] = useState(() => new Set());
    const [onlyProblems, setOnlyProblems] = useState(false);
    const [autoRefresh, setAutoRefresh] = useState(true);

    const { periods } = usePeriods();

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            // full=1 — the steps ARE the page; there is no point fetching a
            // summary and then a second request for every row the operator
            // opens, and a day's trail is a few hundred short strings.
            const res = await fetch(`${SCHEDULER_API}/ledger?date=${date}&full=1`, {
                credentials: 'include',
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || `Server error ${res.status}`);
            setData(body);
        } catch (e) {
            setError(e.message);
            setData(null);
        }
        setLoading(false);
    }, [date]);

    useEffect(() => { load(); }, [load]);

    // Only while looking at today: a past day cannot change, and polling it
    // would be a request a minute for a fixed answer.
    useEffect(() => {
        if (!autoRefresh || date !== todayStr()) return undefined;
        const id = setInterval(load, 30000);
        return () => clearInterval(id);
    }, [autoRefresh, date, load]);

    const rows = useMemo(() => {
        const all = data?.rows || [];
        if (!onlyProblems) return all;
        return all.filter((r) => {
            if (r.state === 'interrupted' || r.lastError) return true;
            if ((r.attempts || []).some((a) => ['error', 'skipped', 'interrupted'].includes(a.status)))
                return true;
            // Ran, but not as many checks as it was supposed to.
            return r.task === 'run' && r.targetRuns > 0 && (r.checksSaved ?? 0) < r.targetRuns;
        });
    }, [data, onlyProblems]);

    const stats = useMemo(() => {
        const all = (data?.rows || []).filter((r) => r.task !== 'bunkCheck');
        const done = all.filter((r) => (r.attempts || []).some((a) => a.status === 'done')).length;
        const skipped = all.filter(
            (r) => (r.attempts || []).length > 0 && (r.attempts || []).every((a) => a.status === 'skipped'),
        ).length;
        const failed = all.filter((r) =>
            (r.attempts || []).some((a) => a.status === 'error' || a.status === 'interrupted'),
        ).length;
        const partial = all.filter(
            (r) => r.targetRuns > 0 && (r.checksSaved ?? 0) > 0 && (r.checksSaved ?? 0) < r.targetRuns,
        ).length;
        return { total: all.length, done, skipped, failed, partial };
    }, [data]);

    const toggle = (key) =>
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });

    const expandAll = () =>
        setExpanded(new Set(rows.map((r) => `${r.periodKey}_${r.room}_${r.task}`)));

    return (
        <div style={styles.page}>
            <style>{cssReset}</style>

            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6, flexWrap: 'wrap' }}>
                <BackButton />
                <h1 style={{ ...styles.heading, margin: 0 }}>Scheduler Ledger</h1>
            </div>
            <p style={{ ...styles.subheading, marginTop: 0, maxWidth: 780 }}>
                What the attendance scheduler did, period by period and room by room — every
                pre-flight check it made, every reason it skipped, and every run it could not
                finish. A period missing from this list was never claimed at all, which usually
                means the server was not running when it was due.
            </p>

            {/* ── Controls ── */}
            <div
                style={{
                    ...styles.card,
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'flex-end',
                    gap: 16,
                    padding: 18,
                    marginBottom: 16,
                }}
            >
                <div>
                    <div style={styles.label}>Date</div>
                    <input
                        type="date"
                        value={date}
                        max={todayStr()}
                        onChange={(e) => setDate(e.target.value)}
                        style={{ ...styles.input, width: 180 }}
                    />
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                    <input
                        type="checkbox"
                        checked={onlyProblems}
                        onChange={(e) => setOnlyProblems(e.target.checked)}
                    />
                    Only show problems
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                    <input
                        type="checkbox"
                        checked={autoRefresh}
                        onChange={(e) => setAutoRefresh(e.target.checked)}
                        disabled={date !== todayStr()}
                    />
                    Auto-refresh {date !== todayStr() && '(today only)'}
                </label>

                <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
                    <button onClick={expandAll} style={styles.btnGhost}>Expand all</button>
                    <button onClick={() => setExpanded(new Set())} style={styles.btnGhost}>Collapse all</button>
                    <button onClick={load} style={styles.btnPrimary} disabled={loading}>
                        {loading ? 'Loading…' : 'Refresh'}
                    </button>
                </div>
            </div>

            {/* ── Day at a glance ── */}
            {data && (
                <div
                    style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                        gap: 12,
                        marginBottom: 16,
                    }}
                >
                    {[
                        { label: 'Room-periods', value: stats.total, color: theme.text },
                        { label: 'Completed', value: stats.done, color: theme.success },
                        { label: 'Partial', value: stats.partial, color: theme.warning },
                        { label: 'Skipped', value: stats.skipped, color: theme.warning },
                        { label: 'Failed / interrupted', value: stats.failed, color: theme.danger },
                    ].map((s) => (
                        <div key={s.label} style={{ ...styles.card, padding: 16 }}>
                            <div style={{ fontSize: 26, fontWeight: 800, color: s.color }}>{s.value}</div>
                            <div style={{ fontSize: 12, color: theme.textMuted, fontWeight: 600 }}>{s.label}</div>
                        </div>
                    ))}
                </div>
            )}

            {error && (
                <div
                    style={{
                        ...styles.card,
                        borderColor: theme.danger,
                        background: theme.dangerDim,
                        marginBottom: 16,
                    }}
                >
                    Could not load the ledger: {error}
                </div>
            )}

            {!loading && data && rows.length === 0 && (
                <div style={{ ...styles.card, textAlign: 'center', padding: 40 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>
                        {onlyProblems ? 'No problems recorded for this day.' : 'Nothing recorded for this day.'}
                    </div>
                    <div style={{ fontSize: 13, color: theme.textMuted, maxWidth: 560, margin: '0 auto' }}>
                        {onlyProblems
                            ? 'Every claimed period ran all of its configured checks.'
                            : (data.periods || []).length === 0
                                ? 'No periods are configured in Acquisition Control, so the scheduler had nothing to fire.'
                                : 'The scheduler never claimed a period on this date — acquisition was switched off, ' +
                                  'the day was a holiday or stopped day, or the server was not running.'}
                    </div>
                </div>
            )}

            {rows.map((r) => {
                const key = `${r.periodKey}_${r.room}_${r.task}`;
                return (
                    <LedgerRow
                        key={key}
                        row={r}
                        periods={periods}
                        expanded={expanded.has(key)}
                        onToggle={() => toggle(key)}
                    />
                );
            })}
        </div>
    );
}
