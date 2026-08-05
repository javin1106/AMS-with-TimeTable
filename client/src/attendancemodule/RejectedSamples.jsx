import { useState, useEffect, useCallback } from 'react';
import { theme, styles, cssReset } from './config';
import getEnvironment from '../getenvironment';

const BASE = `${getEnvironment()}/api/v1/ml/rejected-samples`;

export default function RejectedSamples() {
    const [summary,       setSummary]       = useState([]);
    const [loadingSummary, setLoadingSummary] = useState(false);
    const [error,         setError]         = useState('');

    const [modalPeriod,   setModalPeriod]   = useState(null); // periodKey, 'all', or null
    const [modalSamples,  setModalSamples]  = useState([]);
    const [loadingModal,  setLoadingModal]  = useState(false);

    const [lightbox,      setLightbox]      = useState(null);

    const loadSummary = useCallback(async () => {
        setLoadingSummary(true);
        setError('');
        try {
            const res  = await fetch(`${BASE}/summary`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to load summary');
            setSummary(Array.isArray(data) ? data : []);
        } catch (err) {
            setError(err.message || 'Failed to load summary');
            setSummary([]);
        }
        setLoadingSummary(false);
    }, []);

    useEffect(() => { loadSummary(); }, [loadSummary]);

    const openPeriod = async (periodKey) => {
        setModalPeriod(periodKey);
        setLoadingModal(true);
        setModalSamples([]);
        try {
            const res  = await fetch(`${BASE}/${encodeURIComponent(periodKey)}/samples`);
            const data = await res.json();
            setModalSamples(Array.isArray(data) ? data : []);
        } catch {
            setModalSamples([]);
        }
        setLoadingModal(false);
    };

    const closeModal = () => {
        setModalPeriod(null);
        setModalSamples([]);
    };

    const totalRejected = summary.reduce((sum, row) => sum + row.count, 0);

    return (
        <div style={{ marginTop: 16 }}>
            <style>{cssReset}</style>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
                <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: theme.text, marginBottom: 4 }}>
                        Rejected Samples
                    </div>
                    <div style={{ fontSize: 12, color: theme.textMuted }}>
                        Face crops rejected by liveness / anti-spoofing during attendance, grouped by period. Use these to judge whether the threshold is too strict or too lenient. Crops auto-delete after 7 days.
                    </div>
                </div>
                {totalRejected > 0 && (
                    <button
                        onClick={() => openPeriod('all')}
                        disabled={loadingSummary}
                        style={{ ...styles.btnGhost, padding: '6px 14px', fontSize: 12 }}
                    >
                        View All ({totalRejected})
                    </button>
                )}
                <button
                    onClick={loadSummary}
                    disabled={loadingSummary}
                    style={{ ...styles.btnGhost, padding: '6px 14px', fontSize: 12 }}
                >
                    {loadingSummary ? 'Loading…' : '↻ Refresh'}
                </button>
            </div>

            {loadingSummary ? (
                <div style={{ textAlign: 'center', padding: 40, color: theme.textMuted }}>Loading…</div>
            ) : error ? (
                <div style={{ textAlign: 'center', padding: 40, color: theme.danger, fontSize: 13 }}>
                    {error}
                </div>
            ) : summary.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, color: theme.textMuted, fontSize: 13 }}>
                    No rejected crops saved yet. They appear here once attendance runs reject a spoofed face
                    (requires "Save rejected crops" to be on in ML Fine Tuning).
                </div>
            ) : (
                <table className="ams-table">
                    <thead>
                        <tr>
                            <th style={{ textAlign: 'left' }}>Period</th>
                            <th style={{ textAlign: 'center' }}>Rejected Count</th>
                            <th style={{ textAlign: 'center' }}></th>
                        </tr>
                    </thead>
                    <tbody>
                        {summary.map((row) => (
                            <tr key={row.periodKey}>
                                <td style={{ textAlign: 'left', fontWeight: 600 }}>{row.periodKey}</td>
                                <td style={{ textAlign: 'center' }}>{row.count}</td>
                                <td style={{ textAlign: 'center' }}>
                                    <button
                                        onClick={() => openPeriod(row.periodKey)}
                                        style={{ ...styles.btnGhost, padding: '4px 12px', fontSize: 11 }}
                                    >
                                        View
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot>
                        <tr>
                            <td style={{ textAlign: 'left' }}>Total</td>
                            <td style={{ textAlign: 'center' }}>{totalRejected}</td>
                            <td style={{ textAlign: 'center' }}></td>
                        </tr>
                    </tfoot>
                </table>
            )}

            {modalPeriod && (
                <div style={{
                    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                    background: 'rgba(0,0,0,0.55)', zIndex: 10000,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: 24,
                }}>
                    <div style={{
                        background: theme.surface, borderRadius: 12, padding: '20px 24px 24px',
                        maxWidth: 720, width: '100%', maxHeight: '80vh', overflowY: 'auto',
                        border: `1px solid ${theme.border}`,
                        boxShadow: '0 20px 48px rgba(0,0,0,0.35)',
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                            <div>
                                <div style={{ fontSize: 15, fontWeight: 700, color: theme.text }}>
                                    {modalPeriod === 'all' ? 'All Periods' : modalPeriod}
                                </div>
                                <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2 }}>
                                    {loadingModal ? 'Loading…' : `${modalSamples.length} rejected sample(s)`}
                                </div>
                            </div>
                            <button
                                onClick={closeModal}
                                style={{ ...styles.btnGhost, padding: '6px 14px', fontSize: 12 }}
                            >
                                Close
                            </button>
                        </div>

                        {loadingModal ? (
                            <div style={{ textAlign: 'center', padding: 40, color: theme.textMuted }}>Loading…</div>
                        ) : modalSamples.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: 40, color: theme.textMuted, fontSize: 13 }}>
                                No samples found.
                            </div>
                        ) : (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10 }}>
                                {modalSamples.map((s) => (
                                    <div
                                        key={s.filename}
                                        onClick={() => setLightbox(s)}
                                        style={{ borderRadius: 8, overflow: 'hidden', border: `1px solid ${theme.border}`, cursor: 'zoom-in' }}
                                    >
                                        <img
                                            src={`${getEnvironment()}${s.url}`}
                                            alt={s.filename}
                                            style={{ width: '100%', height: 120, objectFit: 'cover', display: 'block' }}
                                        />
                                        <div style={{ padding: '4px 6px' }}>
                                            {modalPeriod === 'all' && s.periodKey && (
                                                <div style={{
                                                    display: 'inline-block', fontSize: 9, fontWeight: 700,
                                                    padding: '1px 5px', borderRadius: 4, marginBottom: 2,
                                                    background: `${theme.accent}18`, color: theme.accent,
                                                }}>
                                                    {s.periodKey}
                                                </div>
                                            )}
                                            <div style={{ fontSize: 10, color: theme.textMuted, wordBreak: 'break-all' }}>
                                                {s.filename}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {lightbox && (
                <div
                    onClick={() => setLightbox(null)}
                    style={{
                        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                        background: 'rgba(0,0,0,0.85)', zIndex: 10001,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexDirection: 'column', gap: 12, padding: 24, cursor: 'zoom-out',
                    }}
                >
                    <img
                        src={`${getEnvironment()}${lightbox.url}`}
                        alt={lightbox.filename}
                        style={{ maxWidth: '90vw', maxHeight: '80vh', objectFit: 'contain', borderRadius: 8 }}
                    />
                    <div style={{ color: '#fff', fontSize: 12, textAlign: 'center' }}>
                        {lightbox.filename}
                        {lightbox.periodKey && <span style={{ opacity: 0.6 }}> · {lightbox.periodKey}</span>}
                    </div>
                    <button
                        onClick={(e) => { e.stopPropagation(); setLightbox(null); }}
                        style={{ ...styles.btnGhost, padding: '6px 16px', fontSize: 12 }}
                    >
                        Close
                    </button>
                </div>
            )}
        </div>
    );
}
