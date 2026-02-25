'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, FileText, FileType, CheckCircle, AlertCircle, Loader2, BarChart2, FileSearch, Zap, X, ArrowRight } from 'lucide-react';

const ACCEPTED = '.csv,.pdf';
const APP_MAX_UPLOAD_MB = 20;
const APP_MAX_UPLOAD_BYTES = APP_MAX_UPLOAD_MB * 1024 * 1024;
const DEPLOY_SAFE_UPLOAD_MB = APP_MAX_UPLOAD_MB;
const DEPLOY_SAFE_UPLOAD_BYTES = DEPLOY_SAFE_UPLOAD_MB * 1024 * 1024;

function getFileKind(file: File): 'csv' | 'pdf' | null {
    const n = file.name.toLowerCase();
    if (n.endsWith('.csv')) return 'csv';
    if (n.endsWith('.pdf')) return 'pdf';
    return null;
}

const FEATURES = [
    { icon: BarChart2, label: 'CSV analytics', sub: 'Top-N, group-by, trends, aggregations' },
    { icon: FileSearch, label: 'PDF document Q&A', sub: 'Semantic search over text content' },
    { icon: Zap, label: 'Instant visualizations', sub: 'Charts generated automatically' },
];

type UploadResponse = {
    fileId?: string;
    fileType?: 'csv' | 'pdf';
    error?: string;
};

async function parseUploadResponse(response: Response): Promise<UploadResponse> {
    const raw = await response.text();
    let parsed: UploadResponse = {};
    if (raw) {
        try {
            parsed = JSON.parse(raw) as UploadResponse;
        } catch {
            parsed = { error: raw };
        }
    }

    if (response.ok) return parsed;

    const fromBody = typeof parsed.error === 'string' ? parsed.error : '';
    if (response.status === 413 || /request entity too large/i.test(fromBody)) {
        return { error: `Upload failed: deployment request-size limit reached. In this environment, keep files at ${DEPLOY_SAFE_UPLOAD_MB} MB or less.` };
    }
    return { error: fromBody || `Upload failed (HTTP ${response.status})` };
}

export default function UploadPage() {
    const router = useRouter();
    const [file, setFile] = useState<File | null>(null);
    const [status, setStatus] = useState<'idle' | 'uploading' | 'success' | 'error'>('idle');
    const [errorMsg, setErrorMsg] = useState('');
    const [sizeWarning, setSizeWarning] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [recentFiles, setRecentFiles] = useState<Array<{name: string; fileId: string; type: string; timestamp: number}>>([]);
    const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

    useEffect(() => {
        try {
            const raw = localStorage.getItem('iv_recent_files');
            if (raw) setRecentFiles(JSON.parse(raw));
        } catch { /* ignore */ }
    }, []);

    const removeRecentFile = (fileId: string) => {
        const updated = recentFiles.filter(f => f.fileId !== fileId);
        setRecentFiles(updated);
        setConfirmRemoveId(null);
        try { localStorage.setItem('iv_recent_files', JSON.stringify(updated)); } catch { /* ignore */ }
    };

    const validateAndSetFile = (f: File) => {
        const kind = getFileKind(f);
        if (!kind) return;
        setSizeWarning(null);
        const mb = f.size / 1_048_576;
        if (f.size > DEPLOY_SAFE_UPLOAD_BYTES) {
            setSizeWarning(`For deployed reliability, keep uploads at ${DEPLOY_SAFE_UPLOAD_MB} MB or less. This file is ${mb.toFixed(1)} MB.`);
            return;
        }
        if (f.size > APP_MAX_UPLOAD_BYTES) {
            setSizeWarning(`File is too large (${mb.toFixed(1)} MB) - max ${APP_MAX_UPLOAD_MB} MB.`);
            return;
        }
        if (kind === 'pdf' && f.size > 5_242_880) {
            setSizeWarning(`Large PDF (${mb.toFixed(1)} MB) — embedding may take 30–60 seconds.`);
        } else if (kind === 'csv' && f.size > 10_485_760) {
            setSizeWarning(`Large CSV (${mb.toFixed(1)} MB) — may take a few seconds to load.`);
        }
        setFile(f);
        setStatus('idle');
        setErrorMsg('');
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0];
        if (f) validateAndSetFile(f);
    };

    const handleUpload = async () => {
        if (!file) return;
        setStatus('uploading');
        try {
            const formData = new FormData();
            formData.append('file', file);
            const response = await fetch('/api/upload', { method: 'POST', body: formData });
            const result = await parseUploadResponse(response);
            if (response.ok) {
                if (!result.fileId) {
                    throw new Error('Upload succeeded but no file ID was returned');
                }
                const uploadedFileId = result.fileId;
                const uploadedFileType = result.fileType ?? 'csv';
                if ((result.fileType ?? 'csv') === 'pdf') {
                    try {
                        // Pass the original File object across client-side route transition.
                        // Chat page will create its own object URL from this file.
                        (window as unknown as { __ivPendingPdfFile?: { fileId: string; file: File } }).__ivPendingPdfFile = {
                            fileId: uploadedFileId,
                            file,
                        };
                        // Secondary fallback across route transition.
                        const blobUrl = URL.createObjectURL(file);
                        sessionStorage.setItem(`iv_pdf_blob_${uploadedFileId}`, blobUrl);
                    } catch { /* ignore */ }
                }
                setStatus('success');
                setTimeout(() => {
                    router.push(`/chat?fileId=${uploadedFileId}&type=${uploadedFileType}&name=${encodeURIComponent(file.name)}&fresh=1`);
                }, 1000);
            } else {
                throw new Error(result.error || 'Upload failed');
            }
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : 'Upload failed';
            setErrorMsg(msg);
            setStatus('error');
        }
    };

    const isReady = !!file && status !== 'uploading';
    const fileKind = file ? getFileKind(file) : null;
    const isPDF = fileKind === 'pdf';
    const isBlocked = !file && !!sizeWarning;

    return (
        <div
            className="relative flex flex-col items-center justify-center min-h-screen overflow-hidden"
            style={{ background: 'var(--bg-page)' }}
        >
            {/* Grid dot background */}
            <div className="absolute inset-0 bg-grid-dots opacity-30 pointer-events-none" />

            {/* Radial vignettes */}
            <div className="absolute inset-0 pointer-events-none" style={{
                background: 'radial-gradient(ellipse 70% 55% at 50% 35%, rgba(37,99,235,0.08) 0%, transparent 65%)',
            }} />
            <div className="absolute inset-0 pointer-events-none" style={{
                background: 'radial-gradient(ellipse 50% 35% at 50% 100%, rgba(124,58,237,0.05) 0%, transparent 65%)',
            }} />
            <div className="absolute inset-0 pointer-events-none" style={{
                background: 'radial-gradient(ellipse 30% 20% at 15% 20%, rgba(59,130,246,0.04) 0%, transparent 70%)',
            }} />

            {/* Card */}
            <div
                className="relative z-10 w-full max-w-[440px] mx-4 animate-float-up"
                style={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-strong)',
                    borderRadius: '20px',
                    boxShadow: '0 0 0 1px rgba(0,0,0,0.3), 0 40px 100px rgba(0,0,0,0.6), 0 0 80px rgba(59,130,246,0.07)',
                }}
            >
                {/* Top accent line */}
                <div className="absolute top-0 left-10 right-10 h-px" style={{
                    background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.6), rgba(139,92,246,0.4), transparent)',
                }} />

                <div className="px-8 pt-8 pb-7">

                    {/* Header */}
                    <div className="mb-7">
                        <div className="flex items-center gap-2.5 mb-5">
                            <div
                                className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                                style={{ background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.3)' }}
                            >
                                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <defs>
                                        <linearGradient id="up-g1" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="0%" stopColor="#60a5fa" />
                                            <stop offset="100%" stopColor="#2563eb" />
                                        </linearGradient>
                                        <linearGradient id="up-g2" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="0%" stopColor="#818cf8" />
                                            <stop offset="100%" stopColor="#3b82f6" />
                                        </linearGradient>
                                        <linearGradient id="up-g3" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="0%" stopColor="#a78bfa" />
                                            <stop offset="100%" stopColor="#7c3aed" />
                                        </linearGradient>
                                    </defs>
                                    <rect x="1"    y="9"   width="3.5" height="6.5"  rx="1.1" fill="url(#up-g1)" />
                                    <rect x="6.25" y="5.5" width="3.5" height="10"   rx="1.1" fill="url(#up-g2)" />
                                    <rect x="11.5" y="2"   width="3.5" height="13.5" rx="1.1" fill="url(#up-g3)" />
                                </svg>
                            </div>
                            <span
                                className="text-[11px] font-medium tracking-[0.15em] uppercase"
                                style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}
                            >
                                InsightVault
                            </span>
                        </div>

                        <h1 className="text-[27px] font-semibold leading-tight mb-2" style={{ letterSpacing: '-0.025em' }}>
                            <span style={{ color: 'var(--text-primary)' }}>Analyze your data</span>
                            <br />
                            <span style={{
                                background: 'linear-gradient(135deg, #60a5fa 0%, #a78bfa 100%)',
                                WebkitBackgroundClip: 'text',
                                WebkitTextFillColor: 'transparent',
                                backgroundClip: 'text',
                            }}>
                                with natural language
                            </span>
                        </h1>
                        <p className="text-sm leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                            Drop in a spreadsheet or document and ask anything — InsightVault handles the analysis for you.
                        </p>
                    </div>

                    {/* Drop zone */}
                    <div
                        className="relative group mb-4"
                        onDragEnter={() => setIsDragging(true)}
                        onDragLeave={() => setIsDragging(false)}
                        onDragOver={e => e.preventDefault()}
                        onDrop={e => {
                            e.preventDefault();
                            setIsDragging(false);
                            const dropped = e.dataTransfer.files[0];
                            if (dropped) validateAndSetFile(dropped);
                        }}
                        style={{
                            borderRadius: '12px',
                            border: `1px dashed ${isDragging ? 'rgba(59,130,246,0.7)' : file ? 'rgba(59,130,246,0.45)' : isBlocked ? 'rgba(239,68,68,0.4)' : 'var(--border-strong-2)'}`,
                            background: isDragging
                                ? 'rgba(59,130,246,0.06)'
                                : file ? 'rgba(59,130,246,0.04)'
                                : 'var(--bg-element-2)',
                            transition: 'border-color 0.2s, background 0.2s',
                            boxShadow: isDragging ? 'var(--blue-glow), inset 0 0 40px rgba(59,130,246,0.04)' : 'none',
                        }}
                    >
                        <input
                            type="file"
                            accept={ACCEPTED}
                            className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                            onChange={handleFileChange}
                        />

                        {/* Remove file button */}
                        {file && (
                            <button
                                type="button"
                                onClick={e => { e.stopPropagation(); setFile(null); setStatus('idle'); setErrorMsg(''); setSizeWarning(null); }}
                                className="absolute top-2.5 right-2.5 z-10 w-6 h-6 rounded-lg flex items-center justify-center transition-all duration-150 pointer-events-auto"
                                title="Remove file"
                                style={{
                                    background: 'rgba(239,68,68,0.1)',
                                    border: '1px solid rgba(239,68,68,0.2)',
                                    color: '#f87171',
                                }}
                                onMouseEnter={e => {
                                    (e.currentTarget as HTMLButtonElement).style.background = 'rgba(239,68,68,0.18)';
                                    (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(239,68,68,0.4)';
                                }}
                                onMouseLeave={e => {
                                    (e.currentTarget as HTMLButtonElement).style.background = 'rgba(239,68,68,0.1)';
                                    (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(239,68,68,0.2)';
                                }}
                            >
                                <X className="w-3 h-3" />
                            </button>
                        )}

                        <div className="flex flex-col items-center justify-center py-9 px-4 text-center pointer-events-none select-none">
                            {file ? (
                                <>
                                    <div
                                        className="w-12 h-12 rounded-xl flex items-center justify-center mb-3"
                                        style={{
                                            background: 'rgba(59,130,246,0.12)',
                                            border: '1px solid rgba(59,130,246,0.25)',
                                            boxShadow: '0 0 20px rgba(59,130,246,0.1)',
                                        }}
                                    >
                                        {isPDF
                                            ? <FileType className="w-5 h-5" style={{ color: '#60a5fa' }} />
                                            : <FileText className="w-5 h-5" style={{ color: '#60a5fa' }} />
                                        }
                                    </div>
                                    <p className="text-sm font-semibold mb-0.5" style={{ color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
                                        {file.name}
                                    </p>
                                    <p className="text-xs" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>
                                        {(file.size / 1024).toFixed(1)} KB · {isPDF ? 'PDF document' : 'CSV spreadsheet'} — click to replace
                                    </p>
                                </>
                            ) : (
                                <>
                                    <div
                                        className="w-12 h-12 rounded-xl flex items-center justify-center mb-3"
                                        style={{
                                            background: 'var(--bg-muted-2)',
                                            border: '1px solid var(--border-strong)',
                                        }}
                                    >
                                        <Upload className="w-5 h-5" style={{ color: 'var(--text-faint)' }} />
                                    </div>
                                    <p className="text-sm font-medium mb-0.5" style={{ color: 'var(--text-muted)' }}>
                                        Drop your file here
                                    </p>
                                    <p className="text-xs" style={{ color: 'var(--text-faint)' }}>
                                        or click to browse · CSV or PDF · max 20 MB
                                    </p>
                                </>
                            )}
                        </div>
                    </div>

                    {/* Size warning */}
                    {sizeWarning && (
                        <div
                            className="mb-3 px-3 py-2.5 rounded-xl flex items-start gap-2 text-xs animate-fade-in"
                            style={{
                                background: isBlocked ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.08)',
                                border: `1px solid ${isBlocked ? 'rgba(239,68,68,0.2)' : 'rgba(245,158,11,0.2)'}`,
                                color: isBlocked ? '#f87171' : '#fbbf24',
                            }}
                        >
                            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
                            <span>{sizeWarning}</span>
                        </div>
                    )}

                    {/* Upload button */}
                    <button
                        onClick={handleUpload}
                        disabled={!isReady}
                        className="w-full py-2.5 px-4 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-all duration-200"
                        style={
                            status === 'success'
                                ? {
                                    background: 'rgba(34,197,94,0.15)',
                                    border: '1px solid rgba(34,197,94,0.3)',
                                    color: '#4ade80',
                                    cursor: 'default',
                                }
                                : isReady
                                ? {
                                    background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
                                    border: '1px solid rgba(59,130,246,0.4)',
                                    color: '#fff',
                                    boxShadow: '0 0 24px rgba(37,99,235,0.4), 0 4px 12px rgba(37,99,235,0.2)',
                                    cursor: 'pointer',
                                }
                                : {
                                    background: 'var(--bg-muted-3)',
                                    border: '1px solid var(--border-strong)',
                                    color: 'var(--text-ghost)',
                                    cursor: 'not-allowed',
                                }
                        }
                    >
                        {status === 'uploading' ? (
                            <><Loader2 className="w-4 h-4 animate-spin" />{isPDF ? 'Embedding document…' : 'Loading data…'}</>
                        ) : status === 'success' ? (
                            <><CheckCircle className="w-4 h-4" />Ready — redirecting…</>
                        ) : (
                            'Start analyzing →'
                        )}
                    </button>

                    {/* Upload error */}
                    {status === 'error' && (
                        <div
                            className="mt-3 px-3 py-2.5 rounded-xl flex items-start gap-2 text-xs animate-fade-in"
                            style={{
                                background: 'rgba(239,68,68,0.08)',
                                border: '1px solid rgba(239,68,68,0.2)',
                                color: '#f87171',
                            }}
                        >
                            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
                            <span>{errorMsg || 'Upload failed. Please try again.'}</span>
                        </div>
                    )}

                    {/* Feature list */}
                    <div
                        className="mt-6 pt-5 space-y-3"
                        style={{ borderTop: '1px solid var(--border-default)' }}
                    >
                        {FEATURES.map(({ icon: Icon, label, sub }) => (
                            <div key={label} className="flex items-start gap-3">
                                <div
                                    className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-px"
                                    style={{
                                        background: 'rgba(59,130,246,0.1)',
                                        border: '1px solid rgba(59,130,246,0.15)',
                                    }}
                                >
                                    <Icon className="w-3 h-3" style={{ color: '#60a5fa' }} />
                                </div>
                                <div>
                                    <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                                        {label}
                                    </span>
                                    <span className="text-xs ml-1.5" style={{ color: 'var(--text-ghost)' }}>
                                        {sub}
                                    </span>
                                </div>
                            </div>
                        ))}

                        {/* Recent files */}
                        {recentFiles.length > 0 && (
                            <div className="mt-5">
                                <p className="text-[11px] uppercase tracking-widest mb-2.5" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-ghost)' }}>Recent</p>
                                <div className="space-y-1.5">
                                    {recentFiles.slice(0, 5).map(f => (
                                        <div
                                            key={f.fileId}
                                            className="group flex items-center gap-2.5 px-3 py-2 rounded-xl transition-all duration-150"
                                            style={{ background: 'var(--bg-element)', border: '1px solid var(--border-default)' }}
                                            onMouseEnter={e => { if (confirmRemoveId !== f.fileId) (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(59,130,246,0.4)'; }}
                                            onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-default)'; }}
                                        >
                                            {confirmRemoveId === f.fileId ? (
                                                /* Inline confirm */
                                                <div className="flex-1 flex items-center gap-2">
                                                    <span className="text-xs flex-1" style={{ color: 'var(--text-muted)' }}>Remove from recent?</span>
                                                    <button
                                                        onClick={() => removeRecentFile(f.fileId)}
                                                        className="text-[11px] px-2 py-0.5 rounded-md font-medium"
                                                        style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171' }}
                                                    >
                                                        Remove
                                                    </button>
                                                    <button
                                                        onClick={() => setConfirmRemoveId(null)}
                                                        className="text-[11px] px-2 py-0.5 rounded-md font-medium"
                                                        style={{ background: 'var(--bg-muted)', border: '1px solid var(--border-strong)', color: 'var(--text-ghost)' }}
                                                    >
                                                        Cancel
                                                    </button>
                                                </div>
                                            ) : (
                                                <>
                                                    {/* Clickable file area */}
                                                    <button
                                                        onClick={() => router.push(`/chat?fileId=${f.fileId}&type=${f.type}&name=${encodeURIComponent(f.name)}`)}
                                                        className="flex-1 flex items-center gap-2.5 text-left min-w-0"
                                                        style={{ color: 'var(--text-muted)', background: 'none', border: 'none', padding: 0 }}
                                                    >
                                                        {f.type === 'pdf'
                                                            ? <FileType className="w-3.5 h-3.5 shrink-0" style={{ color: '#f59e0b' }} />
                                                            : <FileText className="w-3.5 h-3.5 shrink-0" style={{ color: '#3b82f6' }} />
                                                        }
                                                        <span className="flex-1 text-xs truncate" style={{ color: 'var(--text-muted)' }}>{f.name}</span>
                                                        <span className="text-[10px] uppercase shrink-0 mr-1" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-ghost)' }}>
                                                            {f.type}
                                                        </span>
                                                        <ArrowRight className="w-3 h-3 shrink-0" style={{ color: 'var(--text-faint)' }} />
                                                    </button>

                                                    {/* Remove button → triggers inline confirm */}
                                                    <button
                                                        onClick={e => { e.stopPropagation(); setConfirmRemoveId(f.fileId); }}
                                                        title="Remove from recent"
                                                        className="shrink-0 w-5 h-5 rounded-md flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-150"
                                                        style={{ color: 'var(--text-faint)', background: 'transparent' }}
                                                        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#f87171'; (e.currentTarget as HTMLButtonElement).style.background = 'rgba(239,68,68,0.1)'; }}
                                                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-faint)'; (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
                                                    >
                                                        <X className="w-3 h-3" />
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Footer */}
            <p
                className="relative z-10 mt-6 text-[11px]"
                style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-ghost)' }}
            >
                InsightVault · CSV & PDF analytics via AI
            </p>
        </div>
    );
}
