import { useState, useEffect, useRef } from 'react';
import getEnvironment from '../getenvironment';
import { theme, styles, cssReset, DEGREES } from './config';
import { useDepartments } from './useDepartments';

const apiUrl      = getEnvironment();
const UPLOAD_BASE = `${apiUrl}/attendancemodule/ground-truth-upload`;

const T = theme;

const CSS = `
  ${cssReset}
  @keyframes toastIn { from { opacity:0; transform:translateY(-20px) scale(0.95); } to { opacity:1; transform:translateY(0) scale(1); } }
  @keyframes modalIn { from { opacity:0; transform:translateY(-8px) scale(0.99); } to { opacity:1; transform:translateY(0) scale(1); } }

  .erp-card { background: ${T.surface}; border: 1px solid ${T.border}; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 6px rgba(26,31,60,0.05); }
  .erp-card-header { padding: 14px 18px; border-bottom: 1px solid ${T.border}; background: ${T.surfaceAlt}; font-size: 11px; color: ${T.textMuted}; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
  .erp-card-body { padding: 20px; }

  .erp-btn {
    padding: 7px 14px; border-radius: 7px; border: none; font-weight: 600; font-size: 12px;
    cursor: pointer; font-family: ${T.fontBody}; transition: opacity .2s; display: inline-flex; align-items: center; gap: 5px;
  }
  .erp-btn:hover { opacity: .85; }
  .erp-btn:disabled { opacity: .45; cursor: not-allowed; }
  .erp-btn-primary { background: ${T.accent}; color: #fff; }
  .erp-btn-ghost { background: transparent; border: 1px solid ${T.border}; color: ${T.textMuted}; }
  .erp-btn-danger { background: ${T.dangerDim}; border: 1px solid rgba(239,68,68,.25); color: ${T.danger}; }
  .erp-btn-warn   { background: rgba(245,158,11,.1); border: 1px solid rgba(245,158,11,.25); color: #d97706; }

  .erp-input {
    padding: 8px 12px; border-radius: 7px; border: 1px solid ${T.border};
    background: #f8f9fd; color: ${T.text}; font-family: ${T.fontBody}; font-size: 13px; outline: none;
    transition: border-color .2s; width: 100%;
  }
  .erp-input:focus { border-color: ${T.borderFocus}; box-shadow: 0 0 0 3px rgba(99,102,241,.12); }

  .erp-toast {
    position: fixed; top: 96px; left: 50%; transform: translateX(-50%); z-index: 9000;
    padding: 12px 22px; border-radius: 30px; display: flex; align-items: center; gap: 10px;
    font-size: 13px; font-weight: 700; color: #fff; white-space: nowrap;
    box-shadow: 0 4px 24px rgba(0,0,0,.25);
    animation: toastIn .25s cubic-bezier(.16,1,.3,1) both;
  }

  .erp-modal-overlay {
    position: fixed !important; inset: 0 !important; background: rgba(15,23,42,.45) !important;
    backdrop-filter: blur(5px) !important; display: flex !important; align-items: center !important;
    justify-content: center !important; z-index: 99999999 !important; padding: 20px !important;
    box-sizing: border-box !important;
  }
  .erp-modal-box {
    background: ${T.surface} !important; border: 1px solid ${T.border} !important;
    border-radius: 12px !important; padding: 24px !important; max-width: 420px !important;
    width: 100% !important; box-shadow: 0 20px 25px -5px rgba(0,0,0,.15) !important;
    animation: modalIn .2s cubic-bezier(.16,1,.3,1) both !important;
  }

  /* Override any global table borders inside erp-card */
  .erp-card .ams-table { border: none; }
  .erp-card .ams-table th, .erp-card .ams-table td { border-left: none; border-right: none; border-top: none; }

  .status-pill {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 3px 9px; border-radius: 20px; font-size: 11px; font-weight: 600;
  }
  .status-pill.ok { background: ${T.successDim}; color: ${T.success}; }
  .status-pill.no { background: ${T.dangerDim}; color: ${T.danger}; }
  .status-pill.na { background: ${T.accentDim}; color: ${T.accent}; }

  .batch-filter-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; }
  .batch-display { margin-top: 12px; padding: 10px 14px; background: ${T.bg}; border-radius: 7px; font-size: 13px; color: ${T.textMuted}; border: 1px solid ${T.border}; }

  /* ── Photo card grid ── */
  .photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 14px; padding: 20px; }
  .photo-card { background: ${T.surface}; border: 1px solid ${T.border}; border-radius: 10px; overflow: hidden; transition: box-shadow .18s, border-color .18s; display: flex; flex-direction: column; }
  .photo-card:hover { box-shadow: 0 4px 16px rgba(26,31,60,.10); border-color: ${T.accent}44; }
  .photo-card-img-wrap { width: 100%; aspect-ratio: 1 / 1; overflow: hidden; background: ${T.surfaceAlt}; position: relative; }
  .photo-card-img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .photo-card-img-placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: ${T.textMuted}; font-size: 36px; }
  .photo-card-body { padding: 10px; flex: 1; display: flex; flex-direction: column; gap: 8px; }
  .photo-card-roll { font-family: ${T.fontMono}; font-size: 12px; font-weight: 700; color: ${T.text}; text-align: center; word-break: break-all; }
  .photo-card-actions { display: flex; gap: 6px; }
  .photo-card-actions .erp-btn { flex: 1; justify-content: center; padding: 6px 4px; font-size: 11px; }

  .search-bar-wrap { padding: 16px 20px 0; }
  .search-input { padding: 9px 14px 9px 38px; border-radius: 8px; border: 1px solid ${T.border}; background: #f8f9fd; color: ${T.text}; font-family: ${T.fontBody}; font-size: 13px; outline: none; transition: border-color .2s; width: 100%; box-sizing: border-box; }
  .search-input:focus { border-color: ${T.borderFocus}; box-shadow: 0 0 0 3px rgba(99,102,241,.12); }
  .search-wrap-inner { position: relative; max-width: 340px; }
  .search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: ${T.textMuted}; pointer-events: none; font-size: 14px; }

  .summary-table-scroll { overflow-x: auto; }
  .summary-grid {
    display: grid;
    grid-template-columns: minmax(180px, 2fr) 90px 150px 190px 165px 120px;
    min-width: 1010px;
  }

  @media (max-width: 768px) {
    .batch-filter-grid { grid-template-columns: 1fr; }
    .erp-toast { max-width: calc(100vw - 32px); white-space: normal; }
    .ams-tabs { overflow-x: auto; }
  }
`;

// ── Embedding-run banner ─────────────────────────────────────────────────────
// 'syncing' means the background build is genuinely still going — it clears
// only once the server reports the run finished, so it is never a stand-in for
// "we fired the request and hoped".
function EmbedStatusBanner({ status, batchName }) {
    if (!status) return null;

    const base = { marginTop: 12, padding: '9px 14px', borderRadius: 7, fontSize: 13, fontWeight: 600 };
    if (status === 'syncing') {
        return (
            <div style={{ ...base, background: T.accentDim, color: T.accent,
                          display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span>
                Generating embeddings for {batchName}… this can take a few minutes
            </div>
        );
    }
    if (status === 'done') {
        return <div style={{ ...base, background: T.successDim, color: T.success }}>✓ Embeddings generated for {batchName}</div>;
    }
    return <div style={{ ...base, background: T.dangerDim, color: T.danger }}>✗ Embedding generation failed — see the message above</div>;
}

// ── Shared batch selector component ──────────────────────────────────────────
function BatchSelector({ degree, setDegree, degrees, setDegrees, department, setDepartment, batchYear, setBatchYear, departments, deptLoading, deptError, batches, batchesLoading, batchName, photoCount, fixedDepartment }) {
    return (
        <div className="erp-card" style={{ marginBottom: 20 }}>
            <div className="erp-card-header">Batch Selection</div>
            <div className="erp-card-body">
                <div className="batch-filter-grid">
                    <div>
                        <label style={styles.label}>Degree</label>
                        <select value={degree} onChange={e => setDegree(e.target.value)} style={styles.select}>
                            <option value="">Select…</option>
                            {degrees.map(d => <option key={d.degreeName}>{d.degreeName}</option>)}
                        </select>
                    </div>
                    <div>
                        <label style={styles.label}>Department</label>
                        {fixedDepartment ? (
                            <div style={{ ...styles.select, display: 'flex', alignItems: 'center', background: T.bg, color: T.textMuted, cursor: 'not-allowed' }}>
                                {fixedDepartment.replace(/_/g, ' ')}
                            </div>
                        ) : (
                            <select value={department} onChange={e => { setDepartment(e.target.value); setBatchYear(''); }} style={styles.select} disabled={deptLoading}>
                                <option value="">{deptLoading ? 'Loading…' : deptError ? 'Error' : 'Select…'}</option>
                                {departments.map((d) => {
                                const normalisedDepartment = d.replace(/_/g, " ")
                                const selectedDegree = degrees.find(d => d.degreeName === degree);
                                const branch = selectedDegree?.branches?.find( b => b.dept === normalisedDepartment );
                                return (
                                    <option key={d} value={d}>
                                        {branch?.branchName || normalisedDepartment}
                                    </option>
                                );
                            })}
                            </select>
                        )}
                    </div>
                    <div>
                        <label style={styles.label}>Batch Year</label>
                        <select value={batchYear} onChange={e => setBatchYear(e.target.value)} style={styles.select} disabled={batchesLoading}>
                            <option value="">{batchesLoading ? 'Loading…' : batches.length === 0 ? 'No batches' : 'Select…'}</option>
                            {batches.map(b => <option key={b} value={b}>{b}</option>)}
                        </select>
                    </div>
                </div>
                {batchName && (
                    <div className="batch-display" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                        <span>Target: <strong style={{ color: T.accent, fontFamily: T.fontMono }}>{batchName}</strong></span>
                        {photoCount != null && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: T.accentDim, borderRadius: 20, padding: '3px 10px', fontSize: 12, fontWeight: 700, color: T.accent }}>
                                <span style={{ fontSize: 13 }}>👤</span>
                                {photoCount} student{photoCount !== 1 ? 's' : ''} uploaded
                            </span>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

function EmbeddingProgressPanel({ progress }) {
    if (!progress) return null;

    const active = progress.status === 'queued' || progress.status === 'running';
    const failedRollNos = Array.isArray(progress.failedRollNos) ? progress.failedRollNos : [];
    const tone = progress.status === 'error'
        ? { color: T.danger, background: T.dangerDim, border: 'rgba(239,68,68,.25)' }
        : progress.status === 'done'
            ? { color: T.success, background: T.successDim, border: 'rgba(16,185,129,.25)' }
            : { color: T.accent, background: T.accentDim, border: 'rgba(99,102,241,.25)' };

    return (
        <div style={{
            marginTop: 14,
            padding: 14,
            borderRadius: 8,
            background: tone.background,
            border: `1px solid ${tone.border}`,
            color: tone.color,
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8, fontSize: 12, fontWeight: 700 }}>
                <span>
                    {active
                        ? 'Generating ERP embeddings…'
                        : progress.status === 'done'
                            ? 'Embedding generation complete'
                            : 'Embedding generation failed'}
                </span>
                <span>{progress.processed}/{progress.total} processed ({progress.progressPercent}%)</span>
            </div>

            <div
                role="progressbar"
                aria-label="ERP embedding generation progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress.progressPercent}
                style={{ height: 8, borderRadius: 99, overflow: 'hidden', background: 'rgba(15,23,42,.12)' }}
            >
                <div style={{
                    width: `${progress.progressPercent}%`,
                    height: '100%',
                    background: tone.color,
                    transition: 'width .25s ease',
                }} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 12 }}>
                <div><strong>{progress.total}</strong><br /><span style={{ fontSize: 10 }}>Total photos</span></div>
                <div><strong>{progress.completed}</strong><br /><span style={{ fontSize: 10 }}>Completed</span></div>
                <div><strong>{progress.failed}</strong><br /><span style={{ fontSize: 10 }}>Face not detected</span></div>
            </div>

            {progress.status === 'done' && (
                <div style={{ marginTop: 10, fontSize: 11, fontWeight: 600 }}>
                    Completion: {progress.completed}/{progress.total} embeddings ({progress.successPercent}%)
                </div>
            )}

            {failedRollNos.length > 0 && (
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${tone.border}` }}>
                    <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 7 }}>
                        Replace the ERP photos for these roll numbers:
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                        {failedRollNos.map((failedRollNo) => (
                            <span key={failedRollNo} style={{
                                padding: '3px 8px',
                                borderRadius: 5,
                                background: T.surface,
                                border: `1px solid ${T.danger}55`,
                                color: T.danger,
                                fontFamily: T.fontMono,
                                fontSize: 11,
                                fontWeight: 700,
                            }}>
                                {failedRollNo}
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {progress.error && (
                <div style={{ marginTop: 10, fontSize: 11 }}>Error: {progress.error}</div>
            )}
        </div>
    );
}

export default function GroundTruthUpload({ fixedDepartment = '' }) {
    const { departments, loading: deptLoading, error: deptError } = useDepartments();

    // ── Shared filter state ───────────────────────────────────────────
    const [degree,       setDegree]       = useState('');
    const [degrees, setDegrees]           = useState([]);
    const [department,   setDepartment]   = useState('');
    const [batchYear,    setBatchYear]    = useState('');
    const [batches,      setBatches]      = useState([]);
    const [batchesLoading, setBatchesLoading] = useState(false);

    useEffect(() => {
        if (fixedDepartment) setDepartment(fixedDepartment);
    }, [fixedDepartment]);

    const batchName = (degree && department && batchYear) ? `${degree}_${department}_${batchYear}` : '';

    // ── Active tab ────────────────────────────────────────────────────
    const [activeTab, setActiveTab] = useState('summary');

    // ── Upload tab state ──────────────────────────────────────────────
    const [zipFile,       setZipFile]       = useState(null);
    const [zipUploading,  setZipUploading]  = useState(false);
    const [zipResult,     setZipResult]     = useState(null);
    const [zipReplaceConfirm, setZipReplaceConfirm] = useState(false);
    const [rollNo,        setRollNo]        = useState('');
    const [studentPhoto,  setStudentPhoto]  = useState(null);
    const [photoUploading, setPhotoUploading] = useState(false);

    // ── Manage tab state ──────────────────────────────────────────────
    const [photos,         setPhotos]        = useState([]);
    const [photosLoading,  setPhotosLoading] = useState(false);
    const [editingRoll,    setEditingRoll]   = useState(null); // rollNo being renamed
    const [editValue,      setEditValue]     = useState('');
    const [saving,         setSaving]        = useState(false);
    const [pendingDelete,  setPendingDelete] = useState(null); // {rollNo, ext}
    const [deleting,       setDeleting]      = useState(false);
    const [pendingDeleteAll, setPendingDeleteAll] = useState(false);
    const [deletingAll,      setDeletingAll]      = useState(false);
    const [searchQuery,    setSearchQuery]   = useState('');

    // ── Summary tab state ─────────────────────────────────────────────
    const [summaryBatches,  setSummaryBatches]  = useState([]);
    const [summaryLoading,  setSummaryLoading]  = useState(false);
    const [regenning,       setRegenning]       = useState({});
    const embeddingPollTimers = useRef({});
    const [zipEmbeddingProgress, setZipEmbeddingProgress] = useState(null);
    const [photoEmbeddingProgress, setPhotoEmbeddingProgress] = useState(null);

    // ── Photo count for selected batch (shown in upload tab) ─────────
    const [batchPhotoCount, setBatchPhotoCount] = useState(null);

    const [summaryVersion, setSummaryVersion] = useState(0); // bump to force summary refresh

    // ── Toast ─────────────────────────────────────────────────────────
    const [toast, setToast] = useState(null);
    const showToast = (msg, type = 'success') => {
        setToast({ msg, type });
        setTimeout(() => setToast(null), 4500);
    };

    useEffect(() => () => {
        Object.values(embeddingPollTimers.current).forEach(clearTimeout);
    }, []);

    const trackEmbeddingJob = (initialJob, key, setProgress, onDone) => {
        if (!initialJob?.jobId) {
            const failedProgress = {
                status: 'error',
                total: 0,
                processed: 0,
                completed: 0,
                failed: 0,
                progressPercent: 0,
                successPercent: 0,
                failedRollNos: [],
                error: 'The server did not return an embedding job',
            };
            setProgress(failedProgress);
            onDone(failedProgress);
            return;
        }

        if (embeddingPollTimers.current[key]) {
            clearTimeout(embeddingPollTimers.current[key]);
        }
        setProgress(initialJob);

        let consecutiveErrors = 0;
        let latestProgress = initialJob;
        const poll = async () => {
            try {
                const response = await fetch(
                    `${UPLOAD_BASE}/sync-progress/${encodeURIComponent(initialJob.jobId)}`,
                    { credentials: 'include' },
                );
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Failed to load embedding progress');

                consecutiveErrors = 0;
                latestProgress = data;
                setProgress(data);

                if (data.status === 'done' || data.status === 'error') {
                    delete embeddingPollTimers.current[key];
                    onDone(data);
                    return;
                }
            } catch (error) {
                consecutiveErrors += 1;
                if (consecutiveErrors >= 3) {
                    const failedProgress = {
                        ...latestProgress,
                        status: 'error',
                        error: error.message,
                    };
                    setProgress(failedProgress);
                    delete embeddingPollTimers.current[key];
                    onDone(failedProgress);
                    return;
                }
            }

            embeddingPollTimers.current[key] = setTimeout(poll, 800);
        };

        embeddingPollTimers.current[key] = setTimeout(poll, 300);
    };

    // Fetch Degrees
    const fetchDegrees = async () => {
        const url = `${apiUrl}/attendancemodule/settings/batches/degrees`
        const res = await fetch(url, {credentials: "include"})
        const data = await res.json();
        setDegrees(data.degrees);
    }

    useEffect(() => {
        fetchDegrees();
    }, [])

    // ── Load batch years on mount ─────────────────────────────────────
    useEffect(() => {
        let cancelled = false;
        setBatchesLoading(true);
        fetch(`${apiUrl}/attendancemodule/settings/batches`, { credentials: 'include' })
            .then(r => r.json())
            .then(data => {
                if (cancelled) return;
                const years = [...new Set((data.batches || []).map(b => b.batchYear))].filter(Boolean).sort().reverse();
                setBatches(years);
            })
            .catch(() => {})
            .finally(() => { if (!cancelled) setBatchesLoading(false); });
        return () => { cancelled = true; };
    }, []);

    // ── Fetch current student count for the selected batch ───────────
    useEffect(() => {
        if (!batchName) { setBatchPhotoCount(null); return; }
        let cancelled = false;
        fetch(`${UPLOAD_BASE}/list/${encodeURIComponent(batchName)}`, { credentials: 'include' })
            .then(r => r.ok ? r.json() : null)
            .then(d => { if (!cancelled) setBatchPhotoCount(d?.rollNos?.length ?? 0); })
            .catch(() => { if (!cancelled) setBatchPhotoCount(null); });
        return () => { cancelled = true; };
    }, [batchName]);

    // ── Load photos when manage tab selected + batch set ─────────────
    useEffect(() => {
        if (activeTab !== 'manage' || !batchName) { setPhotos([]); setSearchQuery(''); return; }
        let cancelled = false;
        setPhotosLoading(true);
        fetch(`${UPLOAD_BASE}/list/${encodeURIComponent(batchName)}`, { credentials: 'include' })
            .then(r => r.json())
            .then(data => { if (!cancelled) setPhotos(data.rollNos || []); })
            .catch(() => { if (!cancelled) setPhotos([]); })
            .finally(() => { if (!cancelled) setPhotosLoading(false); });
        return () => { cancelled = true; };
    }, [activeTab, batchName]);

    // ── Load summary data when summary tab selected ───────────────────
    useEffect(() => {
        if (activeTab !== 'summary') return;
        let cancelled = false;
        setSummaryLoading(true);

        // /summary now returns hasEmbedding + embeddingUpdatedAt per batch (filesystem check)
        fetch(`${UPLOAD_BASE}/summary`, { credentials: 'include' })
            .then(r => r.ok ? r.json() : { batches: [] })
            .then(data => { if (!cancelled) setSummaryBatches(data.batches || []); })
            .catch(() => { if (!cancelled) setSummaryBatches([]); })
            .finally(() => { if (!cancelled) setSummaryLoading(false); });

        return () => { cancelled = true; };
    }, [activeTab, summaryVersion]);

    // ── Upload handlers ───────────────────────────────────────────────
    const handleZipUpload = async () => {
        if (!batchName) { showToast('Please select a Batch', 'error'); return; }
        if (!zipFile)   { showToast('Please select a ZIP file', 'error'); return; }

        if (batchPhotoCount > 0 && !zipReplaceConfirm) {
            setZipReplaceConfirm(true);
            return;
        }

        executeZipUpload();
    };

    const executeZipUpload = async () => {
        setZipReplaceConfirm(false);
        setZipUploading(true);
        setZipResult(null);
        setZipEmbeddingProgress(null);
        const formData = new FormData();
        formData.append('zipFile', zipFile);

        try {
            const replaceQuery = batchPhotoCount > 0 ? '?replace=true' : '';
            const res = await fetch(`${UPLOAD_BASE}/upload-zip/${encodeURIComponent(batchName)}${replaceQuery}`, {
                method: 'POST',
                credentials: 'include',
                body: formData,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Upload failed');
            setZipResult(data);
            showToast(`Extracted ${data.extractedImages} photos for ${data.extractedFolders} students!`);
            setZipFile(null);

            if (data.embeddingJob) {
                trackEmbeddingJob(
                    data.embeddingJob,
                    'zip',
                    setZipEmbeddingProgress,
                    (job) => {
                        if (job.status === 'done') {
                            showToast(
                                `Embeddings complete: ${job.completed}/${job.total}`
                                + (job.failed ? ` — ${job.failed} face${job.failed === 1 ? '' : 's'} not detected` : ''),
                                job.failed ? 'warning' : 'success',
                            );
                            setSummaryVersion(v => v + 1);
                        } else {
                            showToast(job.error || 'Embedding generation failed', 'error');
                        }
                    },
                );
            }

            if (batchPhotoCount > 0) {
                setBatchPhotoCount(data.extractedFolders || 0); // Replaced
            } else {
                setBatchPhotoCount(c => (c ?? 0) + (data.extractedFolders || 0));
            }

        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            setZipUploading(false);
        }
    };

    const handlePhotoUpload = async () => {
        if (!batchName)  { showToast('Please select a Batch', 'error'); return; }
        if (!rollNo.trim()) { showToast('Please enter a Roll Number', 'error'); return; }
        if (!studentPhoto)  { showToast('Please select a photo', 'error'); return; }

        setPhotoUploading(true);
        setPhotoEmbeddingProgress(null);
        const formData = new FormData();
        formData.append('photo', studentPhoto);

        try {
            const res = await fetch(`${UPLOAD_BASE}/upload-photos/${encodeURIComponent(batchName)}/${encodeURIComponent(rollNo.trim())}`, {
                method: 'POST',
                credentials: 'include',
                body: formData,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Upload failed');
            showToast(`Photo uploaded for ${data.rollNo}`);
            setStudentPhoto(null);
            setRollNo('');

            if (data.embeddingJob) {
                trackEmbeddingJob(
                    data.embeddingJob,
                    'photo',
                    setPhotoEmbeddingProgress,
                    (job) => {
                        if (job.status === 'done') {
                            showToast(
                                job.failed
                                    ? `No face detected for ${job.failedRollNos.join(', ')}`
                                    : `Embedding created for ${data.rollNo}`,
                                job.failed ? 'warning' : 'success',
                            );
                            setSummaryVersion(v => v + 1);
                        } else {
                            showToast(job.error || 'Embedding generation failed', 'error');
                        }
                    },
                );
            }

            setBatchPhotoCount(c => (c ?? 0) + 1);

        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            setPhotoUploading(false);
        }
    };

    // ── Manage tab handlers ───────────────────────────────────────────
    const handleRename = async () => {
        if (!editValue.trim()) return;
        setSaving(true);
        try {
            const res = await fetch(`${UPLOAD_BASE}/rename-student`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ batch: batchName, oldRollNo: editingRoll, newRollNo: editValue.trim().toUpperCase() }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Rename failed');
            showToast(`Renamed to ${data.newRollNo}`);
            setPhotos(prev => prev.map(p => p.rollNo === editingRoll ? { ...p, rollNo: data.newRollNo } : p));
            setEditingRoll(null);
            setEditValue('');
            setSummaryVersion(v => v + 1);
        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            setSaving(false);
        }
    };

    const handleConfirmedDelete = async () => {
        if (!pendingDelete) return;
        setDeleting(true);
        try {
            const res = await fetch(`${UPLOAD_BASE}/photo/${encodeURIComponent(batchName)}/${encodeURIComponent(pendingDelete.rollNo)}`, {
                method: 'DELETE',
                credentials: 'include',
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Delete failed');
            showToast(`Deleted ${pendingDelete.rollNo}`);
            setPhotos(prev => prev.filter(p => p.rollNo !== pendingDelete.rollNo));
            setSummaryVersion(v => v + 1);
            setPendingDelete(null);
        } catch (err) {
            showToast(err.message, 'error');
            setPendingDelete(null);
        } finally {
            setDeleting(false);
        }
    };

    const handleConfirmedDeleteAll = async () => {
        if (!batchName) return;
        setDeletingAll(true);
        try {
            const res = await fetch(`${UPLOAD_BASE}/photos/${encodeURIComponent(batchName)}`, {
                method: 'DELETE',
                credentials: 'include',
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Delete failed');
            showToast(data.message || 'All photos deleted');
            setPhotos([]);
            setSummaryVersion(v => v + 1);
            setPendingDeleteAll(false);
        } catch (err) {
            showToast(err.message, 'error');
            setPendingDeleteAll(false);
        } finally {
            setDeletingAll(false);
        }
    };

    // ── Summary helpers ───────────────────────────────────────────────
    const parseBatch = (batchStr) => {
        const parts = batchStr.split('_');
        if (parts.length >= 3) {
            return { degree: parts[0], dept: parts.slice(1, -1).join('_'), year: parts[parts.length - 1] };
        }
        return { degree: batchStr, dept: '—', year: '—' };
    };

    const handleRegen = async (batch) => {
        setRegenning(r => ({ ...r, [batch]: true }));
        try {
            const response = await fetch(`${UPLOAD_BASE}/sync-all/${encodeURIComponent(batch)}`, {
                method: 'POST', credentials: 'include',
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Sync trigger failed');
            showToast(`Generating embeddings for ${batch}…`);

            trackEmbeddingJob(
                data.embeddingJob,
                `regen:${batch}`,
                () => {},
                (job) => {
                    setRegenning(prev => { const next = { ...prev }; delete next[batch]; return next; });
                    if (job.status === 'done') {
                        setSummaryVersion(v => v + 1);
                        showToast(
                            `Embeddings complete for ${batch}: ${job.completed}/${job.total}`
                            + (job.failed ? ` — ${job.failed} face${job.failed === 1 ? '' : 's'} not detected` : ''),
                            job.failed ? 'warning' : 'success',
                        );
                    } else {
                        showToast(job.error || 'Embedding generation failed', 'error');
                    }
                },
            );
        } catch (e) {
            showToast(e.message, 'error');
        } finally {
            setRegenning(prev => { const n = { ...prev }; delete n[batch]; return n; });
        }
    };

    // ── Render ────────────────────────────────────────────────────────
    return (
        <div style={{ ...styles.page, padding: 'clamp(16px,3vw,32px)' }}>
            <style>{CSS}</style>

            {/* Toast */}
            {toast && (
                <div className="erp-toast" style={{ background: toast.type === 'error' ? '#ef4444' : toast.type === 'warning' ? '#f59e0b' : '#10b981' }}>
                    <span style={{ fontSize: 15 }}>{toast.type === 'error' ? '⚠' : toast.type === 'warning' ? '⚠' : '✓'}</span>
                    {toast.msg}
                </div>
            )}

            {/* Header */}
            <div style={{ marginBottom: 24 }}>
                <div style={styles.heading}>ERP Image Upload</div>
                <div style={styles.subheading}>Review embedding results, replace failed photos, and regenerate embeddings</div>
            </div>

            {/* Tabs */}
            <div className="ams-tabs">
                {[
                    { id: 'summary', label: 'Summary' },
                    { id: 'upload',  label: 'Upload' },
                    { id: 'manage',  label: 'Manage Photos' },
                ].map(t => (
                    <button key={t.id} className={`ams-tab${activeTab === t.id ? ' active' : ''}`} onClick={() => setActiveTab(t.id)}>
                        {t.label}
                    </button>
                ))}
            </div>

            {/* ══ UPLOAD TAB ════════════════════════════════════════════════════ */}
            {activeTab === 'upload' && (
                <>
                    <BatchSelector {...{ degree, setDegree, degrees, setDegrees, department, setDepartment, batchYear, setBatchYear, departments, deptLoading, deptError, batches, batchesLoading, batchName, photoCount: batchPhotoCount, fixedDepartment }} />

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                        {/* ZIP Upload */}
                        <div className="erp-card">
                            <div className="erp-card-header">Batch ZIP Upload</div>
                            <div className="erp-card-body">
                                <p style={{ fontSize: 13, color: T.textMuted, marginBottom: 16, marginTop: 0 }}>
                                    Upload a ZIP with images named by roll number.<br />
                                    e.g. 23104001.jpg, 23104002.png
                                </p>
                                <input
                                    type="file"
                                    accept=".zip"
                                    onChange={e => setZipFile(e.target.files[0])}
                                    style={{ display: 'block', width: '100%', padding: 10, background: T.bg, borderRadius: 7, border: `1px solid ${T.border}`, color: T.text, marginBottom: 14, fontSize: 13 }}
                                />
                                <button
                                    onClick={handleZipUpload}
                                    disabled={zipUploading || !batchName || !zipFile}
                                    className="erp-btn erp-btn-primary"
                                    style={{ width: '100%', justifyContent: 'center', padding: '10px 16px', fontSize: 14 }}
                                >
                                    {zipUploading ? 'Extracting ZIP…' : 'Upload & Extract ZIP'}
                                </button>
                                <EmbeddingProgressPanel progress={zipEmbeddingProgress} />

                                {zipResult && (
                                    <div style={{ marginTop: 14, padding: '10px 14px', background: T.successDim, borderRadius: 7, border: `1px solid rgba(16,185,129,.25)`, fontSize: 13, color: T.success, fontWeight: 600 }}>
                                        ✓ {zipResult.extractedImages} photos extracted for {zipResult.extractedFolders} students
                                    </div>
                                )}
                                {zipResult?.errors?.length > 0 && (
                                    <div style={{ marginTop: 10, padding: 10, background: T.dangerDim, borderRadius: 7, border: `1px solid rgba(239,68,68,.25)` }}>
                                        <div style={{ fontSize: 12, color: T.danger, fontWeight: 600, marginBottom: 5 }}>Warnings:</div>
                                        <ul style={{ fontSize: 11, color: T.danger, margin: 0, paddingLeft: 16 }}>
                                            {zipResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                                        </ul>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Individual Upload */}
                        <div className="erp-card">
                            <div className="erp-card-header">Individual Student Upload</div>
                            <div className="erp-card-body">
                                <div style={{ marginBottom: 12 }}>
                                    <label style={styles.label}>Roll Number</label>
                                    <input
                                        type="text"
                                        value={rollNo}
                                        onChange={e => setRollNo(e.target.value.toUpperCase())}
                                        placeholder="e.g. 21BCE001"
                                        className="erp-input"
                                    />
                                </div>
                                <div style={{ marginBottom: 16 }}>
                                    <label style={styles.label}>Select Photo</label>
                                    <input
                                        type="file"
                                        accept="image/*"
                                        onChange={e => setStudentPhoto(e.target.files[0] || null)}
                                        style={{ display: 'block', width: '100%', padding: 10, background: T.bg, borderRadius: 7, border: `1px solid ${T.border}`, color: T.text, fontSize: 13 }}
                                    />
                                </div>
                                <button
                                    onClick={handlePhotoUpload}
                                    disabled={photoUploading || !batchName || !rollNo || !studentPhoto}
                                    className="erp-btn erp-btn-primary"
                                    style={{ width: '100%', justifyContent: 'center', padding: '10px 16px', fontSize: 14 }}
                                >
                                    {photoUploading ? 'Uploading…' : 'Upload Photo'}
                                </button>
                                <EmbeddingProgressPanel progress={photoEmbeddingProgress} />
                            </div>
                        </div>
                    </div>

                   
                </>
            )}

            {/* ══ MANAGE TAB ════════════════════════════════════════════════════ */}
            {activeTab === 'manage' && (
                <>
                    <BatchSelector {...{ degree, setDegree, degrees, setDegrees, department, setDepartment, batchYear, setBatchYear, departments, deptLoading, deptError, batches, batchesLoading, batchName, fixedDepartment }} />

                    {!batchName ? (
                        <div className="erp-card" style={{ padding: '40px 20px', textAlign: 'center', color: T.textMuted, fontSize: 13 }}>
                            Select a batch above to view and manage its photos.
                        </div>
                    ) : photosLoading ? (
                        <div style={{ textAlign: 'center', padding: 40, color: T.textMuted, fontSize: 13 }}>Loading photos…</div>
                    ) : (
                        <div className="erp-card">
                            <div className="erp-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span>Photos in <span style={{ color: T.accent }}>{batchName}</span></span>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                    <span style={{ color: T.accent, fontWeight: 700 }}>
                                        {searchQuery
                                            ? `${photos.filter(p => p.rollNo.includes(searchQuery)).length} / ${photos.length} students`
                                            : `${photos.length} students`}
                                    </span>
                                    {photos.length > 0 && (
                                        <button
                                            onClick={() => setPendingDeleteAll(true)}
                                            style={{
                                                background: 'transparent', border: '1px solid #ef4444',
                                                color: '#ef4444', padding: '5px 12px', borderRadius: 6,
                                                fontWeight: 600, fontSize: 12, cursor: 'pointer', fontFamily: T.fontBody,
                                            }}
                                        >
                                            🗑 Delete All
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Search bar */}
                            <div className="search-bar-wrap">
                                <div className="search-wrap-inner">
                                    <span className="search-icon">🔍</span>
                                    <input
                                        className="search-input"
                                        placeholder="Search roll number…"
                                        value={searchQuery}
                                        onChange={e => setSearchQuery(e.target.value.toUpperCase())}
                                    />
                                </div>
                            </div>

                            {(() => {
                                const filtered = photos.filter(p =>
                                    !searchQuery || p.rollNo.includes(searchQuery)
                                );
                                if (photos.length === 0) return (
                                    <div style={{ padding: '40px 20px', textAlign: 'center', color: T.textMuted, fontSize: 13 }}>
                                        No photos found in this batch.
                                    </div>
                                );
                                if (filtered.length === 0) return (
                                    <div style={{ padding: '40px 20px', textAlign: 'center', color: T.textMuted, fontSize: 13 }}>
                                        No results for &quot;<strong>{searchQuery}</strong>&quot;
                                    </div>
                                );
                                return (
                                    <div className="photo-grid">
                                        {filtered.map(p => {
                                            const imgUrl = `${apiUrl}/attendancemodule/roll-assign/erp-photo/${encodeURIComponent(batchName)}/${encodeURIComponent(p.rollNo + p.ext)}`;
                                            const isEditing = editingRoll === p.rollNo;
                                            return (
                                                <div className="photo-card" key={p.rollNo}>
                                                    <div className="photo-card-img-wrap">
                                                        <img
                                                            className="photo-card-img"
                                                            src={imgUrl}
                                                            alt={p.rollNo}
                                                            onError={e => {
                                                                e.currentTarget.style.display = 'none';
                                                                e.currentTarget.nextSibling.style.display = 'flex';
                                                            }}
                                                        />
                                                        <div className="photo-card-img-placeholder" style={{ display: 'none' }}>👤</div>
                                                    </div>
                                                    <div className="photo-card-body">
                                                        {isEditing ? (
                                                            <>
                                                                <input
                                                                    className="erp-input"
                                                                    style={{ fontSize: 12, padding: '6px 10px', textAlign: 'center' }}
                                                                    value={editValue}
                                                                    onChange={e => setEditValue(e.target.value.toUpperCase())}
                                                                    onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') { setEditingRoll(null); setEditValue(''); } }}
                                                                    autoFocus
                                                                />
                                                                <div className="photo-card-actions">
                                                                    <button
                                                                        className="erp-btn erp-btn-primary"
                                                                        onClick={handleRename}
                                                                        disabled={saving || !editValue.trim()}
                                                                    >
                                                                        {saving ? '…' : 'Save'}
                                                                    </button>
                                                                    <button
                                                                        className="erp-btn erp-btn-ghost"
                                                                        onClick={() => { setEditingRoll(null); setEditValue(''); }}
                                                                    >
                                                                        Cancel
                                                                    </button>
                                                                </div>
                                                            </>
                                                        ) : (
                                                            <>
                                                                <div className="photo-card-roll">{p.rollNo}</div>
                                                                <div className="photo-card-actions">
                                                                    <button
                                                                        className="erp-btn erp-btn-warn"
                                                                        onClick={() => { setEditingRoll(p.rollNo); setEditValue(p.rollNo); }}
                                                                    >
                                                                        ✏ Edit
                                                                    </button>
                                                                    <button
                                                                        className="erp-btn erp-btn-danger"
                                                                        onClick={() => setPendingDelete(p)}
                                                                    >
                                                                        🗑 Delete
                                                                    </button>
                                                                </div>
                                                            </>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                );
                            })()}
                        </div>
                    )}
                </>
            )}

            {/* ══ SUMMARY TAB ═══════════════════════════════════════════════════ */}
            {activeTab === 'summary' && (
                <>
                    {summaryLoading ? (
                        <div style={{ textAlign: 'center', padding: 40, color: T.textMuted, fontSize: 13 }}>
                            Loading summary…
                        </div>
                    ) : summaryBatches.length === 0 ? (
                        <div className="erp-card" style={{ padding: '40px 20px', textAlign: 'center', color: T.textMuted, fontSize: 13 }}>
                            No ERP photo batches found.
                        </div>
                    ) : (
                        (() => {
                            // Group batches by department
                            const groups = {};
                            const fixedNorm = fixedDepartment ? fixedDepartment.trim().toUpperCase() : null;
                            for (const row of summaryBatches) {
                                const { dept } = parseBatch(row.batch);
                                const normalizedDept = dept.trim().toUpperCase();
                                // Dept-admins only see their own department's batches
                                if (fixedNorm && normalizedDept !== fixedNorm) continue;
                                if (!groups[normalizedDept]) groups[normalizedDept] = { name: dept.trim(), items: [] };
                                groups[normalizedDept].items.push(row);
                            }
                            const fmtDate = (d) => {
                                if (!d) return '—';
                                const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
                                const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
                                return `${date}, ${time}`;
                            };
                            return Object.keys(groups).sort().map(deptKey => {
                                const deptName = groups[deptKey].name;
                                const items = groups[deptKey].items;
                                return (
                                <div key={deptKey} className="erp-card" style={{ marginBottom: 20 }}>
                                    <div className="erp-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <span style={{ fontWeight: 700, fontSize: 13, color: T.text }}>{deptName.replace(/_/g, ' ')}</span>
                                        <span style={{ background: T.accentDim, color: T.accent, borderRadius: 20, padding: '2px 10px', fontSize: 11, fontWeight: 700 }}>
                                            {items.length} batch{items.length !== 1 ? 'es' : ''}
                                        </span>
                                    </div>

                                    <div className="summary-table-scroll">
                                        {/* Column header row */}
                                        <div className="summary-grid" style={{
                                            padding: '8px 18px', background: T.bg,
                                            borderBottom: `1px solid ${T.border}`,
                                            fontSize: 10, fontWeight: 700, color: T.textMuted,
                                            textTransform: 'uppercase', letterSpacing: '0.07em',
                                        }}>
                                            <span>Batch</span>
                                            <span style={{ textAlign: 'center' }}>Students</span>
                                            <span style={{ textAlign: 'center' }}>Embeddings</span>
                                            <span style={{ textAlign: 'center' }}>Face Not Detected</span>
                                            <span>Last Updated</span>
                                            <span style={{ textAlign: 'right' }}>Action</span>
                                        </div>

                                        {/* Data rows */}
                                        {items.slice().sort((a, b) => a.batch.localeCompare(b.batch)).map((row, idx, arr) => {
                                            const { degree: deg, year } = parseBatch(row.batch);
                                            const embOk  = !!row.hasEmbedding;
                                            const summaryReady = row.faceNotDetectedCount != null;
                                            const failedRollNos = Array.isArray(row.failedRollNos) ? row.failedRollNos : [];
                                            const updatedAt = row.embeddingSummaryUpdatedAt || row.embeddingUpdatedAt;
                                            const lastDt = updatedAt ? new Date(updatedAt) : null;
                                            const busy   = !!regenning[row.batch];
                                            const isLast = idx === arr.length - 1;
                                            return (
                                                <div key={row.batch} style={{
                                                    borderBottom: isLast ? 'none' : `1px solid ${T.border}`,
                                                }}>
                                                    <div className="summary-grid" style={{
                                                        alignItems: 'center', padding: '13px 18px',
                                                        transition: 'background .1s',
                                                    }}
                                                    onMouseEnter={e => e.currentTarget.style.background = '#f8f9ff'}
                                                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                                    >
                                                {/* Batch identity */}
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                                                    <span style={{ fontFamily: T.fontMono, fontWeight: 700, fontSize: 12, color: T.text }}>{deg}</span>
                                                    <span style={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 700, fontFamily: T.fontMono, color: T.accent, flexShrink: 0 }}>{year}</span>
                                                </div>

                                                {/* Student count */}
                                                <div style={{ textAlign: 'center' }}>
                                                    <span style={{ fontSize: 16, fontWeight: 800, color: row.count > 0 ? T.text : T.textMuted }}>{row.count}</span>
                                                    {row.count > 0 && <span style={{ fontSize: 10, color: T.textMuted, display: 'block', marginTop: 1 }}>students</span>}
                                                </div>

                                                {/* Embedding status */}
                                                <div style={{ textAlign: 'center' }}>
                                                    {row.count === 0 ? (
                                                        <span className="status-pill na">No Photos</span>
                                                    ) : busy ? (
                                                        <span className="status-pill na">⏳ Generating…</span>
                                                    ) : summaryReady ? (
                                                        <>
                                                            <span style={{ fontSize: 16, fontWeight: 800, color: T.success }}>
                                                                {row.completedEmbeddingCount}
                                                            </span>
                                                            <span style={{ fontSize: 10, color: T.textMuted, display: 'block', marginTop: 1 }}>
                                                                of {row.count} completed
                                                            </span>
                                                        </>
                                                    ) : embOk ? (
                                                        <span className="status-pill ok">✓ Available</span>
                                                    ) : (
                                                        <span className="status-pill no">✗ Not Built</span>
                                                    )}
                                                </div>

                                                {/* Face-not-detected count */}
                                                <div style={{ textAlign: 'center' }}>
                                                    {row.count === 0 ? (
                                                        <span style={{ color: T.textMuted }}>—</span>
                                                    ) : busy ? (
                                                        <span className="status-pill na">Pending</span>
                                                    ) : !summaryReady ? (
                                                        <span className="status-pill na">Run regenerate</span>
                                                    ) : row.faceNotDetectedCount > 0 ? (
                                                        <div>
                                                            <span className="status-pill no" style={{ marginBottom: 5 }}>
                                                                {row.faceNotDetectedCount} student{row.faceNotDetectedCount !== 1 ? 's' : ''}
                                                            </span>
                                                            {failedRollNos.length > 0 && (
                                                                <div
                                                                    aria-label={`Face not detected roll numbers for ${row.batch}`}
                                                                    style={{
                                                                        display: 'flex',
                                                                        flexWrap: 'wrap',
                                                                        justifyContent: 'center',
                                                                        gap: 4,
                                                                        fontFamily: T.fontMono,
                                                                        fontSize: 10,
                                                                        fontWeight: 700,
                                                                        color: T.danger,
                                                                    }}
                                                                >
                                                                    {failedRollNos.map((failedRollNo) => (
                                                                        <span
                                                                            key={failedRollNo}
                                                                            style={{
                                                                                border: `1px solid ${T.danger}55`,
                                                                                borderRadius: 6,
                                                                                padding: '2px 6px',
                                                                                background: T.surface,
                                                                            }}
                                                                        >
                                                                            {failedRollNo}
                                                                        </span>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </div>
                                                    ) : (
                                                        <span className="status-pill ok">0</span>
                                                    )}
                                                </div>

                                                {/* Last updated */}
                                                <div style={{ fontSize: 12, color: lastDt ? T.text : T.textMuted }}>{fmtDate(lastDt)}</div>

                                                {/* Action */}
                                                <div style={{ textAlign: 'right' }}>
                                                    <button
                                                        disabled={busy || row.count === 0}
                                                        onClick={() => handleRegen(row.batch)}
                                                        title={`Regenerate embeddings for ${row.batch}`}
                                                        style={{
                                                            fontSize: 11, padding: '5px 12px', borderRadius: 6,
                                                            border: 'none', cursor: (busy || row.count === 0) ? 'not-allowed' : 'pointer',
                                                            background: (busy || row.count === 0) ? T.accentDim : T.accent,
                                                            color: (busy || row.count === 0) ? T.accent : '#fff',
                                                            fontWeight: 600, fontFamily: T.fontBody,
                                                            opacity: (busy || row.count === 0) ? 0.55 : 1,
                                                            transition: 'opacity .2s',
                                                            whiteSpace: 'nowrap',
                                                        }}
                                                    >
                                                        {busy ? '⏳ Building…' : '↺ Regenerate'}
                                                    </button>
                                                </div>
                                                    </div>
                                            </div>
                                        );
                                    })}
                                    </div>
                                </div>
                                );
                            });
                        })()
                    )}
                </>
            )}

            {/* ── Replace confirmation modal ─────────────────────────────────── */}
            {zipReplaceConfirm && (
                <div className="erp-modal-overlay">
                    <div className="erp-modal-box">
                        <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 8, fontFamily: T.fontBody }}>
                            Replace Existing Batch?
                        </div>
                        <div style={{ fontSize: 13.5, color: T.textMuted, lineHeight: 1.55, marginBottom: 22, fontFamily: T.fontBody }}>
                            Uploading a new ZIP file will replace the existing ERP photos and embeddings for this batch. Do you want to continue?
                        </div>
                        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                            <button
                                onClick={() => setZipReplaceConfirm(false)}
                                style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', color: '#475569', padding: '10px 16px', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: T.fontBody }}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={executeZipUpload}
                                style={{ background: '#ef4444', border: 'none', color: '#fff', padding: '10px 16px', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: T.fontBody }}
                            >
                                Yes, Replace
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Delete confirmation modal ─────────────────────────────────── */}
            {pendingDelete && (
                <div className="erp-modal-overlay">
                    <div className="erp-modal-box">
                        <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 8, fontFamily: T.fontBody }}>
                            Delete Student Photo
                        </div>
                        <div style={{ fontSize: 13.5, color: T.textMuted, lineHeight: 1.55, marginBottom: 22, fontFamily: T.fontBody }}>
                            Are you sure you want to delete the photo for <strong style={{ color: T.text, fontFamily: T.fontMono }}>{pendingDelete.rollNo}</strong>?
                            This will also remove any associated embeddings. This action cannot be undone.
                        </div>
                        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                            <button
                                onClick={() => setPendingDelete(null)}
                                style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', color: '#475569', padding: '10px 16px', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: T.fontBody }}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleConfirmedDelete}
                                disabled={deleting}
                                style={{ background: '#ef4444', border: 'none', color: '#fff', padding: '10px 16px', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: deleting ? 'not-allowed' : 'pointer', opacity: deleting ? 0.6 : 1, fontFamily: T.fontBody }}
                            >
                                {deleting ? 'Deleting…' : 'Yes, Delete'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {pendingDeleteAll && (
                <div className="erp-modal-overlay">
                    <div className="erp-modal-box">
                        <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 8, fontFamily: T.fontBody }}>
                            Delete ALL Photos
                        </div>
                        <div style={{ fontSize: 13.5, color: T.textMuted, lineHeight: 1.55, marginBottom: 22, fontFamily: T.fontBody }}>
                            Are you sure you want to delete <strong style={{ color: '#ef4444' }}>all {photos.length} photo{photos.length === 1 ? '' : 's'}</strong> for <strong style={{ color: T.text, fontFamily: T.fontMono }}>{batchName}</strong>?
                            This will also remove all associated embeddings for this batch. This action cannot be undone.
                        </div>
                        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                            <button
                                onClick={() => setPendingDeleteAll(false)}
                                style={{ background: '#f1f5f9', border: '1px solid #cbd5e1', color: '#475569', padding: '10px 16px', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: T.fontBody }}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleConfirmedDeleteAll}
                                disabled={deletingAll}
                                style={{ background: '#ef4444', border: 'none', color: '#fff', padding: '10px 16px', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: deletingAll ? 'not-allowed' : 'pointer', opacity: deletingAll ? 0.6 : 1, fontFamily: T.fontBody }}
                            >
                                {deletingAll ? 'Deleting…' : `Yes, Delete All ${photos.length}`}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
