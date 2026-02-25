'use client';

import React, { useState, useRef, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Send, Loader2, Sparkles, AlertCircle, Plus, X, FileText, FileType, Eye, Hash, TrendingUp, BookOpen, ArrowLeft, Copy, Check, Trash2, Download, ChevronDown, Pin, Table2 } from 'lucide-react';
import {
    BarChart, Bar, LineChart, Line,
    PieChart, Pie, Cell, ScatterChart, Scatter, ZAxis,
    XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, LabelList
} from 'recharts';
import type { ChartData } from '@/app/api/chat/route';

// ── Markdown helpers ───────────────────────────────────────────────────────

function inlineMarkdown(text: string): React.ReactNode {
    const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
    return parts.map((part, i) => {
        if (/^\*\*[^*]+\*\*$/.test(part)) {
            return <strong key={i} style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{part.slice(2, -2)}</strong>;
        }
        if (/^\*[^*]+\*$/.test(part)) {
            return <em key={i}>{part.slice(1, -1)}</em>;
        }
        if (/^`[^`]+`$/.test(part)) {
            return <code key={i} className="iv-code">{part.slice(1, -1)}</code>;
        }
        return part;
    });
}

function parseTableRow(row: string): string[] {
    return row.split('|').filter((_, i, a) => i > 0 && i < a.length - 1).map(c => c.trim());
}

function isSeparatorRow(line: string): boolean {
    return /^\|[\s\-:|]+\|/.test(line.trim());
}

function friendlyError(raw: string): string {
    if (!raw || raw === 'Unknown error') return 'Something went wrong. Please try again.';
    if (/network|failed to fetch|ERR_/i.test(raw)) return "Can't reach the server — check your connection and try again.";
    if (/file not found|inaccessible/i.test(raw)) return "This file couldn't be loaded — try re-uploading it.";
    if (/rate.?limit|429/i.test(raw)) return 'Too many requests — wait a moment and try again.';
    if (/timeout/i.test(raw)) return 'Request timed out — try asking a shorter question.';
    if (/csv files only/i.test(raw)) return 'This operation only works with CSV files.';
    return raw;
}

function renderMarkdown(text: string) {
    const lines = text.split('\n');
    const elements: React.ReactNode[] = [];
    let listItems: string[] = [];
    let tableLines: string[] = [];

    const flushList = (key: string) => {
        if (listItems.length) {
            elements.push(
                <ul key={key} className="my-2 space-y-1 pl-4">
                    {listItems.map((item, i) => (
                        <li key={i} className="flex gap-2 items-start">
                            <span style={{ color: '#3b82f6', marginTop: '0.35em', flexShrink: 0 }}>›</span>
                            <span>{inlineMarkdown(item)}</span>
                        </li>
                    ))}
                </ul>
            );
            listItems = [];
        }
    };

    const flushTable = (key: string) => {
        if (tableLines.length < 2) {
            tableLines.forEach((l, i) => elements.push(<p key={`${key}-${i}`}>{inlineMarkdown(l)}</p>));
            tableLines = [];
            return;
        }
        const headers = parseTableRow(tableLines[0]);
        // Skip separator row (index 1), get data rows
        const dataRows = tableLines
            .slice(1)
            .filter(l => !isSeparatorRow(l))
            .map(parseTableRow);

        elements.push(
            <div key={key} className="mt-3 rounded-xl overflow-hidden" style={{ border: '1px solid var(--border-default)', background: 'var(--bg-card)' }}>
                {/* Table header bar */}
                <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: '1px solid var(--border-default)', background: 'var(--bg-element)' }}>
                    <span className="text-[10px] uppercase tracking-widest font-medium" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
                        Data Table
                    </span>
                    <span className="text-[10px]" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-ghost)' }}>
                        {dataRows.length} rows · {headers.length} columns
                    </span>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full" style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', borderCollapse: 'collapse' }}>
                        <thead>
                            <tr style={{ background: 'var(--bg-muted)' }}>
                                {headers.map((h, hi) => (
                                    <th key={hi} className="text-left font-medium" style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap', padding: '8px 16px', borderBottom: '1px solid var(--border-default)' }}>
                                        {h}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {dataRows.map((row, ri) => (
                                <tr key={ri} style={{ background: ri % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)' }}>
                                    {row.map((cell, ci) => (
                                        <td key={ci} style={{
                                            padding: '7px 16px',
                                            color: 'var(--text-muted)',
                                            maxWidth: '200px',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                            borderBottom: ri < dataRows.length - 1 ? '1px solid var(--border-default)' : 'none',
                                        }}>
                                            {cell || <span style={{ color: 'var(--text-faint)', fontStyle: 'italic' }}>—</span>}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        );
        tableLines = [];
    };

    lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 1) {
            flushList(`fl-${i}`);
            tableLines.push(trimmed);
        } else {
            if (tableLines.length > 0) flushTable(`tbl-${i}`);
            if (/^#{1,3}\s/.test(line)) {
                flushList(`fl-${i}`);
                const content = line.replace(/^#{1,3}\s/, '');
                elements.push(
                    <p key={i} className="font-semibold mt-3 mb-1 text-[13px]" style={{ color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
                        {inlineMarkdown(content)}
                    </p>
                );
            } else if (/^[-*•]\s/.test(line)) {
                listItems.push(line.replace(/^[-*•]\s/, ''));
            } else if (/^\d+\.\s/.test(line)) {
                listItems.push(line.replace(/^\d+\.\s/, ''));
            } else if (line.trim() === '') {
                flushList(`fl-${i}`);
                if (elements.length > 0) elements.push(<div key={i} className="h-1.5" />);
            } else {
                flushList(`fl-${i}`);
                elements.push(<p key={i}>{inlineMarkdown(line)}</p>);
            }
        }
    });
    if (tableLines.length > 0) flushTable('tbl-final');
    flushList('final');
    return elements;
}

// ── Chart renderer ────────────────────────────────────────────────────────

const PIE_COLORS = ['#3b82f6','#8b5cf6','#06b6d4','#10b981','#f59e0b','#ef4444','#ec4899','#6366f1'];

function ChartView({ chart }: { chart: ChartData }) {
    const margin = { top: 6, right: 8, left: 0, bottom: 50 };
    const tickStyle = { fontSize: 10, fill: 'var(--text-dim)', fontFamily: 'var(--font-mono)' };
    const tooltipStyle = {
        fontSize: 12,
        borderRadius: 8,
        border: '1px solid var(--border-strong-2)',
        background: 'var(--bg-card)',
        color: 'var(--text-secondary)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
    };

    if (chart.type === 'pie') {
        return (
            <div className="mt-3 w-full px-3 pt-3 pb-1" style={{borderRadius:'12px', border:'1px solid var(--border-default)', background:'var(--bg-card)'}}>
                <p className="text-[10px] px-0.5 mb-2 uppercase tracking-widest" style={{fontFamily:'var(--font-mono)', color:'var(--text-ghost)'}}>{chart.title}</p>
                <ResponsiveContainer width="100%" height={280}>
                    <PieChart margin={{ top: 30, right: 70, bottom: 30, left: 70 }}>
                        <Pie
                            data={chart.data}
                            dataKey={chart.yKey}
                            nameKey={chart.xKey}
                            cx="50%" cy="50%"
                            outerRadius={75} innerRadius={32}
                            paddingAngle={2}
                            label={({ name, percent }: { name?: string; percent?: number }) =>
                                (percent ?? 0) >= 0.04 ? `${String(name ?? '').slice(0, 16)} ${((percent ?? 0) * 100).toFixed(0)}%` : ''
                            }
                            labelLine={{ stroke: 'var(--text-faint)', strokeWidth: 1 }}
                        >
                            {chart.data.map((_: Record<string, unknown>, index: number) => (
                                <Cell key={index} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                            ))}
                        </Pie>
                        <Tooltip contentStyle={tooltipStyle} />
                    </PieChart>
                </ResponsiveContainer>
            </div>
        );
    }

    if (chart.type === 'scatter') {
        return (
            <div className="mt-3 w-full px-3 pt-3 pb-1" style={{borderRadius:'12px', border:'1px solid var(--border-default)', background:'var(--bg-card)'}}>
                <p className="text-[10px] px-0.5 mb-2 uppercase tracking-widest" style={{fontFamily:'var(--font-mono)', color:'var(--text-ghost)'}}>{chart.title}</p>
                <ResponsiveContainer width="100%" height={210}>
                    <ScatterChart margin={margin}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-strong)" />
                        <XAxis dataKey={chart.xKey} tick={tickStyle} name={chart.xKey} />
                        <YAxis dataKey={chart.yKey} tick={tickStyle} width={44} name={chart.yKey} />
                        <ZAxis range={[40, 40]} />
                        <Tooltip contentStyle={tooltipStyle} cursor={{ strokeDasharray: '3 3' }} />
                        <Scatter data={chart.data} fill="#3b82f6" opacity={0.7}>
                            <LabelList dataKey={chart.xKey} position="top" style={{ fontSize: 9, fill: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }} formatter={(v: unknown) => (typeof v === 'number' ? v.toLocaleString() : String(v ?? ''))} />
                        </Scatter>
                    </ScatterChart>
                </ResponsiveContainer>
            </div>
        );
    }

    return (
        <div className="mt-3 w-full px-3 pt-3 pb-1" style={{ borderRadius: '12px', border: '1px solid var(--border-default)', background: 'var(--bg-card)' }}>
            <p className="text-[10px] px-0.5 mb-2 uppercase tracking-widest" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-ghost)' }}>
                {chart.title}
            </p>
            <ResponsiveContainer width="100%" height={210}>
                {chart.type === 'bar' ? (
                    <BarChart data={chart.data} margin={margin}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-strong)" vertical={false} />
                        <XAxis dataKey={chart.xKey} tick={tickStyle} angle={-35} textAnchor="end" interval={0} />
                        <YAxis tick={tickStyle} width={44} />
                        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgba(59,130,246,0.05)' }} />
                        <Bar dataKey={chart.yKey} fill="#2563eb" radius={[3, 3, 0, 0]} maxBarSize={40}>
                            <LabelList dataKey={chart.yKey} position="top" style={{ fontSize: 9, fill: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }} formatter={(v: unknown) => (typeof v === 'number' ? v.toLocaleString() : String(v ?? ''))} />
                        </Bar>
                    </BarChart>
                ) : (
                    <LineChart data={chart.data} margin={margin}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-strong)" vertical={false} />
                        <XAxis dataKey={chart.xKey} tick={tickStyle} angle={-35} textAnchor="end" interval={0} />
                        <YAxis tick={tickStyle} width={44} />
                        <Tooltip contentStyle={tooltipStyle} />
                        <Line type="monotone" dataKey={chart.yKey} stroke="#3b82f6" strokeWidth={2}
                            dot={{ r: 3, fill: '#3b82f6', strokeWidth: 0 }}
                            activeDot={{ r: 5, fill: '#60a5fa' }}
                        >
                            <LabelList dataKey={chart.yKey} position="top" style={{ fontSize: 9, fill: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }} formatter={(v: unknown) => (typeof v === 'number' ? v.toLocaleString() : String(v ?? ''))} />
                        </Line>
                    </LineChart>
                )}
            </ResponsiveContainer>
        </div>
    );
}

// ── Types ─────────────────────────────────────────────────────────────────

interface Dataset { fileId: string; name: string; type: 'csv' | 'pdf'; }
interface Message {
    role: 'user' | 'assistant';
    content: string;
    isError?: boolean;
    sources?: string[];
    context?: string;
    chartData?: ChartData;
    datasetName?: string;
    pinned?: boolean;
    isAutoPreview?: boolean;
    previewData?: {
        headers: string[];
        rows: string[][];
        stats: Array<{ field: string; min: number; max: number; avg: number; nullCount: number; total: number }>;
    };
}

const FALLBACK_CSV = [
    'What are the top 5 rows by value?',
    'Show me a chart of totals by category',
    'What is the average across all records?',
    'Find any outliers or anomalies',
];
const FALLBACK_PDF = [
    'What is this document about?',
    'Summarise the key points',
    'What are the main conclusions?',
    'Find any specific numbers or statistics',
];

const SUGGESTION_META = [
    { label: 'overview', icon: Eye },
    { label: 'details', icon: BookOpen },
    { label: 'numbers', icon: Hash },
    { label: 'insights', icon: TrendingUp },
];
const RECOMMENDED_DEPLOY_MAX_MB = 20;
const RECOMMENDED_DEPLOY_MAX_BYTES = RECOMMENDED_DEPLOY_MAX_MB * 1024 * 1024;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const CHAT_STORAGE_KEY = (fileId: string) => `iv_chat_${fileId}`;

function defaultAssistantGreeting(fileType?: 'csv' | 'pdf' | null): string {
    if (fileType === 'pdf') {
        return "Hello! I'm InsightVault. Ask me anything about your uploaded document.";
    }
    if (fileType === 'csv') {
        return "Hello! I'm InsightVault. Ask me anything about your uploaded dataset.";
    }
    return "Hello! I'm InsightVault. Ask me anything about your uploaded file.";
}

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
        return { error: `Upload failed: file is too large for this deployment limit. Recommended: ${RECOMMENDED_DEPLOY_MAX_MB} MB or less.` };
    }
    return { error: fromBody || `Upload failed (HTTP ${response.status})` };
}

function defaultMessages(fileType?: 'csv' | 'pdf' | null): Message[] {
    return [{ role: 'assistant', content: defaultAssistantGreeting(fileType) }];
}

function loadStoredChat(fileId: string | null): { messages: Message[]; datasets: Dataset[] } | null {
    if (!fileId || typeof window === 'undefined') return null;
    try {
        const raw = localStorage.getItem(`iv_chat_${fileId}`);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { messages: Message[]; datasets: Dataset[]; savedAt: number };
        if (Date.now() - parsed.savedAt > 7 * 24 * 60 * 60 * 1000) {
            localStorage.removeItem(`iv_chat_${fileId}`);
            return null;
        }
        // Do not replay auto-generated CSV preview cards when reopening recent files.
        const sanitizedMessages = (parsed.messages ?? []).filter(
            m => !(m.isAutoPreview && m.previewData && !m.content?.trim())
        );
        return { messages: sanitizedMessages, datasets: parsed.datasets };
    } catch { return null; }
}

function saveRecentFile(name: string, fileId: string, type: 'csv' | 'pdf') {
    if (typeof window === 'undefined') return;
    try {
        const key = 'iv_recent_files';
        const existing = JSON.parse(localStorage.getItem(key) ?? '[]') as Array<{name: string; fileId: string; type: string; timestamp: number}>;
        const updated = [
            { name, fileId, type, timestamp: Date.now() },
            ...existing.filter(f => f.fileId !== fileId),
        ].slice(0, 10);
        localStorage.setItem(key, JSON.stringify(updated));
    } catch { /* ignore */ }
}

// ── Logo SVG ──────────────────────────────────────────────────────────────

function Logo({ size = 13 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <linearGradient id="iv-g1" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#60a5fa" />
                    <stop offset="100%" stopColor="#2563eb" />
                </linearGradient>
                <linearGradient id="iv-g2" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#818cf8" />
                    <stop offset="100%" stopColor="#3b82f6" />
                </linearGradient>
                <linearGradient id="iv-g3" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#a78bfa" />
                    <stop offset="100%" stopColor="#7c3aed" />
                </linearGradient>
            </defs>
            <rect x="1"    y="9"   width="3.5" height="6.5"  rx="1.1" fill="url(#iv-g1)" />
            <rect x="6.25" y="5.5" width="3.5" height="10"   rx="1.1" fill="url(#iv-g2)" />
            <rect x="11.5" y="2"   width="3.5" height="13.5" rx="1.1" fill="url(#iv-g3)" />
        </svg>
    );
}

// ── PDF Panel ─────────────────────────────────────────────────────────────

function PdfPanel({
    pdfUrl,
    onClose,
    onOpenFile,
}: {
    pdfUrl: string | null;
    onClose: () => void;
    onOpenFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
    const [hasLoadError, setHasLoadError] = useState(false);
    useEffect(() => { setHasLoadError(false); }, [pdfUrl]);

    return (
        <div className="flex flex-col h-full">
            {/* Panel header */}
            <div
                className="flex items-center justify-between px-4 py-2.5 shrink-0"
                style={{ borderBottom: '1px solid var(--border-default)', background: 'var(--bg-element)' }}
            >
                <div className="flex items-center gap-2">
                    <FileType className="w-3.5 h-3.5" style={{ color: '#60a5fa' }} />
                    <span className="text-[11px] uppercase tracking-widest font-medium" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
                        PDF Viewer
                    </span>
                </div>
                <button
                    onClick={onClose}
                    className="w-6 h-6 rounded-md flex items-center justify-center transition-all"
                    style={{ color: 'var(--text-faint)', background: 'transparent' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-dim)'; (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-muted)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-faint)'; (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>

            {/* Content */}
            {pdfUrl && !hasLoadError ? (
                <iframe
                    src={pdfUrl}
                    className="flex-1 w-full border-none"
                    title="PDF viewer"
                    onError={() => setHasLoadError(true)}
                />
            ) : (
                <div className="flex-1 flex flex-col items-center justify-center gap-4 px-8">
                    <div
                        className="w-14 h-14 rounded-2xl flex items-center justify-center"
                        style={{ background: 'var(--bg-element)', border: '1px solid var(--border-strong)' }}
                    >
                        <FileType className="w-6 h-6" style={{ color: 'var(--text-dim)' }} />
                    </div>
                    <div className="text-center">
                        <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)', letterSpacing: '-0.01em' }}>
                            {hasLoadError ? 'Could not load PDF preview' : 'No PDF preview available'}
                        </p>
                        <p className="text-[12px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                            {hasLoadError
                                ? 'Re-open the PDF file to refresh local preview, or upload again.'
                                : 'Upload the PDF file here to view it alongside the chat'}
                        </p>
                    </div>
                    <label
                        className="flex items-center gap-2 text-xs font-medium px-4 py-2 rounded-lg cursor-pointer transition-all"
                        style={{ background: 'rgba(37,99,235,0.12)', border: '1px solid rgba(59,130,246,0.35)', color: '#60a5fa' }}
                        onMouseEnter={e => { const el = e.currentTarget as HTMLLabelElement; el.style.background = 'rgba(37,99,235,0.2)'; el.style.borderColor = 'rgba(59,130,246,0.55)'; }}
                        onMouseLeave={e => { const el = e.currentTarget as HTMLLabelElement; el.style.background = 'rgba(37,99,235,0.12)'; el.style.borderColor = 'rgba(59,130,246,0.35)'; }}
                    >
                        <input type="file" accept=".pdf" className="hidden" onChange={onOpenFile} />
                        <Plus className="w-3.5 h-3.5" /> Open PDF
                    </label>
                </div>
            )}
        </div>
    );
}

// ── CSV Preview Panel ─────────────────────────────────────────────────────

type PreviewData = {
    headers: string[];
    rows: string[][];
    stats: Array<{ field: string; min: number; max: number; avg: number; nullCount: number; total: number }>;
    totalRows?: number;
};

function CsvPanel({ data, name, fileId, onClose }: { data: PreviewData | null; name: string; fileId?: string; onClose: () => void }) {
    const PAGE_SIZE = 20;
    const [page, setPage] = useState(0);
    const [pageRows, setPageRows] = useState<string[][] | null>(null);
    const [isLoadingPage, setIsLoadingPage] = useState(false);

    // Reset pagination when data changes (new file loaded)
    useEffect(() => { setPage(0); setPageRows(null); }, [data]);

    const totalRows = data?.totalRows ?? 0;
    const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
    const displayRows = pageRows ?? data?.rows ?? [];

    const goToPage = async (newPage: number) => {
        if (!fileId || newPage < 0 || newPage >= totalPages) return;
        setIsLoadingPage(true);
        try {
            const r = await fetch(`/api/preview?fileId=${fileId}&page=${newPage}&pageSize=${PAGE_SIZE}`);
            const pd = await r.json();
            if (Array.isArray(pd.rows)) { setPageRows(pd.rows); setPage(newPage); }
        } catch { /* silent */ }
        finally { setIsLoadingPage(false); }
    };

    const rowStart = totalRows > 0 ? page * PAGE_SIZE + 1 : 0;
    const rowEnd = Math.min((page + 1) * PAGE_SIZE, totalRows);

    return (
        <div className="flex flex-col h-full">
            {/* Panel header */}
            <div
                className="flex items-center justify-between px-4 py-2.5 shrink-0"
                style={{ borderBottom: '1px solid var(--border-default)', background: 'var(--bg-element)' }}
            >
                <div className="flex items-center gap-2">
                    <Table2 className="w-3.5 h-3.5" style={{ color: '#60a5fa' }} />
                    <span className="text-[11px] uppercase tracking-widest font-medium" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
                        Data Preview
                    </span>
                    {data && totalRows > 0 && (
                        <span className="text-[10px]" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-ghost)' }}>
                            · {totalRows.toLocaleString()} rows · {data.headers.length} cols
                        </span>
                    )}
                </div>
                <button
                    onClick={onClose}
                    className="w-6 h-6 rounded-md flex items-center justify-center transition-all"
                    style={{ color: 'var(--text-faint)', background: 'transparent' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-dim)'; (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-muted)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-faint)'; (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>

            {data ? (
                <div className="flex-1 overflow-auto flex flex-col">
                    {/* Dataset name */}
                    {name && (
                        <div className="px-4 py-2 shrink-0" style={{ borderBottom: '1px solid var(--border-default)', background: 'var(--bg-card)' }}>
                            <span className="text-[11px] font-medium truncate" style={{ color: 'var(--text-secondary)', letterSpacing: '-0.01em' }}>{name}</span>
                        </div>
                    )}

                    {/* Data rows table */}
                    <div className="overflow-x-auto">
                        <table className="w-full" style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr style={{ background: 'var(--bg-muted)', position: 'sticky', top: 0, zIndex: 1 }}>
                                    {data.headers.map(h => (
                                        <th key={h} className="text-left font-medium" style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap', padding: '8px 14px', borderBottom: '1px solid var(--border-default)' }}>
                                            {h}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {displayRows.map((row, ri) => (
                                    <tr key={ri} style={{ background: ri % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)' }}>
                                        {row.map((cell, ci) => (
                                            <td key={ci} style={{ padding: '6px 14px', color: 'var(--text-muted)', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderBottom: '1px solid var(--border-default)' }}>
                                                {cell || <span style={{ color: 'var(--text-faint)', fontStyle: 'italic' }}>—</span>}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {/* Pagination footer */}
                    {totalRows > PAGE_SIZE && (
                        <div className="shrink-0 flex items-center justify-between px-4 py-2" style={{ borderTop: '1px solid var(--border-default)', background: 'var(--bg-element)' }}>
                            <span className="text-[10px]" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-ghost)' }}>
                                {isLoadingPage ? 'Loading…' : `rows ${rowStart}–${rowEnd} of ${totalRows.toLocaleString()}`}
                            </span>
                            <div className="flex items-center gap-1.5">
                                <button
                                    onClick={() => goToPage(page - 1)}
                                    disabled={page === 0 || isLoadingPage}
                                    className="w-6 h-6 rounded-md flex items-center justify-center text-xs transition-all disabled:opacity-30"
                                    style={{ background: 'var(--bg-muted)', border: '1px solid var(--border-strong)', color: 'var(--text-dim)' }}
                                >‹</button>
                                <span className="text-[10px]" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-ghost)', minWidth: '32px', textAlign: 'center' }}>
                                    {page + 1}/{totalPages}
                                </span>
                                <button
                                    onClick={() => goToPage(page + 1)}
                                    disabled={page >= totalPages - 1 || isLoadingPage}
                                    className="w-6 h-6 rounded-md flex items-center justify-center text-xs transition-all disabled:opacity-30"
                                    style={{ background: 'var(--bg-muted)', border: '1px solid var(--border-strong)', color: 'var(--text-dim)' }}
                                >›</button>
                            </div>
                        </div>
                    )}

                    {/* Stats section */}
                    {data.stats.length > 0 && (
                        <>
                            <div className="px-4 py-2.5 shrink-0" style={{ borderTop: '1px solid var(--border-default)', borderBottom: '1px solid var(--border-default)', background: 'var(--bg-element)' }}>
                                <span className="text-[10px] uppercase tracking-widest font-medium" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
                                    Column Statistics
                                </span>
                            </div>
                            <div className="overflow-x-auto">
                                <table className="w-full" style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', borderCollapse: 'collapse' }}>
                                    <thead>
                                        <tr style={{ background: 'var(--bg-muted)' }}>
                                            {['Column', 'Min', 'Max', 'Avg', 'Nulls'].map(h => (
                                                <th key={h} className="text-left font-medium" style={{ color: 'var(--text-secondary)', padding: '7px 14px', borderBottom: '1px solid var(--border-default)', whiteSpace: 'nowrap' }}>
                                                    {h}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.stats.map((s, si) => (
                                            <tr key={si} style={{ background: si % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)' }}>
                                                <td style={{ padding: '6px 14px', color: 'var(--text-primary)', fontWeight: 500, borderBottom: '1px solid var(--border-default)' }}>{s.field}</td>
                                                <td style={{ padding: '6px 14px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-default)' }}>{s.min.toLocaleString()}</td>
                                                <td style={{ padding: '6px 14px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-default)' }}>{s.max.toLocaleString()}</td>
                                                <td style={{ padding: '6px 14px', color: '#60a5fa', borderBottom: '1px solid var(--border-default)' }}>{s.avg.toLocaleString()}</td>
                                                <td style={{ padding: '6px 14px', color: s.nullCount > 0 ? '#f59e0b' : 'var(--text-faint)', borderBottom: '1px solid var(--border-default)' }}>{s.nullCount}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </>
                    )}
                </div>
            ) : (
                <div className="flex-1 flex flex-col items-center justify-center gap-4 px-8">
                    <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: 'var(--bg-element)', border: '1px solid var(--border-strong)' }}>
                        <Table2 className="w-6 h-6" style={{ color: 'var(--text-dim)' }} />
                    </div>
                    <p className="text-sm text-center" style={{ color: 'var(--text-dim)' }}>
                        Upload a CSV to see the data preview here
                    </p>
                </div>
            )}
        </div>
    );
}

// ── Chat content ──────────────────────────────────────────────────────────

function ChatContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const initialFileId = searchParams.get('fileId');
    const initialType = searchParams.get('type') ?? 'csv';
    const initialName = searchParams.get('name') ?? 'Dataset 1';
    const isFreshOpen = searchParams.get('fresh') === '1';

    const [datasets, setDatasets] = useState<Dataset[]>(
        initialFileId ? [{ fileId: initialFileId, name: initialName, type: initialType as 'csv' | 'pdf' }] : []
    );
    const [activeFileId, setActiveFileId] = useState<string | null>(initialFileId);
    const [activeFileType, setActiveFileType] = useState<'csv' | 'pdf'>(initialType as 'csv' | 'pdf');
    const [isAddingDataset, setIsAddingDataset] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // PDF blob URLs stored per fileId (only available when uploaded directly in this session)
    const pdfBlobUrls = useRef<Map<string, string>>(new Map());
    const [, setPdfUrlVersion] = useState(0);
    const [showPdfPanel, setShowPdfPanel] = useState(false);

    // CSV preview panel
    const [showCsvPanel, setShowCsvPanel] = useState(false);
    const [csvPanelData, setCsvPanelData] = useState<PreviewData | null>(null);

    const [messages, setMessages] = useState<Message[]>(defaultMessages);
    const [input, setInput] = useState('');
    const [isTyping, setIsTyping] = useState(false);
    const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
    const [isAtBottom, setIsAtBottom] = useState(true);
    const [pinnedOpen, setPinnedOpen] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);

    const [suggestions, setSuggestions] = useState<string[]>(
        initialType === 'pdf' ? FALLBACK_PDF : FALLBACK_CSV
    );
    const [loadingSuggestions, setLoadingSuggestions] = useState(!!initialFileId);

    // Hydrate stored chat client-side to avoid SSR/client markup mismatch.
    useEffect(() => {
        if (!initialFileId) return;
        const stored = loadStoredChat(initialFileId);
        if (!stored) return;
        if (stored.datasets?.length) setDatasets(stored.datasets);
        if (stored.messages?.length) setMessages(stored.messages);
    }, [initialFileId]);

    // Save recent file on mount for URL-loaded files
    useEffect(() => {
        if (initialFileId && initialName) {
            saveRecentFile(decodeURIComponent(initialName), initialFileId, initialType as 'csv' | 'pdf');
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // When arriving from upload page, hydrate PDF viewer for the selected file.
    useEffect(() => {
        if (!initialFileId || initialType !== 'pdf') return;
        try {
            const pending = (window as unknown as { __ivPendingPdfFile?: { fileId: string; file: File } }).__ivPendingPdfFile;
            if (pending?.fileId === initialFileId && pending.file) {
                const blobUrl = URL.createObjectURL(pending.file);
                pdfBlobUrls.current.set(initialFileId, blobUrl);
                setPdfUrlVersion(v => v + 1);
                delete (window as unknown as { __ivPendingPdfFile?: { fileId: string; file: File } }).__ivPendingPdfFile;
                return;
            }

            // Backward-compatible fallback for older in-session handoff.
            const key = `iv_pdf_blob_${initialFileId}`;
            const blobUrl = sessionStorage.getItem(key);
            if (!blobUrl) return;
            pdfBlobUrls.current.set(initialFileId, blobUrl);
            setPdfUrlVersion(v => v + 1);
            sessionStorage.removeItem(key);
        } catch { /* ignore */ }
    }, [initialFileId, initialType]);

    // Revoke blob URLs on unmount
    useEffect(() => {
        const urls = pdfBlobUrls.current;
        return () => {
            urls.forEach(url => {
                if (url.startsWith('blob:')) URL.revokeObjectURL(url);
            });
        };
    }, []);

    // Track which fileIds have had their preview shown this session
    const shownPreviewsRef = useRef<Set<string>>(new Set());
    const initialAutoPreviewDoneRef = useRef(false);
    const hydrateChatForFile = useCallback((fileId: string | null, fileType?: 'csv' | 'pdf' | null) => {
        if (!fileId) {
            setMessages(defaultMessages(fileType));
            return;
        }
        const stored = loadStoredChat(fileId);
        setMessages(stored?.messages ?? defaultMessages(fileType));
    }, []);

    const fetchAndShowPreview = async (
        fileId: string,
        datasetName: string,
        options: { force?: boolean; appendToChat?: boolean; isAutoPreview?: boolean } = {}
    ) => {
        const { force = false, appendToChat = false, isAutoPreview = false } = options;
        const alreadyShown = shownPreviewsRef.current.has(fileId);
        if (!alreadyShown) shownPreviewsRef.current.add(fileId);
        try {
            const r = await fetch(`/api/preview?fileId=${fileId}`);
            const preview = await r.json();
            if (preview.headers?.length) {
                const pd: PreviewData = { headers: preview.headers, rows: preview.rows, stats: preview.stats ?? [], totalRows: preview.totalRows };
                setCsvPanelData(pd);
                if (appendToChat && (force || !alreadyShown)) {
                    setMessages(prev => [...prev, {
                        role: 'assistant' as const,
                        content: '',
                        isAutoPreview,
                        previewData: pd,
                        datasetName,
                    }]);
                }
            }
        } catch { /* ignore */ }
    };

    const openCsvPreviewPanel = useCallback(() => {
        if (!activeFileId || activeFileType !== 'csv') return;
        setShowCsvPanel(true);
        const ds = datasets.find(d => d.fileId === activeFileId);
        void fetchAndShowPreview(activeFileId, ds?.name ?? '', { force: true });
    }, [activeFileId, activeFileType, datasets]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!activeFileId) return;
        setLoadingSuggestions(true);
        setSuggestions(activeFileType === 'pdf' ? FALLBACK_PDF : FALLBACK_CSV);
        fetch(`/api/suggestions?fileId=${activeFileId}`)
            .then(r => r.json())
            .then(data => { if (Array.isArray(data.suggestions) && data.suggestions.length) setSuggestions(data.suggestions); })
            .catch(() => {})
            .finally(() => setLoadingSuggestions(false));

        // CSV preview is manual only; do not auto-show.
    }, [activeFileId, activeFileType]); // eslint-disable-line react-hooks/exhaustive-deps

    // Upload-page entry: inject one auto preview message for fresh CSV upload.
    useEffect(() => {
        if (!isFreshOpen || initialAutoPreviewDoneRef.current) return;
        if (!initialFileId || initialType !== 'csv') return;
        if (activeFileId !== initialFileId || activeFileType !== 'csv') return;
        initialAutoPreviewDoneRef.current = true;
        const ds = datasets.find(d => d.fileId === activeFileId);
        void fetchAndShowPreview(activeFileId, ds?.name ?? decodeURIComponent(initialName), {
            force: true,
            appendToChat: true,
            isAutoPreview: true,
        });
    }, [isFreshOpen, initialFileId, initialType, initialName, activeFileId, activeFileType, datasets]); // eslint-disable-line react-hooks/exhaustive-deps

    // If the user has opened the CSV panel, keep it synced to the active CSV file.
    useEffect(() => {
        if (!showCsvPanel || !activeFileId || activeFileType !== 'csv') return;
        const ds = datasets.find(d => d.fileId === activeFileId);
        void fetchAndShowPreview(activeFileId, ds?.name ?? '', { force: true });
    }, [showCsvPanel, activeFileId, activeFileType, datasets]); // eslint-disable-line react-hooks/exhaustive-deps

    // For saved/recent PDF files, stream preview from server endpoint.
    useEffect(() => {
        if (!activeFileId || activeFileType !== 'pdf') return;
        const existingUrl = pdfBlobUrls.current.get(activeFileId);
        if (existingUrl?.startsWith('blob:')) return;
        const streamUrl = `/api/file-content?fileId=${activeFileId}&t=${Date.now()}`;
        pdfBlobUrls.current.set(activeFileId, streamUrl);
        setPdfUrlVersion(v => v + 1);
    }, [activeFileId, activeFileType]);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, isTyping]);

    // Persist chat to localStorage
    useEffect(() => {
        if (!activeFileId || messages.length <= 1) return;
        try {
            localStorage.setItem(CHAT_STORAGE_KEY(activeFileId), JSON.stringify({
                messages,
                datasets,
                savedAt: Date.now(),
            }));
        } catch { /* storage full */ }
        // activeFileId is intentionally excluded to avoid writing old messages under a newly selected dataset id.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages, datasets]);

    const handleAddDataset = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (IS_PRODUCTION && file.size > RECOMMENDED_DEPLOY_MAX_BYTES) {
            const mb = (file.size / 1_048_576).toFixed(1);
            setMessages(prev => [...prev, {
                role: 'assistant',
                content: `Upload skipped: this file is ${mb} MB. Recommended for deployed reliability: ${RECOMMENDED_DEPLOY_MAX_MB} MB or less.`,
                isError: true,
            }]);
            if (fileInputRef.current) fileInputRef.current.value = '';
            return;
        }
        setIsAddingDataset(true);
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
                const fileType = (result.fileType ?? 'csv') as 'csv' | 'pdf';
                const baseName = file.name.replace(/\.(csv|pdf)$/i, '');
                const newDataset: Dataset = { fileId: uploadedFileId, name: baseName, type: fileType };
                setDatasets(prev => [...prev, newDataset]);
                setActiveFileId(uploadedFileId);
                setActiveFileType(fileType);
                setMessages([
                    ...defaultMessages(fileType),
                    {
                        role: 'assistant',
                        content: `${fileType === 'pdf' ? 'Document' : 'Dataset'} "${baseName}" loaded. You can now ask questions about it.`
                    }
                ]);

                // Save to recent files
                saveRecentFile(baseName, uploadedFileId, fileType);

                // For PDF: store blob URL for in-session viewer
                if (fileType === 'pdf') {
                    const blobUrl = URL.createObjectURL(file);
                    pdfBlobUrls.current.set(uploadedFileId, blobUrl);
                    setPdfUrlVersion(v => v + 1);
                }

                // Auto-summary
                fetch(`/api/summary?fileId=${uploadedFileId}`)
                    .then(r => r.json())
                    .then((data: { summary: string }) => {
                        if (data.summary) {
                            setMessages(prev => [...prev, {
                                role: 'assistant',
                                content: data.summary,
                                datasetName: baseName,
                            }]);
                        }
                    })
                    .catch(() => {});

                // In-chat CSV upload: inject one auto preview message, but keep panel closed.
                if (fileType === 'csv') {
                    void fetchAndShowPreview(uploadedFileId, baseName, {
                        force: true,
                        appendToChat: true,
                        isAutoPreview: true,
                    });
                }
            } else {
                setMessages(prev => [...prev, { role: 'assistant', content: `Upload failed: ${result.error ?? 'Unknown error'}` }]);
            }
        } catch {
            setMessages(prev => [...prev, { role: 'assistant', content: 'Upload failed. Please try again.' }]);
        } finally {
            setIsAddingDataset(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    const [removeConfirm, setRemoveConfirm] = useState<{ fileId: string; name: string } | null>(null);

    const doRemoveDataset = (fileId: string) => {
        if (activeFileId === fileId) {
            setMessages(defaultMessages());
            setSuggestions([]);
            setLoadingSuggestions(false);
            try { localStorage.removeItem(`iv_chat_${fileId}`); } catch { /* ignore */ }
        }
        // Revoke blob URL if exists
        const blobUrl = pdfBlobUrls.current.get(fileId);
        if (blobUrl) {
            if (blobUrl.startsWith('blob:')) URL.revokeObjectURL(blobUrl);
            pdfBlobUrls.current.delete(fileId);
            setPdfUrlVersion(v => v + 1);
        }

        setDatasets(prev => {
            const next = prev.filter(d => d.fileId !== fileId);
            if (activeFileId === fileId) {
                const fallback = next.length > 0 ? next[next.length - 1] : null;
                setActiveFileId(fallback ? fallback.fileId : null);
                setActiveFileType(fallback ? fallback.type : 'csv');
                hydrateChatForFile(fallback ? fallback.fileId : null, fallback ? fallback.type : null);
            }
            return next;
        });
    };

    const handleRemoveClick = (fileId: string, name: string) => {
        if (messages.length > 1) {
            setRemoveConfirm({ fileId, name });
        } else {
            doRemoveDataset(fileId);
        }
    };

    const fetchFreshSuggestions = async (fileId: string, exclude: string[] = []) => {
        setLoadingSuggestions(true);
        try {
            const url = `/api/suggestions?fileId=${fileId}${exclude.length ? `&exclude=${encodeURIComponent(JSON.stringify(exclude))}` : ''}`;
            const r = await fetch(url);
            const data = await r.json();
            if (Array.isArray(data.suggestions) && data.suggestions.length) {
                setSuggestions(data.suggestions);
            }
        } catch {}
        finally { setLoadingSuggestions(false); }
    };

    const PREVIEW_TRIGGER = /^(show|display|view|see|give me|get)?\s*(me\s+)?(the\s+)?(data\s*table|table|preview|raw data|columns|dataset overview|data overview|all columns|show data)/i;

    const handleSend = async (overrideMessage?: string) => {
        const userMsg = (overrideMessage ?? input).trim();
        if (!userMsg || !activeFileId) return;
        setInput('');

        // Intercept preview-intent prompts for CSV files
        if (activeFileType === 'csv' && PREVIEW_TRIGGER.test(userMsg)) {
            setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
            const ds = datasets.find(d => d.fileId === activeFileId);
            await fetchAndShowPreview(activeFileId, ds?.name ?? '', { force: true, appendToChat: true });
            return;
        }
        const activeDataset = datasets.find(d => d.fileId === activeFileId);
        setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
        setIsTyping(true);
        try {
            const history = messages.slice(1).slice(-10).map(m => ({ role: m.role, content: m.content }));
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: userMsg, fileId: activeFileId, history }),
            });

            if (!response.ok || !response.body) {
                const err = await response.json().catch(() => ({ error: 'Chat failed' }));
                throw new Error(err.error || 'Chat failed');
            }

            // Add a streaming assistant message
            let streamedText = '';
            setMessages(prev => [...prev, {
                role: 'assistant',
                content: '',
                datasetName: activeDataset?.name,
            }]);

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const events = buffer.split('\n\n');
                buffer = events.pop() ?? '';
                for (const event of events) {
                    if (!event.startsWith('data: ')) continue;
                    const data = JSON.parse(event.slice(6)) as {
                        chunk?: string; done?: boolean; error?: string;
                        chartData?: ChartData; context?: string; sources?: string[];
                    };
                    if (data.chunk) {
                        streamedText += data.chunk;
                        setMessages(prev => {
                            const next = [...prev];
                            const last = next[next.length - 1];
                            if (last?.role === 'assistant') {
                                next[next.length - 1] = { ...last, content: streamedText };
                            }
                            return next;
                        });
                    }
                    if (data.done) {
                        setMessages(prev => {
                            const next = [...prev];
                            const last = next[next.length - 1];
                            if (last?.role === 'assistant') {
                                next[next.length - 1] = {
                                    ...last,
                                    content: streamedText,
                                    sources: data.sources,
                                    context: data.context,
                                    chartData: data.chartData,
                                };
                            }
                            return next;
                        });
                    }
                    if (data.error) throw new Error(data.error);
                }
            }
            fetchFreshSuggestions(activeFileId, suggestions);
        } catch (error: unknown) {
            const raw = error instanceof Error ? error.message : 'Unknown error';
            setMessages(prev => [...prev, { role: 'assistant', content: friendlyError(raw), isError: true }]);
        } finally {
            setIsTyping(false);
        }
    };

    // Scroll tracking
    useEffect(() => {
        const el = scrollContainerRef.current;
        if (!el) return;
        const onScroll = () => {
            setIsAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        };
        el.addEventListener('scroll', onScroll, { passive: true });
        return () => el.removeEventListener('scroll', onScroll);
    }, []);

    const handleCopy = (text: string, idx: number) => {
        navigator.clipboard.writeText(text).catch(() => {});
        setCopiedIdx(idx);
        setTimeout(() => setCopiedIdx(null), 1500);
    };

    const handleClearChat = useCallback(() => {
        setMessages(defaultMessages(activeFileType));
        if (activeFileId) {
            localStorage.removeItem(CHAT_STORAGE_KEY(activeFileId));
            setSuggestions([]);
            fetchFreshSuggestions(activeFileId);
        }
    }, [activeFileId, activeFileType]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleExport = () => {
        const lines = [`# InsightVault Chat\n`, `*${new Date().toLocaleString()}*\n`];
        messages.forEach(m => {
            lines.push(m.role === 'user' ? `\n**You:** ${m.content}` : `\n**InsightVault:** ${m.content}`);
        });
        const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chat-${Date.now()}.md`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const scrollToBottom = () => bottomRef.current?.scrollIntoView({ behavior: 'smooth' });

    // Keyboard shortcuts
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            const mod = e.metaKey || e.ctrlKey;
            if (mod && e.key === 'k') { e.preventDefault(); fileInputRef.current?.click(); }
            if (mod && e.key === 'l') { e.preventDefault(); handleClearChat(); }
            if (e.key === 'Escape') { inputRef.current?.blur(); }
            if (e.key === 'ArrowUp' && document.activeElement === inputRef.current && !input.trim()) {
                e.preventDefault();
                const lastUser = [...messages].reverse().find(m => m.role === 'user');
                if (lastUser) setInput(lastUser.content);
            }
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [input, messages, handleClearChat]);

    const activeDataset = datasets.find(d => d.fileId === activeFileId);
    const activeDatasetName = activeDataset?.name;
    const isEmptyChat = messages.length === 1 && messages[0].role === 'assistant';
    const canSend = !!activeFileId && !isTyping && !!input.trim();
    const activePdfUrl = activeFileId ? (pdfBlobUrls.current.get(activeFileId) ?? null) : null;

    return (
        <div className="flex flex-col h-screen" style={{ background: 'var(--bg-page)' }}>

            {/* ── Header ── */}
            <header
                className="relative shrink-0 sticky top-0 z-20 px-3 sm:px-5 py-2.5 sm:py-3"
                style={{
                    background: 'var(--bg-card)',
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
                    borderBottom: '1px solid var(--border-default)',
                }}
            >
                {/* Top accent */}
                <div className="absolute top-0 left-0 right-0 h-px" style={{
                    background: 'linear-gradient(90deg, transparent 5%, rgba(59,130,246,0.5) 35%, rgba(139,92,246,0.3) 65%, transparent 95%)',
                }} />

                {/* Single row: logo <- -> chips + add */}
                <div className="flex items-center gap-2 sm:gap-4">

                    {/* Left: back + branding (shrinks last) */}
                    <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
                        <button
                            onClick={() => router.push('/')}
                            className="w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-150"
                            title="Back to upload"
                            style={{
                                background: 'var(--bg-muted)',
                                border: '1px solid var(--border-strong)',
                                color: 'var(--text-dim)',
                            }}
                            onMouseEnter={e => {
                                (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(59,130,246,0.4)';
                                (e.currentTarget as HTMLButtonElement).style.color = '#60a5fa';
                            }}
                            onMouseLeave={e => {
                                (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-strong)';
                                (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-dim)';
                            }}
                        >
                            <ArrowLeft className="w-3.5 h-3.5" />
                        </button>
                        <div
                            className="w-7 h-7 rounded-lg flex items-center justify-center"
                            style={{ background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.25)' }}
                        >
                            <Logo size={13} />
                        </div>
                        <span className="hidden sm:inline text-sm font-semibold" style={{ color: 'var(--text-secondary)', letterSpacing: '-0.01em' }}>
                            InsightVault
                        </span>

                        {/* PDF viewer toggle */}
                        {activeFileType === 'pdf' && (
                            <button
                                onClick={() => setShowPdfPanel(v => !v)}
                                title={showPdfPanel ? 'Hide PDF viewer' : 'View PDF'}
                                className="w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-150"
                                style={showPdfPanel ? {
                                    background: 'rgba(59,130,246,0.15)',
                                    border: '1px solid rgba(59,130,246,0.3)',
                                    color: '#60a5fa',
                                } : {
                                    background: 'var(--bg-muted)',
                                    border: '1px solid var(--border-strong)',
                                    color: 'var(--text-dim)',
                                }}
                                onMouseEnter={e => { if (!showPdfPanel) { (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(59,130,246,0.4)'; (e.currentTarget as HTMLButtonElement).style.color = '#60a5fa'; } }}
                                onMouseLeave={e => { if (!showPdfPanel) { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-strong)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-dim)'; } }}
                            >
                                <BookOpen className="w-3.5 h-3.5" />
                            </button>
                        )}

                        {/* CSV preview panel toggle */}
                        {activeFileType === 'csv' && (
                            <button
                                onClick={() => {
                                    if (showCsvPanel) {
                                        setShowCsvPanel(false);
                                        return;
                                    }
                                    openCsvPreviewPanel();
                                }}
                                title={showCsvPanel ? 'Hide data panel' : 'View data table'}
                                className="w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-150"
                                style={showCsvPanel ? {
                                    background: 'rgba(59,130,246,0.15)',
                                    border: '1px solid rgba(59,130,246,0.3)',
                                    color: '#60a5fa',
                                } : {
                                    background: 'var(--bg-muted)',
                                    border: '1px solid var(--border-strong)',
                                    color: 'var(--text-dim)',
                                }}
                                onMouseEnter={e => { if (!showCsvPanel) { (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(59,130,246,0.4)'; (e.currentTarget as HTMLButtonElement).style.color = '#60a5fa'; } }}
                                onMouseLeave={e => { if (!showCsvPanel) { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-strong)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-dim)'; } }}
                            >
                                <Table2 className="w-3.5 h-3.5" />
                            </button>
                        )}

                        {/* Clear + Export actions */}
                        {!isEmptyChat && (
                            <div className="flex items-center gap-1 ml-0.5">
                                {[
                                    { icon: Download, title: 'Export chat', onClick: handleExport },
                                    { icon: Trash2, title: 'Clear chat', onClick: handleClearChat },
                                ].map(({ icon: Icon, title, onClick }) => (
                                    <button
                                        key={title}
                                        onClick={onClick}
                                        title={title}
                                        className="w-6 h-6 rounded-md flex items-center justify-center transition-all duration-150"
                                        style={{ color: 'var(--text-faint)', background: 'transparent' }}
                                        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-dim)'; (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-muted)'; }}
                                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-faint)'; (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
                                    >
                                        <Icon className="w-3 h-3" />
                                    </button>
                                ))}
                            </div>
                        )}

                        {/* Pinned insights toggle */}
                        {messages.some(m => m.pinned) && (
                            <div className="hidden sm:block ml-2">
                                <button
                                    onClick={() => setPinnedOpen(v => !v)}
                                    className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg transition-all duration-150"
                                    style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', color: '#fbbf24' }}
                                >
                                    <Pin className="w-3 h-3" />
                                    {messages.filter(m => m.pinned).length} pinned
                                    <ChevronDown className={`w-3 h-3 transition-transform ${pinnedOpen ? 'rotate-180' : ''}`} />
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Right: chips + add file + warning — scrollable on mobile */}
                    <div className="flex items-center gap-2 flex-1 overflow-x-auto min-w-0 justify-end" style={{ scrollbarWidth: 'none' }}>

                        {/* Dataset chips */}
                        {datasets.map(ds => {
                            const isActive = activeFileId === ds.fileId;
                            const Icon = ds.type === 'pdf' ? FileType : FileText;
                            return (
                                <button
                                    key={ds.fileId}
                                    onClick={() => {
                                        if (activeFileId !== ds.fileId) {
                                            hydrateChatForFile(ds.fileId, ds.type);
                                        }
                                        setActiveFileId(ds.fileId);
                                        setActiveFileType(ds.type);
                                        if (ds.type === 'pdf' && showCsvPanel) {
                                            setShowCsvPanel(false);
                                            setShowPdfPanel(true);
                                        }
                                        if (ds.type === 'csv' && showPdfPanel) {
                                            setShowPdfPanel(false);
                                            setShowCsvPanel(true);
                                        }
                                    }}
                                    className="flex items-center gap-1.5 sm:gap-2 text-xs px-2.5 sm:px-3 py-1.5 rounded-lg transition-all duration-150 shrink-0"
                                    style={isActive ? {
                                        background: 'rgba(37,99,235,0.18)',
                                        border: '1px solid rgba(59,130,246,0.5)',
                                        color: '#93c5fd',
                                        boxShadow: '0 0 0 3px rgba(59,130,246,0.08)',
                                    } : {
                                        background: 'var(--bg-element-3)',
                                        border: '1px solid var(--border-strong)',
                                        color: 'var(--text-muted)',
                                    }}
                                >
                                    <Icon className="w-3.5 h-3.5 shrink-0"
                                        style={{ color: isActive ? '#60a5fa' : 'var(--text-dim)' }} />
                                    <span className="max-w-[100px] sm:max-w-[180px] truncate font-medium" style={{ letterSpacing: '-0.01em' }}>
                                        {ds.name}
                                    </span>
                                    <span
                                        className="hidden sm:inline text-[10px] px-1.5 py-px rounded uppercase tracking-wider shrink-0"
                                        style={{
                                            fontFamily: 'var(--font-mono)',
                                            background: isActive ? 'rgba(59,130,246,0.2)' : 'var(--bg-muted)',
                                            color: isActive ? '#60a5fa' : 'var(--text-dim)',
                                            border: isActive ? '1px solid rgba(59,130,246,0.3)' : '1px solid var(--border-default)',
                                        }}
                                    >
                                        {ds.type}
                                    </span>
                                    <span
                                        onClick={e => { e.stopPropagation(); handleRemoveClick(ds.fileId, ds.name); }}
                                        className="rounded p-0.5 hover:opacity-100 transition-opacity"
                                        style={{ color: isActive ? 'rgba(147,197,253,0.7)' : 'var(--text-faint)', opacity: 0.6 }}
                                    >
                                        <X className="w-3 h-3" />
                                    </span>
                                </button>
                            );
                        })}

                        {/* Add file */}
                        <label
                            className="flex items-center gap-1.5 text-xs px-2.5 sm:px-3 py-1.5 rounded-lg cursor-pointer transition-all duration-150 shrink-0"
                            style={{
                                background: isAddingDataset ? 'rgba(59,130,246,0.1)' : 'transparent',
                                border: `1px dashed ${isAddingDataset ? 'rgba(59,130,246,0.5)' : 'var(--border-strong)'}`,
                                color: isAddingDataset ? '#60a5fa' : 'var(--text-faint)',
                            }}
                        >
                            <input ref={fileInputRef} type="file" accept=".csv,.pdf"
                                className="hidden" onChange={handleAddDataset} disabled={isAddingDataset} />
                            {isAddingDataset
                                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /><span className="hidden sm:inline">Uploading…</span></>
                                : <><Plus className="w-3.5 h-3.5" /><span className="hidden sm:inline">Add file</span></>
                            }
                        </label>

                        {!activeFileId && (
                            <div
                                className="flex items-center gap-1.5 text-xs px-2.5 sm:px-3 py-1.5 rounded-lg shrink-0"
                                style={{
                                    background: 'rgba(245,158,11,0.08)',
                                    border: '1px solid rgba(245,158,11,0.2)',
                                    color: '#fbbf24',
                                }}
                            >
                                <AlertCircle className="w-3.5 h-3.5" />
                                <span className="hidden sm:inline">No file loaded</span>
                            </div>
                        )}
                    </div>
                </div>

                {/* Pinned panel */}
                {pinnedOpen && messages.some(m => m.pinned) && (
                    <div className="mt-2 pt-2" style={{ borderTop: '1px solid var(--border-default)' }}>
                        <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                            {messages.filter(m => m.pinned).map((m, pi) => (
                                <div key={pi} className="text-xs p-2 rounded-lg" style={{ background: 'var(--bg-element)', border: '1px solid var(--border-default)', color: 'var(--text-muted)' }}>
                                    {m.content.slice(0, 120)}{m.content.length > 120 ? '\u2026' : ''}
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </header>

            {/* ── Main content: chat + optional PDF side panel ── */}
            <div className="flex flex-1 overflow-hidden">

                {/* ── Chat column ── */}
                <div className="flex flex-col flex-1 min-w-0 overflow-hidden">

                    {/* Messages */}
                    <div ref={scrollContainerRef} className="relative flex-1 overflow-y-auto px-3 sm:px-4 py-6">

                        {/* Background dots + glow */}
                        <div className="absolute inset-0 bg-grid-dots opacity-[0.15] pointer-events-none" />
                        <div className="absolute inset-0 pointer-events-none" style={{
                            background: 'radial-gradient(ellipse 80% 40% at 50% 0%, rgba(59,130,246,0.06) 0%, transparent 65%)',
                        }} />
                        <div className="absolute inset-0 pointer-events-none" style={{
                            background: 'radial-gradient(ellipse 50% 30% at 80% 80%, rgba(124,58,237,0.03) 0%, transparent 60%)',
                        }} />
                        {/* Bottom fade */}
                        <div className="absolute bottom-0 left-0 right-0 h-16 pointer-events-none" style={{
                            background: 'linear-gradient(to top, var(--bg-page) 0%, transparent 100%)',
                        }} />

                        {/* No-file empty state */}
                        {isEmptyChat && !activeFileId && (
                            <div className="relative flex flex-col items-center justify-center min-h-[58vh] animate-fade-in">
                                <div className="relative mb-6">
                                    <div className="absolute inset-0 rounded-3xl blur-3xl" style={{
                                        background: 'radial-gradient(circle, rgba(59,130,246,0.1) 0%, rgba(124,58,237,0.05) 70%)',
                                        transform: 'scale(2.5)',
                                    }} />
                                    <div
                                        className="relative w-[70px] h-[70px] rounded-2xl flex items-center justify-center"
                                        style={{
                                            background: 'var(--bg-element)',
                                            border: '1px solid var(--border-strong)',
                                            boxShadow: '0 0 0 8px rgba(59,130,246,0.03)',
                                        }}
                                    >
                                        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" stroke="var(--text-dim)" strokeWidth="1.5"/>
                                            <polyline points="13 2 13 9 20 9" stroke="var(--text-dim)" strokeWidth="1.5"/>
                                            <line x1="9" y1="13" x2="15" y2="13" stroke="var(--text-faint)" strokeWidth="1.5"/>
                                            <line x1="9" y1="17" x2="13" y2="17" stroke="var(--text-faint)" strokeWidth="1.5"/>
                                        </svg>
                                    </div>
                                </div>
                                <p className="text-[17px] font-semibold mb-1.5" style={{ color: 'var(--text-primary)', letterSpacing: '-0.025em' }}>
                                    No file loaded
                                </p>
                                <p className="text-[12.5px] mb-6 text-center max-w-[260px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                                    Upload a CSV or PDF to start analyzing your data with natural language
                                </p>
                                <label
                                    className="flex items-center gap-2 text-sm font-medium px-5 py-2.5 rounded-xl cursor-pointer transition-all duration-150"
                                    style={{
                                        background: 'rgba(37,99,235,0.12)',
                                        border: '1px solid rgba(59,130,246,0.35)',
                                        color: '#60a5fa',
                                    }}
                                    onMouseEnter={e => {
                                        const el = e.currentTarget as HTMLLabelElement;
                                        el.style.background = 'rgba(37,99,235,0.2)';
                                        el.style.borderColor = 'rgba(59,130,246,0.55)';
                                    }}
                                    onMouseLeave={e => {
                                        const el = e.currentTarget as HTMLLabelElement;
                                        el.style.background = 'rgba(37,99,235,0.12)';
                                        el.style.borderColor = 'rgba(59,130,246,0.35)';
                                    }}
                                >
                                    <input type="file" accept=".csv,.pdf" className="hidden" onChange={handleAddDataset} disabled={isAddingDataset} />
                                    {isAddingDataset
                                        ? <><Loader2 className="w-4 h-4 animate-spin" />Uploading…</>
                                        : <><Plus className="w-4 h-4" />Add CSV or PDF</>
                                    }
                                </label>
                            </div>
                        )}

                        {/* Empty state with suggestions */}
                        {isEmptyChat && activeFileId && (
                            <div className="relative flex flex-col items-center justify-center min-h-[58vh] animate-fade-in">
                                {/* Glow ring */}
                                <div className="relative mb-6">
                                    <div className="absolute inset-0 rounded-2xl blur-3xl" style={{
                                        background: 'radial-gradient(circle, rgba(59,130,246,0.25) 0%, rgba(124,58,237,0.1) 70%)',
                                        transform: 'scale(2)',
                                        animation: 'pulseGlow 3s ease-in-out infinite',
                                    }} />
                                    <div
                                        className="relative w-[70px] h-[70px] rounded-2xl flex items-center justify-center"
                                        style={{
                                            background: 'linear-gradient(135deg, rgba(37,99,235,0.18) 0%, rgba(124,58,237,0.12) 100%)',
                                            border: '1px solid rgba(59,130,246,0.35)',
                                            boxShadow: '0 0 0 10px rgba(59,130,246,0.04), 0 0 40px rgba(59,130,246,0.12)',
                                        }}
                                    >
                                        <Sparkles className="w-7 h-7" style={{ color: '#60a5fa' }} />
                                    </div>
                                </div>

                                <p className="text-[17px] font-semibold mb-1.5" style={{ color: 'var(--text-primary)', letterSpacing: '-0.025em' }}>
                                    {activeFileType === 'pdf' ? 'Document ready' : 'Dataset ready'}
                                </p>
                                <p className="text-[12.5px] mb-7" style={{ color: 'var(--text-dim)', letterSpacing: '-0.005em' }}>
                                    Try one of these to get started, or type your own question
                                </p>

                                {/* 2x2 suggestion grid */}
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full max-w-md px-2 sm:px-0">
                                    {loadingSuggestions
                                        ? Array.from({ length: 4 }).map((_, i) => (
                                            <div key={i} className="h-20 rounded-xl animate-pulse" style={{ background: 'var(--bg-muted)' }} />
                                        ))
                                        : suggestions.map((q, i) => {
                                            const meta = SUGGESTION_META[i % 4];
                                            const Icon = meta.icon;
                                            return (
                                                <button
                                                    key={q}
                                                    onClick={() => setInput(q)}
                                                    className="card-hover text-left px-4 py-3.5 rounded-xl transition-all duration-200"
                                                    style={{
                                                        background: 'var(--bg-element)',
                                                        border: '1px solid var(--border-default)',
                                                        boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
                                                    }}
                                                    onMouseEnter={e => {
                                                        const el = e.currentTarget;
                                                        el.style.borderColor = 'rgba(59,130,246,0.45)';
                                                        el.style.background = 'var(--bg-element-3)';
                                                        el.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.06), 0 4px 16px rgba(0,0,0,0.2)';
                                                    }}
                                                    onMouseLeave={e => {
                                                        const el = e.currentTarget;
                                                        el.style.borderColor = 'var(--border-default)';
                                                        el.style.background = 'var(--bg-element)';
                                                        el.style.boxShadow = '0 1px 4px rgba(0,0,0,0.15)';
                                                    }}
                                                >
                                                    <div className="flex items-center gap-1.5 mb-2">
                                                        <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0"
                                                            style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.15)' }}>
                                                            <Icon className="w-2.5 h-2.5" style={{ color: '#60a5fa' }} />
                                                        </div>
                                                        <span
                                                            className="text-[9px] uppercase tracking-widest"
                                                            style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-ghost)' }}
                                                        >
                                                            {meta.label}
                                                        </span>
                                                    </div>
                                                    <span className="text-[12.5px] leading-snug" style={{ color: 'var(--text-muted)', letterSpacing: '-0.005em' }}>
                                                        {q}
                                                    </span>
                                                </button>
                                            );
                                        })
                                    }
                                </div>
                            </div>
                        )}

                        {/* Message list */}
                        {!(isEmptyChat && !activeFileId) && (
                            <div className="relative space-y-5 max-w-3xl mx-auto">
                                {messages.map((msg, i) => {
                                    const isLastAssistant =
                                        msg.role === 'assistant' &&
                                        i === messages.map(m => m.role).lastIndexOf('assistant') &&
                                        !isTyping;
                                    const showSuggestions = isLastAssistant && !isEmptyChat && activeFileId && (suggestions.length > 0 || loadingSuggestions);

                                    return (
                                        <React.Fragment key={i}>
                                            <div className={`flex animate-float-up ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                                {msg.role === 'user' ? (
                                                    <div
                                                        className="max-w-[88%] sm:max-w-[70%] text-sm leading-relaxed px-4 py-2.5"
                                                        style={{
                                                            background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
                                                            border: '1px solid rgba(59,130,246,0.35)',
                                                            borderRadius: '16px 16px 4px 16px',
                                                            color: '#dbeafe',
                                                            boxShadow: '0 4px 20px rgba(37,99,235,0.25)',
                                                        }}
                                                    >
                                                        {msg.content}
                                                    </div>
                                                ) : msg.isError ? (
                                                    <div className="max-w-[96%] sm:max-w-[82%] flex gap-2 sm:gap-2.5">
                                                        <div
                                                            className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                                                            style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.2)' }}
                                                        >
                                                            <AlertCircle className="w-3 h-3" style={{ color: '#f87171' }} />
                                                        </div>
                                                        <div
                                                            className="text-sm leading-relaxed px-3 py-2.5"
                                                            style={{
                                                                background: 'rgba(239,68,68,0.06)',
                                                                border: '1px solid rgba(239,68,68,0.18)',
                                                                borderRadius: '4px 14px 14px 14px',
                                                                color: '#fca5a5',
                                                            }}
                                                        >
                                                            {msg.content}
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <div className="group max-w-[96%] sm:max-w-[82%] flex gap-2 sm:gap-2.5">
                                                        <div
                                                            className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                                                            style={{
                                                                background: 'rgba(59,130,246,0.12)',
                                                                border: '1px solid rgba(59,130,246,0.2)',
                                                            }}
                                                        >
                                                            <Logo size={10} />
                                                        </div>

                                                        <div className="flex-1 min-w-0 space-y-1.5">
                                                            <div
                                                                className="text-sm leading-relaxed px-3 sm:px-4 py-3"
                                                                style={{
                                                                    background: 'var(--bg-card)',
                                                                    border: '1px solid var(--border-default)',
                                                                    borderRadius: '4px 14px 14px 14px',
                                                                    color: 'var(--text-secondary)',
                                                                }}
                                                            >
                                                                <div className="space-y-0.5">
                                                                    {renderMarkdown(msg.content)}
                                                                </div>

                                                                {/* Preview data table */}
                                                                {msg.previewData && (
                                                                    <div className="mt-4 space-y-3">

                                                                        {/* ── Data rows table ── */}
                                                                        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border-default)', background: 'var(--bg-card)' }}>
                                                                            <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: '1px solid var(--border-default)', background: 'var(--bg-element)' }}>
                                                                                <span className="text-[10px] uppercase tracking-widest font-medium" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
                                                                                    Data Preview
                                                                                </span>
                                                                                <span className="text-[10px]" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-ghost)' }}>
                                                                                    {msg.previewData.rows.length} rows · {msg.previewData.headers.length} columns
                                                                                </span>
                                                                            </div>
                                                                            <div className="overflow-x-auto">
                                                                                <table className="w-full" style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', borderCollapse: 'collapse' }}>
                                                                                    <thead>
                                                                                        <tr style={{ background: 'var(--bg-muted)' }}>
                                                                                            {msg.previewData.headers.map(h => (
                                                                                                <th key={h} className="text-left font-medium" style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap', padding: '8px 16px', borderBottom: '1px solid var(--border-default)' }}>
                                                                                                    {h}
                                                                                                </th>
                                                                                            ))}
                                                                                        </tr>
                                                                                    </thead>
                                                                                    <tbody>
                                                                                        {msg.previewData.rows.map((row, ri) => (
                                                                                            <tr key={ri} style={{ background: ri % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)' }}>
                                                                                                {row.map((cell, ci) => (
                                                                                                    <td key={ci} style={{ padding: '7px 16px', color: 'var(--text-muted)', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderBottom: ri < msg.previewData!.rows.length - 1 ? '1px solid var(--border-default)' : 'none' }}>
                                                                                                        {cell || <span style={{ color: 'var(--text-faint)', fontStyle: 'italic' }}>—</span>}
                                                                                                    </td>
                                                                                                ))}
                                                                                            </tr>
                                                                                        ))}
                                                                                    </tbody>
                                                                                </table>
                                                                            </div>
                                                                        </div>

                                                                        {/* ── Column stats table ── */}
                                                                        {msg.previewData.stats.length > 0 && (
                                                                            <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border-default)', background: 'var(--bg-card)' }}>
                                                                                <div className="px-4 py-2.5" style={{ borderBottom: '1px solid var(--border-default)', background: 'var(--bg-element)' }}>
                                                                                    <span className="text-[10px] uppercase tracking-widest font-medium" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
                                                                                        Column Statistics
                                                                                    </span>
                                                                                </div>
                                                                                <div className="overflow-x-auto">
                                                                                    <table className="w-full" style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', borderCollapse: 'collapse' }}>
                                                                                        <thead>
                                                                                            <tr style={{ background: 'var(--bg-muted)' }}>
                                                                                                {['Column', 'Min', 'Max', 'Avg', 'Nulls'].map(h => (
                                                                                                    <th key={h} className="text-left font-medium" style={{ color: 'var(--text-secondary)', padding: '8px 16px', borderBottom: '1px solid var(--border-default)', whiteSpace: 'nowrap' }}>
                                                                                                        {h}
                                                                                                    </th>
                                                                                                ))}
                                                                                            </tr>
                                                                                        </thead>
                                                                                        <tbody>
                                                                                            {msg.previewData.stats.map((s, si) => (
                                                                                                <tr key={si} style={{ background: si % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)' }}>
                                                                                                    <td style={{ padding: '7px 16px', color: 'var(--text-primary)', fontWeight: 500, borderBottom: si < msg.previewData!.stats.length - 1 ? '1px solid var(--border-default)' : 'none' }}>{s.field}</td>
                                                                                                    <td style={{ padding: '7px 16px', color: 'var(--text-muted)', borderBottom: si < msg.previewData!.stats.length - 1 ? '1px solid var(--border-default)' : 'none' }}>{s.min.toLocaleString()}</td>
                                                                                                    <td style={{ padding: '7px 16px', color: 'var(--text-muted)', borderBottom: si < msg.previewData!.stats.length - 1 ? '1px solid var(--border-default)' : 'none' }}>{s.max.toLocaleString()}</td>
                                                                                                    <td style={{ padding: '7px 16px', color: '#60a5fa', borderBottom: si < msg.previewData!.stats.length - 1 ? '1px solid var(--border-default)' : 'none' }}>{s.avg.toLocaleString()}</td>
                                                                                                    <td style={{ padding: '7px 16px', color: s.nullCount > 0 ? '#f59e0b' : 'var(--text-faint)', borderBottom: si < msg.previewData!.stats.length - 1 ? '1px solid var(--border-default)' : 'none' }}>{s.nullCount}</td>
                                                                                                </tr>
                                                                                            ))}
                                                                                        </tbody>
                                                                                    </table>
                                                                                </div>
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                )}
                                                            </div>

                                                            {/* Copy + Pin buttons */}
                                                            <div className="flex items-center gap-1">
                                                                <button
                                                                    onClick={() => handleCopy(msg.content, i)}
                                                                    className="flex items-center gap-1 px-2 py-1 rounded-md transition-all duration-150 opacity-0 group-hover:opacity-100"
                                                                    title="Copy response"
                                                                    style={{
                                                                        background: 'transparent',
                                                                        border: 'none',
                                                                        color: copiedIdx === i ? '#4ade80' : 'var(--text-faint)',
                                                                        fontSize: '10px',
                                                                        fontFamily: 'var(--font-mono)',
                                                                    }}
                                                                    onMouseEnter={e => { if (copiedIdx !== i) (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-dim)'; }}
                                                                    onMouseLeave={e => { if (copiedIdx !== i) (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-faint)'; }}
                                                                >
                                                                    {copiedIdx === i
                                                                        ? <><Check className="w-3 h-3" />copied</>
                                                                        : <><Copy className="w-3 h-3" />copy</>
                                                                    }
                                                                </button>
                                                                <button
                                                                    onClick={() => setMessages(prev => prev.map((m, mi) => mi === i ? { ...m, pinned: !m.pinned } : m))}
                                                                    className="flex items-center gap-1 px-2 py-1 rounded-md transition-all duration-150 opacity-0 group-hover:opacity-100"
                                                                    title={msg.pinned ? 'Unpin' : 'Pin insight'}
                                                                    style={{ background: 'transparent', border: 'none', color: msg.pinned ? '#f59e0b' : 'var(--text-faint)', fontSize: '10px', fontFamily: 'var(--font-mono)' }}
                                                                >
                                                                    <Pin className="w-3 h-3" />{msg.pinned ? 'pinned' : 'pin'}
                                                                </button>
                                                            </div>

                                                            {msg.chartData && <ChartView chart={msg.chartData} />}

                                                            {msg.datasetName && datasets.length > 1 && (
                                                                <div className="flex items-center gap-1 px-1">
                                                                    <span
                                                                        className="text-[10px] px-2 py-0.5 rounded-full"
                                                                        style={{
                                                                            fontFamily: 'var(--font-mono)',
                                                                            background: 'var(--bg-element-3)',
                                                                            border: '1px solid var(--border-default)',
                                                                            color: 'var(--text-ghost)',
                                                                        }}
                                                                    >
                                                                        from: {msg.datasetName}
                                                                    </span>
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>

                                            {/* Suggestion chips */}
                                            {showSuggestions && (
                                                <div className="flex justify-start pl-8 animate-fade-in">
                                                    <div className="flex flex-col gap-2 max-w-[96%] sm:max-w-[82%]">
                                                        <span className="text-[10px] px-1" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-ghost)' }}>
                                                            suggested follow-ups
                                                        </span>
                                                        <div className="flex flex-wrap gap-2">
                                                            {(loadingSuggestions
                                                                ? Array.from({ length: 3 }).map((_, si) => (
                                                                    <div key={si} className="h-7 rounded-full animate-pulse"
                                                                        style={{ width: `${90 + si * 30}px`, background: 'var(--bg-muted)' }} />
                                                                ))
                                                                : suggestions.map(q => (
                                                                    <button
                                                                        key={q}
                                                                        onClick={() => {
                                                                            setSuggestions([]);
                                                                            setLoadingSuggestions(true);
                                                                            handleSend(q);
                                                                        }}
                                                                        className="text-xs px-3 py-1.5 rounded-full transition-all duration-150 text-left"
                                                                        style={{ background: 'var(--bg-element)', border: '1px solid var(--border-default)', color: 'var(--text-muted)' }}
                                                                        onMouseEnter={e => {
                                                                            const el = e.currentTarget;
                                                                            el.style.borderColor = 'rgba(59,130,246,0.5)';
                                                                            el.style.color = '#60a5fa';
                                                                            el.style.background = 'rgba(59,130,246,0.07)';
                                                                            el.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.06)';
                                                                        }}
                                                                        onMouseLeave={e => {
                                                                            const el = e.currentTarget;
                                                                            el.style.borderColor = 'var(--border-default)';
                                                                            el.style.color = 'var(--text-muted)';
                                                                            el.style.background = 'var(--bg-element)';
                                                                            el.style.boxShadow = 'none';
                                                                        }}
                                                                    >
                                                                        {q}
                                                                    </button>
                                                                ))
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            )}
                                        </React.Fragment>
                                    );
                                })}

                                {/* Typing indicator */}
                                {isTyping && (
                                    <div className="flex justify-start animate-fade-in gap-2.5">
                                        <div
                                            className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                                            style={{ background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.2)' }}
                                        >
                                            <Logo size={10} />
                                        </div>
                                        <div
                                            className="flex items-center gap-1.5 px-4 py-3"
                                            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-default)', borderRadius: '4px 14px 14px 14px' }}
                                        >
                                            <span className="w-1.5 h-1.5 rounded-full dot-bounce" style={{ background: '#3b82f6' }} />
                                            <span className="w-1.5 h-1.5 rounded-full dot-bounce-2" style={{ background: '#3b82f6' }} />
                                            <span className="w-1.5 h-1.5 rounded-full dot-bounce-3" style={{ background: '#3b82f6' }} />
                                        </div>
                                    </div>
                                )}

                                <div ref={bottomRef} />
                            </div>
                        )}
                    </div>

                    {/* ── Input bar ── */}
                    <div className="shrink-0 px-3 sm:px-4 pb-4 sm:pb-5 pt-2 sm:pt-3" style={{ borderTop: '1px solid var(--border-default)' }}>
                        <div
                            className="flex items-center gap-2 px-3 sm:px-4 py-2 max-w-3xl mx-auto transition-all duration-200"
                            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: '14px' }}
                            onFocus={e => {
                                (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(59,130,246,0.5)';
                                (e.currentTarget as HTMLDivElement).style.boxShadow = '0 0 0 3px rgba(59,130,246,0.08)';
                            }}
                            onBlur={e => {
                                (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-strong)';
                                (e.currentTarget as HTMLDivElement).style.boxShadow = 'none';
                            }}
                        >
                            <input
                                ref={inputRef}
                                type="text"
                                value={input}
                                onChange={e => setInput(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && handleSend()}
                                placeholder={activeFileId ? `Ask about ${activeDatasetName ?? 'your data'}…` : 'Add a file to start'}
                                disabled={!activeFileId || isTyping}
                                className="flex-1 bg-transparent text-sm focus:outline-none disabled:opacity-30 py-1.5"
                                style={{ color: 'var(--text-secondary)', caretColor: '#3b82f6', fontFamily: 'var(--font-sans)' }}
                            />
                            <button
                                onClick={() => handleSend()}
                                disabled={!canSend}
                                className="w-8 h-8 flex items-center justify-center rounded-lg shrink-0 transition-all duration-150"
                                style={canSend ? {
                                    background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
                                    border: '1px solid rgba(59,130,246,0.4)',
                                    color: '#fff',
                                    boxShadow: '0 0 16px rgba(37,99,235,0.5)',
                                } : {
                                    background: 'var(--bg-muted)',
                                    border: '1px solid var(--border-strong)',
                                    color: 'var(--text-ghost)',
                                }}
                            >
                                <Send className="w-3.5 h-3.5" />
                            </button>
                        </div>

                        <p className="text-center mt-2 text-[10px]" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-ghost)' }}>
                            Enter to send · charts generated automatically · CSV &amp; PDF supported
                        </p>
                    </div>
                </div>

                {/* ── PDF side panel (desktop only) ── */}
                {showPdfPanel && activeFileType === 'pdf' && (
                    <div
                        className="hidden md:flex flex-col shrink-0"
                        style={{
                            width: '42%',
                            borderLeft: '1px solid var(--border-default)',
                            background: 'var(--bg-card)',
                        }}
                    >
                        <PdfPanel
                            pdfUrl={activePdfUrl}
                            onClose={() => setShowPdfPanel(false)}
                            onOpenFile={handleAddDataset}
                        />
                    </div>
                )}

                {/* ── CSV preview side panel (desktop only) ── */}
                {showCsvPanel && activeFileType === 'csv' && (
                    <div
                        className="hidden md:flex flex-col shrink-0"
                        style={{
                            width: '42%',
                            borderLeft: '1px solid var(--border-default)',
                            background: 'var(--bg-card)',
                        }}
                    >
                        <CsvPanel
                            data={csvPanelData}
                            name={activeDatasetName ?? ''}
                            fileId={activeFileId ?? undefined}
                            onClose={() => setShowCsvPanel(false)}
                        />
                    </div>
                )}
            </div>

            {/* ── PDF mobile full-screen overlay ── */}
            {showPdfPanel && activeFileType === 'pdf' && activePdfUrl && (
                <div
                    className="md:hidden fixed inset-0 z-50 flex flex-col"
                    style={{ background: 'var(--bg-page)' }}
                >
                    <div
                        className="flex items-center justify-between px-4 py-3 shrink-0"
                        style={{ borderBottom: '1px solid var(--border-default)', background: 'var(--bg-card)' }}
                    >
                        <div className="flex items-center gap-2">
                            <FileType className="w-4 h-4" style={{ color: '#60a5fa' }} />
                            <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>PDF Viewer</span>
                        </div>
                        <button
                            onClick={() => setShowPdfPanel(false)}
                            className="w-8 h-8 rounded-lg flex items-center justify-center"
                            style={{ background: 'var(--bg-muted)', border: '1px solid var(--border-strong)', color: 'var(--text-dim)' }}
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                    <iframe src={activePdfUrl} className="flex-1 w-full border-none" title="PDF viewer" />
                </div>
            )}

            {/* ── CSV mobile full-screen overlay ── */}
            {showCsvPanel && activeFileType === 'csv' && (
                <div
                    className="md:hidden fixed inset-0 z-50 flex flex-col"
                    style={{ background: 'var(--bg-page)' }}
                >
                    <div
                        className="flex items-center justify-between px-4 py-3 shrink-0"
                        style={{ borderBottom: '1px solid var(--border-default)', background: 'var(--bg-card)' }}
                    >
                        <div className="flex items-center gap-2">
                            <Table2 className="w-4 h-4" style={{ color: '#60a5fa' }} />
                            <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>Data Preview</span>
                        </div>
                        <button
                            onClick={() => setShowCsvPanel(false)}
                            className="w-8 h-8 rounded-lg flex items-center justify-center"
                            style={{ background: 'var(--bg-muted)', border: '1px solid var(--border-strong)', color: 'var(--text-dim)' }}
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                    <div className="flex-1 overflow-auto">
                        <CsvPanel
                            data={csvPanelData}
                            name={activeDatasetName ?? ''}
                            fileId={activeFileId ?? undefined}
                            onClose={() => setShowCsvPanel(false)}
                        />
                    </div>
                </div>
            )}

            {/* ── Remove-dataset confirmation modal ── */}
            {removeConfirm && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center"
                    style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)' }}
                    onClick={() => setRemoveConfirm(null)}
                >
                    <div
                        className="w-full max-w-[340px] mx-4 rounded-2xl p-6 animate-float-up"
                        style={{
                            background: 'var(--bg-card)',
                            border: '1px solid var(--border-strong)',
                            boxShadow: '0 0 0 1px rgba(0,0,0,0.25), 0 40px 100px rgba(0,0,0,0.5)',
                        }}
                        onClick={e => e.stopPropagation()}
                    >
                        {/* Top accent */}
                        <div className="absolute top-0 left-8 right-8 h-px" style={{
                            background: 'linear-gradient(90deg, transparent, rgba(239,68,68,0.5), transparent)',
                        }} />
                        <p className="text-[15px] font-semibold mb-1 truncate" style={{ color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
                            Remove &ldquo;{removeConfirm.name}&rdquo;?
                        </p>
                        <p className="text-[12.5px] mb-5 leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                            {messages.length > 1
                                ? 'Your conversation history will be lost. Save a copy before removing?'
                                : 'This will remove the file from your session.'}
                        </p>
                        <div className="flex flex-col gap-2">
                            {messages.length > 1 && (
                                <button
                                    onClick={() => { handleExport(); doRemoveDataset(removeConfirm.fileId); setRemoveConfirm(null); }}
                                    className="flex items-center justify-center gap-2 text-sm font-medium px-4 py-2.5 rounded-xl transition-all duration-150"
                                    style={{ background: 'rgba(37,99,235,0.14)', border: '1px solid rgba(59,130,246,0.35)', color: '#60a5fa' }}
                                >
                                    <Download className="w-3.5 h-3.5" /> Download & Remove
                                </button>
                            )}
                            <button
                                onClick={() => { doRemoveDataset(removeConfirm.fileId); setRemoveConfirm(null); }}
                                className="flex items-center justify-center gap-2 text-sm font-medium px-4 py-2.5 rounded-xl transition-all duration-150"
                                style={{ background: 'var(--bg-muted)', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
                            >
                                Remove without saving
                            </button>
                            <button
                                onClick={() => setRemoveConfirm(null)}
                                className="text-sm px-4 py-2 rounded-xl transition-all duration-150"
                                style={{ color: 'var(--text-faint)', background: 'transparent', border: 'none' }}
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Scroll-to-bottom button ── */}
            {!isAtBottom && (
                <button
                    onClick={scrollToBottom}
                    className="fixed bottom-24 right-6 z-30 w-8 h-8 rounded-full flex items-center justify-center transition-all duration-200 animate-fade-in"
                    title="Scroll to latest"
                    style={{
                        background: 'var(--bg-card)',
                        border: '1px solid var(--border-strong)',
                        color: 'var(--text-dim)',
                        boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
                    }}
                >
                    <ChevronDown className="w-4 h-4" />
                </button>
            )}
        </div>
    );
}

export default function ChatPage() {
    return (
        <Suspense fallback={
            <div className="flex items-center justify-center min-h-screen" style={{ background: 'var(--bg-page)' }}>
                <Loader2 className="w-5 h-5 animate-spin" style={{ color: '#3b82f6' }} />
            </div>
        }>
            <ChatContent />
        </Suspense>
    );
}
