import { NextResponse } from 'next/server';
import { getCsvRows, getFileType } from '@/lib/csv-store';

export interface PreviewData {
  headers: string[];
  rows: string[][];
  stats: ColumnStat[];
}

export interface ColumnStat {
  field: string;
  min: number;
  max: number;
  avg: number;
  nullCount: number;
  total: number;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const fileId = searchParams.get('fileId');
    if (!fileId) return NextResponse.json({ error: 'fileId required' }, { status: 400 });

    const fileType = await getFileType(fileId);
    if (fileType !== 'csv') return NextResponse.json({ error: 'CSV files only' }, { status: 400 });

    const records = await getCsvRows(fileId);
    if (!records.length) return NextResponse.json({ headers: [], rows: [], stats: [] });

    const headers = Object.keys(records[0]);
    const rows = records.slice(0, 8).map(r => headers.map(h => r[h] ?? ''));

    // Compute stats for numeric columns
    const stats: ColumnStat[] = [];
    for (const field of headers) {
      const vals = records.map(r => r[field]);
      const numVals = vals.map(v => parseFloat(v)).filter(n => !isNaN(n) && isFinite(n));
      if (numVals.length / vals.length > 0.6) {
        const nullCount = vals.filter(v => !v || v.trim() === '').length;
        const sum = numVals.reduce((a, b) => a + b, 0);
        stats.push({
          field,
          min: Math.min(...numVals),
          max: Math.max(...numVals),
          avg: parseFloat((sum / numVals.length).toFixed(2)),
          nullCount,
          total: records.length,
        });
      }
    }

    const data: PreviewData = { headers, rows, stats };
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Preview failed' }, { status: 500 });
  }
}
