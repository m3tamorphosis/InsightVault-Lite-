'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, FileText, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';

export default function UploadPage() {
    const router = useRouter();
    const [file, setFile] = useState<File | null>(null);
    const [status, setStatus] = useState<'idle' | 'uploading' | 'success' | 'error'>('idle');
    const [errorMsg, setErrorMsg] = useState('');
    const [isDragging, setIsDragging] = useState(false);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            setFile(e.target.files[0]);
            setStatus('idle');
        }
    };

    const handleUpload = async () => {
        if (!file) return;
        setStatus('uploading');

        try {
            const formData = new FormData();
            formData.append('file', file);

            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData,
            });

            const result = await response.json();

            if (response.ok) {
                setStatus('success');
                setTimeout(() => {
                    router.push(`/chat?fileId=${result.fileId}`);
                }, 1000);
            } else {
                throw new Error(result.error || 'Upload failed');
            }
        } catch (error: any) {
            console.error(error);
            setErrorMsg(error.message);
            setStatus('error');
        }
    };

    const isReady = !!file && status !== 'uploading';

    return (
        <div className="relative flex flex-col items-center justify-center min-h-screen overflow-hidden bg-[#09090b]">

            {/* Grid dot background */}
            <div className="absolute inset-0 bg-grid-dots opacity-60 pointer-events-none" />

            {/* Radial vignette */}
            <div
                className="absolute inset-0 pointer-events-none"
                style={{
                    background: 'radial-gradient(ellipse 80% 60% at 50% 40%, rgba(59,130,246,0.06) 0%, transparent 70%)',
                }}
            />

            {/* Card */}
            <div
                className="relative z-10 w-full max-w-[440px] mx-4 animate-float-up"
                style={{
                    background: 'rgba(18,18,20,0.97)',
                    border: '1px solid rgba(63,63,70,0.7)',
                    borderRadius: '16px',
                    boxShadow: '0 0 0 1px rgba(0,0,0,0.5), 0 24px 64px rgba(0,0,0,0.6)',
                }}
            >
                {/* Card top accent line */}
                <div
                    className="absolute top-0 left-8 right-8 h-px"
                    style={{ background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.5), transparent)' }}
                />

                <div className="px-8 pt-8 pb-7">

                    {/* Header */}
                    <div className="mb-7">
                        {/* Logo mark */}
                        <div className="flex items-center gap-2.5 mb-5">
                            <div
                                className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                                style={{
                                    background: 'rgba(59,130,246,0.15)',
                                    border: '1px solid rgba(59,130,246,0.3)',
                                }}
                            >
                                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                    <rect x="1" y="7" width="3" height="6" rx="0.5" fill="#3b82f6" />
                                    <rect x="5.5" y="4" width="3" height="9" rx="0.5" fill="#3b82f6" opacity="0.7" />
                                    <rect x="10" y="1" width="3" height="12" rx="0.5" fill="#3b82f6" opacity="0.45" />
                                </svg>
                            </div>
                            <span
                                className="text-[11px] font-medium tracking-[0.15em] uppercase"
                                style={{ fontFamily: 'var(--font-mono)', color: '#71717a' }}
                            >
                                InsightVault
                            </span>
                        </div>

                        <h1
                            className="text-[26px] font-semibold leading-tight mb-2"
                            style={{ color: '#f4f4f5', letterSpacing: '-0.02em' }}
                        >
                            Analyze your data<br />with natural language
                        </h1>
                        <p
                            className="text-sm leading-relaxed"
                            style={{ color: '#71717a' }}
                        >
                            Upload a CSV file and start asking questions. No SQL, no dashboards — just answers.
                        </p>
                    </div>

                    {/* Drop zone */}
                    <div
                        className="relative group mb-5"
                        onDragEnter={() => setIsDragging(true)}
                        onDragLeave={() => setIsDragging(false)}
                        onDragOver={e => e.preventDefault()}
                        onDrop={e => {
                            e.preventDefault();
                            setIsDragging(false);
                            const dropped = e.dataTransfer.files[0];
                            if (dropped && dropped.name.endsWith('.csv')) {
                                setFile(dropped);
                                setStatus('idle');
                            }
                        }}
                        style={{
                            borderRadius: '10px',
                            border: `1px dashed ${isDragging ? 'rgba(59,130,246,0.7)' : file ? 'rgba(59,130,246,0.4)' : 'rgba(63,63,70,0.8)'}`,
                            background: isDragging
                                ? 'rgba(59,130,246,0.06)'
                                : file
                                ? 'rgba(59,130,246,0.04)'
                                : 'rgba(24,24,27,0.5)',
                            transition: 'border-color 0.2s, background 0.2s',
                            boxShadow: isDragging ? 'var(--blue-glow)' : 'none',
                        }}
                    >
                        <input
                            type="file"
                            accept=".csv"
                            className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                            onChange={handleFileChange}
                        />

                        <div className="flex flex-col items-center justify-center py-9 px-4 text-center pointer-events-none select-none">
                            {file ? (
                                <>
                                    <div
                                        className="w-11 h-11 rounded-lg flex items-center justify-center mb-3"
                                        style={{
                                            background: 'rgba(59,130,246,0.12)',
                                            border: '1px solid rgba(59,130,246,0.25)',
                                        }}
                                    >
                                        <FileText className="w-5 h-5" style={{ color: '#3b82f6' }} />
                                    </div>
                                    <p className="text-sm font-medium mb-0.5" style={{ color: '#e4e4e7' }}>
                                        {file.name}
                                    </p>
                                    <p
                                        className="text-xs"
                                        style={{ fontFamily: 'var(--font-mono)', color: '#52525b' }}
                                    >
                                        {(file.size / 1024).toFixed(1)} KB — click to replace
                                    </p>
                                </>
                            ) : (
                                <>
                                    <div
                                        className="w-11 h-11 rounded-lg flex items-center justify-center mb-3"
                                        style={{
                                            background: 'rgba(39,39,42,0.8)',
                                            border: '1px solid rgba(63,63,70,0.6)',
                                        }}
                                    >
                                        <Upload className="w-5 h-5" style={{ color: '#52525b' }} />
                                    </div>
                                    <p className="text-sm font-medium mb-0.5" style={{ color: '#a1a1aa' }}>
                                        Drop your CSV file here
                                    </p>
                                    <p className="text-xs" style={{ color: '#52525b' }}>
                                        or click to browse — CSV files only
                                    </p>
                                </>
                            )}
                        </div>
                    </div>

                    {/* Upload button */}
                    <button
                        onClick={handleUpload}
                        disabled={!isReady}
                        className="w-full py-2.5 px-4 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 transition-all duration-200"
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
                                    background: '#2563eb',
                                    border: '1px solid rgba(59,130,246,0.4)',
                                    color: '#fff',
                                    boxShadow: '0 0 20px rgba(37,99,235,0.3)',
                                    cursor: 'pointer',
                                }
                                : {
                                    background: 'rgba(39,39,42,0.6)',
                                    border: '1px solid rgba(63,63,70,0.5)',
                                    color: '#3f3f46',
                                    cursor: 'not-allowed',
                                }
                        }
                    >
                        {status === 'uploading' ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Processing data...
                            </>
                        ) : status === 'success' ? (
                            <>
                                <CheckCircle className="w-4 h-4" />
                                Ready — redirecting...
                            </>
                        ) : (
                            'Start analyzing'
                        )}
                    </button>

                    {/* Error */}
                    {status === 'error' && (
                        <div
                            className="mt-3 px-3 py-2.5 rounded-lg flex items-start gap-2 text-xs animate-fade-in"
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
                        className="mt-6 pt-5 space-y-2.5"
                        style={{ borderTop: '1px solid rgba(39,39,42,0.8)' }}
                    >
                        {[
                            ['Ask questions in plain English', 'No SQL required'],
                            ['Instant visualizations', 'Charts generated automatically'],
                            ['Multi-dataset support', 'Compare across files'],
                        ].map(([label, sub]) => (
                            <div key={label} className="flex items-center gap-2.5">
                                <div
                                    className="w-1.5 h-1.5 rounded-full shrink-0"
                                    style={{ background: '#3b82f6' }}
                                />
                                <div>
                                    <span className="text-xs font-medium" style={{ color: '#a1a1aa' }}>
                                        {label}
                                    </span>
                                    <span className="text-xs ml-1.5" style={{ color: '#3f3f46' }}>
                                        {sub}
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* Footer */}
            <p
                className="relative z-10 mt-6 text-[11px]"
                style={{ fontFamily: 'var(--font-mono)', color: '#3f3f46' }}
            >
                InsightVault · CSV analytics via AI
            </p>
        </div>
    );
}
