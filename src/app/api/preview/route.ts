import { NextResponse } from 'next/server';
import { getCsvRows, getFileType } from '@/lib/csv-store';

export interface PreviewData {
  headers: string[];
  rows: string[][];
  stats: ColumnStat[];
  totalRows?: number;
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
    const page = Math.max(0, parseInt(searchParams.get('page') ?? '0', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') ?? '20', 10)));
    const totalRows = records.length;
    const rows = records.slice(page * pageSize, (page + 1) * pageSize).map(r => headers.map(h => r[h] ?? ''));

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
          min: numVals.reduce((a, b) => (b < a ? b : a), Infinity),
          max: numVals.reduce((a, b) => (b > a ? b : a), -Infinity),
          avg: parseFloat((sum / numVals.length).toFixed(2)),
          nullCount,
          total: records.length,
        });
      }
    }

    const data: PreviewData = { headers, rows, stats, totalRows };
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Preview failed' }, { status: 500 });
  }
}
