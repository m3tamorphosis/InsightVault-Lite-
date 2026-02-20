'use client';

import React, { useState, useRef, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Send, Loader2, Sparkles, AlertCircle, Plus, X } from 'lucide-react';
import {
    BarChart, Bar, LineChart, Line,
    XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer
} from 'recharts';
import type { ChartData } from '@/app/api/chat/route';

// ── Inline chart renderer ─────────────────────────────────────────────────

function ChartView({ chart }: { chart: ChartData }) {
    const margin = { top: 6, right: 8, left: 0, bottom: 50 };
    const tickStyle = { fontSize: 10, fill: '#52525b', fontFamily: 'var(--font-mono)' };
    const tooltipStyle = {
        fontSize: 12,
        borderRadius: 8,
        border: '1px solid rgba(63,63,70,0.8)',
        background: 'rgba(18,18,20,0.97)',
        color: '#e4e4e7',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
    };

    return (
        <div
            className="mt-3 w-full px-3 pt-3 pb-1"
            style={{
                borderRadius: '10px',
                border: '1px solid rgba(39,39,42,0.8)',
                background: 'rgba(12,12,13,0.8)',
            }}
        >
            <p
                className="text-[10px] px-0.5 mb-2 uppercase tracking-widest"
                style={{ fontFamily: 'var(--font-mono)', color: '#3f3f46' }}
            >
                {chart.title}
            </p>
            <ResponsiveContainer width="100%" height={210}>
                {chart.type === 'bar' ? (
                    <BarChart data={chart.data} margin={margin}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(39,39,42,0.8)" vertical={false} />
                        <XAxis dataKey={chart.xKey} tick={tickStyle} angle={-35} textAnchor="end" interval={0} />
                        <YAxis tick={tickStyle} width={44} />
                        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgba(59,130,246,0.05)' }} />
                        <Bar dataKey={chart.yKey} fill="#2563eb" radius={[3, 3, 0, 0]} maxBarSize={40} />
                    </BarChart>
                ) : (
                    <LineChart data={chart.data} margin={margin}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(39,39,42,0.8)" vertical={false} />
                        <XAxis dataKey={chart.xKey} tick={tickStyle} angle={-35} textAnchor="end" interval={0} />
                        <YAxis tick={tickStyle} width={44} />
                        <Tooltip contentStyle={tooltipStyle} />
                        <Line
                            type="monotone"
                            dataKey={chart.yKey}
                            stroke="#3b82f6"
                            strokeWidth={2}
                            dot={{ r: 3, fill: '#3b82f6', strokeWidth: 0 }}
                            activeDot={{ r: 5, fill: '#60a5fa' }}
                        />
                    </LineChart>
                )}
            </ResponsiveContainer>
        </div>
    );
}

// ── Types ─────────────────────────────────────────────────────────────────

interface Dataset {
    fileId: string;
    name: string;
}

interface Message {
    role: 'user' | 'assistant';
    content: string;
    sources?: string[];
    context?: string;
    chartData?: ChartData;
    datasetName?: string;
}

// ── Empty state example queries ───────────────────────────────────────────

const EXAMPLE_QUERIES = [
    'What are the top 5 rows by value?',
    'Show me a chart of totals by category',
    'What is the average across all records?',
    'Find any outliers or anomalies',
];

// ── Chat content ──────────────────────────────────────────────────────────

function ChatContent() {
    const searchParams = useSearchParams();
    const initialFileId = searchParams.get('fileId');

    const [datasets, setDatasets] = useState<Dataset[]>(
        initialFileId ? [{ fileId: initialFileId, name: 'Dataset 1' }] : []
    );
    const [activeFileId, setActiveFileId] = useState<string | null>(initialFileId);
    const [isAddingDataset, setIsAddingDataset] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const [messages, setMessages] = useState<Message[]>([
        { role: 'assistant', content: "Hello! I'm InsightVault. Ask me anything about your uploaded dataset." }
    ]);
    const [input, setInput] = useState('');
    const [isTyping, setIsTyping] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, isTyping]);

    // ── Inline dataset upload ─────────────────────────────────────────────
    const handleAddDataset = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setIsAddingDataset(true);
        try {
            const formData = new FormData();
            formData.append('file', file);
            const response = await fetch('/api/upload', { method: 'POST', body: formData });
            const result = await response.json();
            if (response.ok) {
                const baseName = file.name.replace(/\.csv$/i, '');
                const newDataset: Dataset = { fileId: result.fileId, name: baseName };
                setDatasets(prev => [...prev, newDataset]);
                setActiveFileId(result.fileId);
                setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: `Dataset "${baseName}" loaded. You can now ask questions about it.`
                }]);
            } else {
                setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: `Upload failed: ${result.error ?? 'Unknown error'}`
                }]);
            }
        } catch {
            setMessages(prev => [...prev, { role: 'assistant', content: 'Upload failed. Please try again.' }]);
        } finally {
            setIsAddingDataset(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    const removeDataset = (fileId: string) => {
        setDatasets(prev => {
            const next = prev.filter(d => d.fileId !== fileId);
            if (activeFileId === fileId) {
                setActiveFileId(next.length > 0 ? next[next.length - 1].fileId : null);
            }
            return next;
        });
    };

    // ── Send message ──────────────────────────────────────────────────────
    const handleSend = async () => {
        if (!input.trim() || !activeFileId) return;

        const userMsg = input;
        setInput('');
        const activeDataset = datasets.find(d => d.fileId === activeFileId);
        setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
        setIsTyping(true);

        try {
            const history = messages
                .slice(1)
                .slice(-10)
                .map(m => ({ role: m.role, content: m.content }));

            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: userMsg, fileId: activeFileId, history }),
            });

            const result = await response.json();

            if (response.ok) {
                setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: result.answer,
                    sources: result.sources,
                    context: result.context,
                    chartData: result.chartData,
                    datasetName: activeDataset?.name,
                }]);
            } else {
                throw new Error(result.error || 'Chat failed');
            }
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            setMessages(prev => [...prev, { role: 'assistant', content: `Something went wrong: ${msg}` }]);
        } finally {
            setIsTyping(false);
        }
    };

    const activeDatasetName = datasets.find(d => d.fileId === activeFileId)?.name;

    // Only the greeting message means the chat is effectively "empty"
    const isEmptyChat = messages.length === 1 && messages[0].role === 'assistant';

    return (
        <div
            className="flex flex-col h-screen"
            style={{ background: '#09090b' }}
        >

            {/* ── Header ── */}
            <header
                className="shrink-0 sticky top-0 z-20 px-4 py-3"
                style={{
                    background: 'rgba(9,9,11,0.9)',
                    backdropFilter: 'blur(12px)',
                    borderBottom: '1px solid rgba(39,39,42,0.6)',
                }}
            >
                {/* Top row */}
                <div className="flex items-center justify-between mb-2.5">
                    <div className="flex items-center gap-2.5">
                        {/* Logo */}
                        <div
                            className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                            style={{
                                background: 'rgba(59,130,246,0.15)',
                                border: '1px solid rgba(59,130,246,0.25)',
                            }}
                        >
                            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                                <rect x="1" y="7" width="3" height="6" rx="0.5" fill="#3b82f6" />
                                <rect x="5.5" y="4" width="3" height="9" rx="0.5" fill="#3b82f6" opacity="0.7" />
                                <rect x="10" y="1" width="3" height="12" rx="0.5" fill="#3b82f6" opacity="0.45" />
                            </svg>
                        </div>
                        <span
                            className="text-sm font-semibold"
                            style={{ color: '#e4e4e7', letterSpacing: '-0.01em' }}
                        >
                            InsightVault
                        </span>
                    </div>

                    {/* No dataset warning */}
                    {!activeFileId && (
                        <div
                            className="flex items-center gap-1.5 text-xs px-3 py-1 rounded-full"
                            style={{
                                background: 'rgba(245,158,11,0.08)',
                                border: '1px solid rgba(245,158,11,0.2)',
                                color: '#fbbf24',
                            }}
                        >
                            <AlertCircle className="w-3 h-3" />
                            Upload a dataset first
                        </div>
                    )}
                </div>

                {/* Dataset chips row */}
                <div className="flex items-center gap-1.5 flex-wrap">
                    {datasets.map(ds => {
                        const isActive = activeFileId === ds.fileId;
                        return (
                            <button
                                key={ds.fileId}
                                onClick={() => setActiveFileId(ds.fileId)}
                                className="flex items-center gap-1.5 text-xs px-3 py-1 rounded-full transition-all duration-200"
                                style={
                                    isActive
                                        ? {
                                            background: 'rgba(37,99,235,0.2)',
                                            border: '1px solid rgba(59,130,246,0.5)',
                                            color: '#93c5fd',
                                            boxShadow: '0 0 12px rgba(59,130,246,0.15)',
                                        }
                                        : {
                                            background: 'rgba(24,24,27,0.8)',
                                            border: '1px solid rgba(63,63,70,0.6)',
                                            color: '#71717a',
                                        }
                                }
                            >
                                <span
                                    className="w-1.5 h-1.5 rounded-full shrink-0"
                                    style={{ background: isActive ? '#3b82f6' : '#3f3f46' }}
                                />
                                {ds.name}
                                <span
                                    onClick={e => { e.stopPropagation(); removeDataset(ds.fileId); }}
                                    className="ml-0.5 rounded-full p-0.5 transition-colors"
                                    style={{ color: isActive ? 'rgba(147,197,253,0.6)' : '#52525b' }}
                                >
                                    <X className="w-2.5 h-2.5" />
                                </span>
                            </button>
                        );
                    })}

                    {/* Add dataset button */}
                    <label
                        className="flex items-center gap-1.5 text-xs px-3 py-1 rounded-full cursor-pointer transition-all duration-200"
                        style={{
                            background: 'transparent',
                            border: `1px dashed ${isAddingDataset ? 'rgba(59,130,246,0.5)' : 'rgba(63,63,70,0.5)'}`,
                            color: isAddingDataset ? '#60a5fa' : '#52525b',
                        }}
                    >
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".csv"
                            className="hidden"
                            onChange={handleAddDataset}
                            disabled={isAddingDataset}
                        />
                        {isAddingDataset ? (
                            <><Loader2 className="w-3 h-3 animate-spin" /> Uploading...</>
                        ) : (
                            <><Plus className="w-3 h-3" /> Add dataset</>
                        )}
                    </label>
                </div>

                {/* Active dataset context label */}
                {activeDatasetName && (
                    <p
                        className="mt-1.5 text-[10px] tracking-wide"
                        style={{ fontFamily: 'var(--font-mono)', color: '#3f3f46' }}
                    >
                        querying:{' '}
                        <span style={{ color: '#2563eb' }}>{activeDatasetName}</span>
                    </p>
                )}
            </header>

            {/* ── Messages ── */}
            <div className="flex-1 overflow-y-auto px-4 py-6">

                {/* Empty state */}
                {isEmptyChat && activeFileId && (
                    <div className="flex flex-col items-center justify-center min-h-[40vh] mb-4 animate-fade-in">
                        <div
                            className="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
                            style={{
                                background: 'rgba(59,130,246,0.1)',
                                border: '1px solid rgba(59,130,246,0.2)',
                            }}
                        >
                            <Sparkles className="w-5 h-5" style={{ color: '#3b82f6' }} />
                        </div>
                        <p
                            className="text-sm font-medium mb-1"
                            style={{ color: '#71717a' }}
                        >
                            Dataset ready — try asking:
                        </p>
                        <div className="mt-3 flex flex-col gap-2 w-full max-w-xs">
                            {EXAMPLE_QUERIES.map(q => (
                                <button
                                    key={q}
                                    onClick={() => { setInput(q); }}
                                    className="text-left text-xs px-3 py-2 rounded-lg transition-all duration-150"
                                    style={{
                                        background: 'rgba(24,24,27,0.7)',
                                        border: '1px solid rgba(39,39,42,0.8)',
                                        color: '#71717a',
                                    }}
                                    onMouseEnter={e => {
                                        (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(59,130,246,0.3)';
                                        (e.currentTarget as HTMLButtonElement).style.color = '#a1a1aa';
                                    }}
                                    onMouseLeave={e => {
                                        (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(39,39,42,0.8)';
                                        (e.currentTarget as HTMLButtonElement).style.color = '#71717a';
                                    }}
                                >
                                    {q}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {/* Message list */}
                <div className="space-y-5 max-w-3xl mx-auto">
                    {messages.map((msg, i) => (
                        <div
                            key={i}
                            className={`flex animate-float-up ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                        >
                            {msg.role === 'user' ? (
                                /* User bubble */
                                <div
                                    className="max-w-[70%] text-sm leading-relaxed px-4 py-2.5"
                                    style={{
                                        background: 'rgba(37,99,235,0.85)',
                                        border: '1px solid rgba(59,130,246,0.3)',
                                        borderRadius: '14px 14px 4px 14px',
                                        color: '#dbeafe',
                                        boxShadow: '0 4px 16px rgba(37,99,235,0.2)',
                                    }}
                                >
                                    {msg.content}
                                </div>
                            ) : (
                                /* Assistant bubble */
                                <div className="max-w-[82%] space-y-1.5">
                                    <div
                                        className="text-sm leading-relaxed px-4 py-3"
                                        style={{
                                            background: 'rgba(18,18,20,0.9)',
                                            border: '1px solid rgba(39,39,42,0.8)',
                                            borderRadius: '4px 14px 14px 14px',
                                            color: '#d4d4d8',
                                        }}
                                    >
                                        {msg.content.split('\n').map((line, lineIdx, arr) => (
                                            <span key={lineIdx}>
                                                {line}
                                                {lineIdx < arr.length - 1 && <br />}
                                            </span>
                                        ))}
                                    </div>

                                    {/* Chart */}
                                    {msg.chartData && <ChartView chart={msg.chartData} />}

                                    {/* Dataset badge */}
                                    {msg.datasetName && datasets.length > 1 && (
                                        <div className="flex items-center gap-1 px-1">
                                            <span
                                                className="text-[10px] px-2 py-0.5 rounded-full"
                                                style={{
                                                    fontFamily: 'var(--font-mono)',
                                                    background: 'rgba(24,24,27,0.8)',
                                                    border: '1px solid rgba(39,39,42,0.7)',
                                                    color: '#3f3f46',
                                                }}
                                            >
                                                from: {msg.datasetName}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    ))}

                    {/* Typing indicator */}
                    {isTyping && (
                        <div className="flex justify-start animate-fade-in">
                            <div
                                className="flex items-center gap-1.5 px-4 py-3"
                                style={{
                                    background: 'rgba(18,18,20,0.9)',
                                    border: '1px solid rgba(39,39,42,0.8)',
                                    borderRadius: '4px 14px 14px 14px',
                                }}
                            >
                                <span className="w-1.5 h-1.5 rounded-full dot-bounce" style={{ background: '#3b82f6' }} />
                                <span className="w-1.5 h-1.5 rounded-full dot-bounce-2" style={{ background: '#3b82f6' }} />
                                <span className="w-1.5 h-1.5 rounded-full dot-bounce-3" style={{ background: '#3b82f6' }} />
                            </div>
                        </div>
                    )}

                    <div ref={bottomRef} />
                </div>
            </div>

            {/* ── Input bar ── */}
            <div
                className="shrink-0 px-4 pb-5 pt-3"
                style={{ borderTop: '1px solid rgba(39,39,42,0.5)' }}
            >
                <div
                    className="flex items-center gap-2 px-4 py-2 max-w-3xl mx-auto transition-all duration-200"
                    style={{
                        background: 'rgba(18,18,20,0.95)',
                        border: '1px solid rgba(63,63,70,0.6)',
                        borderRadius: '14px',
                    }}
                    onFocus={e => {
                        (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(59,130,246,0.5)';
                        (e.currentTarget as HTMLDivElement).style.boxShadow = '0 0 0 3px rgba(59,130,246,0.08)';
                    }}
                    onBlur={e => {
                        (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(63,63,70,0.6)';
                        (e.currentTarget as HTMLDivElement).style.boxShadow = 'none';
                    }}
                >
                    <input
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                        placeholder={
                            activeFileId
                                ? `Ask about ${activeDatasetName ?? 'your data'}…`
                                : 'Add a dataset to start'
                        }
                        disabled={!activeFileId || isTyping}
                        className="flex-1 bg-transparent text-sm focus:outline-none disabled:opacity-30 py-1.5"
                        style={{
                            color: '#e4e4e7',
                            caretColor: '#3b82f6',
                            fontFamily: 'var(--font-sans)',
                        }}
                    />
                    <button
                        onClick={handleSend}
                        disabled={!activeFileId || isTyping || !input.trim()}
                        className="w-8 h-8 flex items-center justify-center rounded-lg shrink-0 transition-all duration-150"
                        style={
                            activeFileId && !isTyping && input.trim()
                                ? {
                                    background: '#2563eb',
                                    border: '1px solid rgba(59,130,246,0.4)',
                                    color: '#fff',
                                    boxShadow: '0 0 12px rgba(37,99,235,0.3)',
                                }
                                : {
                                    background: 'rgba(39,39,42,0.5)',
                                    border: '1px solid rgba(63,63,70,0.4)',
                                    color: '#3f3f46',
                                }
                        }
                    >
                        <Send className="w-3.5 h-3.5" />
                    </button>
                </div>

                {/* Hint */}
                <p
                    className="text-center mt-2 text-[10px]"
                    style={{ fontFamily: 'var(--font-mono)', color: '#27272a' }}
                >
                    Enter to send · charts generated automatically
                </p>
            </div>
        </div>
    );
}

export default function ChatPage() {
    return (
        <Suspense fallback={
            <div
                className="flex items-center justify-center min-h-screen"
                style={{ background: '#09090b' }}
            >
                <Loader2 className="w-5 h-5 animate-spin" style={{ color: '#3b82f6' }} />
            </div>
        }>
            <ChatContent />
        </Suspense>
    );
}
