import { NextResponse } from 'next/server';
import Papa from 'papaparse';
import { createEmbeddings } from '@/lib/openai';
import { supabaseAdmin } from '@/lib/supabase';
import { storeChunks } from '@/lib/vector-store';
import { storeCsvRows } from '@/lib/csv-store';
import { chunkText, chunkTextWithPages } from '@/lib/chunking';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File too large (max 50 MB)' }, { status: 400 });
    }

    const nameLower = file.name.toLowerCase();
    const isCSV = nameLower.endsWith('.csv');
    const isPDF = nameLower.endsWith('.pdf');

    if (!isCSV && !isPDF) {
      return NextResponse.json(
        { error: 'Unsupported file type. Please upload a CSV or PDF file.' },
        { status: 400 }
      );
    }

    const fileType = isCSV ? 'csv' : 'pdf';

    // Register file in the files table
    const { data: fileData, error: fileError } = await supabaseAdmin
      .from('files')
      .insert({ name: file.name, type: fileType })
      .select()
      .single();

    if (fileError) throw fileError;
    const fileId: string = (fileData as { id: string }).id;

    // ── CSV path: parse rows → store as JSONB ──────────────────────────────
    if (isCSV) {
      const text = await file.text();
      const { data, errors } = Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
      });

      if (errors.length > 0) {
        return NextResponse.json({ error: 'CSV parsing error', details: errors }, { status: 400 });
      }

      const rows = data as Record<string, unknown>[];
      if (rows.length === 0) {
        return NextResponse.json({ error: 'CSV file is empty' }, { status: 400 });
      }

      await storeCsvRows(fileId, rows);

      return NextResponse.json({
        success: true,
        message: `Loaded ${rows.length} rows from ${file.name}`,
        fileId,
        fileType: 'csv',
      });
    }

    // ── PDF path: extract text → chunk → embed → store vectors ────────────
    const arrayBuf = await file.arrayBuffer();

    // pdf-parse v2 uses a class-based API: new PDFParse({ data }) then .getText()
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(arrayBuf) });
    const pdfData = await parser.getText();
    await parser.destroy();
    const text = pdfData.text?.trim();

    if (!text) {
      return NextResponse.json(
        { error: 'Could not extract text from PDF. The file may be scanned or image-only.' },
        { status: 400 }
      );
    }

    const pageChunks = chunkTextWithPages(text);
    if (pageChunks.length === 0) {
      return NextResponse.json({ error: 'No readable content found in PDF.' }, { status: 400 });
    }

    const chunkContents = pageChunks.map(c => c.content);
    const embeddings = await createEmbeddings(chunkContents);
    await storeChunks(
      fileId,
      pageChunks.map((c, i) => ({ content: c.content, embedding: embeddings[i], pageNumber: c.pageNumber }))
    );

    return NextResponse.json({
      success: true,
      message: `Processed ${pageChunks.length} chunks from ${file.name}`,
      fileId,
      fileType: 'pdf',
    });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('Upload API Error:', msg);
    return NextResponse.json({ error: msg || 'Upload failed' }, { status: 500 });
  }
}
