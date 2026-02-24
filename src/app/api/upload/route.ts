import { NextResponse } from 'next/server';
import Papa from 'papaparse';
import { createEmbeddings } from '@/lib/openai';
import { getSupabaseAdmin } from '@/lib/supabase';
import { storeChunks } from '@/lib/vector-store';
import { storeCsvRows } from '@/lib/csv-store';
import { chunkText, chunkTextWithPages } from '@/lib/chunking';

export const runtime = 'nodejs';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const FILES_BUCKET = 'insightvault-files';

let pdfGlobalsInitialized = false;

async function ensurePdfGlobals(): Promise<void> {
  if (pdfGlobalsInitialized) return;
  const g = globalThis as typeof globalThis & {
    DOMMatrix?: unknown;
    ImageData?: unknown;
    Path2D?: unknown;
  };

  if (!g.DOMMatrix) {
    class DOMMatrixShim {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
      m11 = 1; m12 = 0; m13 = 0; m14 = 0;
      m21 = 0; m22 = 1; m23 = 0; m24 = 0;
      m31 = 0; m32 = 0; m33 = 1; m34 = 0;
      m41 = 0; m42 = 0; m43 = 0; m44 = 1;
      is2D = true;
      isIdentity = true;
      constructor(init?: number[] | Float32Array | Float64Array | string) {
        if (Array.isArray(init) || init instanceof Float32Array || init instanceof Float64Array) {
          const v = Array.from(init);
          if (v.length >= 6) {
            this.a = this.m11 = v[0] ?? 1;
            this.b = this.m12 = v[1] ?? 0;
            this.c = this.m21 = v[2] ?? 0;
            this.d = this.m22 = v[3] ?? 1;
            this.e = this.m41 = v[4] ?? 0;
            this.f = this.m42 = v[5] ?? 0;
          }
        }
      }
      multiplySelf() { return this; }
      preMultiplySelf() { return this; }
      invertSelf() { return this; }
      translateSelf() { return this; }
      scaleSelf() { return this; }
      rotateSelf() { return this; }
      rotateFromVectorSelf() { return this; }
      skewXSelf() { return this; }
      skewYSelf() { return this; }
      setMatrixValue() { return this; }
      toString() { return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`; }
      toFloat32Array() { return new Float32Array([this.a, this.b, 0, 0, this.c, this.d, 0, 0, 0, 0, 1, 0, this.e, this.f, 0, 1]); }
      toFloat64Array() { return new Float64Array([this.a, this.b, 0, 0, this.c, this.d, 0, 0, 0, 0, 1, 0, this.e, this.f, 0, 1]); }
      static fromMatrix() { return new DOMMatrixShim(); }
    }
    (g as { DOMMatrix?: unknown }).DOMMatrix = DOMMatrixShim as unknown;
  }

  if (!g.ImageData) {
    class ImageDataShim {
      data: Uint8ClampedArray;
      width: number;
      height: number;
      constructor(dataOrWidth: Uint8ClampedArray | number, width?: number, height?: number) {
        if (typeof dataOrWidth === 'number') {
          this.width = dataOrWidth;
          this.height = width ?? 1;
          this.data = new Uint8ClampedArray(this.width * this.height * 4);
        } else {
          this.data = dataOrWidth;
          this.width = width ?? 1;
          this.height = height ?? 1;
        }
      }
    }
    (g as { ImageData?: unknown }).ImageData = ImageDataShim as unknown;
  }

  if (!g.Path2D) {
    class Path2DShim {}
    (g as { Path2D?: unknown }).Path2D = Path2DShim as unknown;
  }
  pdfGlobalsInitialized = true;
}

async function ensureFilesBucket(): Promise<void> {
  const { error } = await getSupabaseAdmin().storage.createBucket(FILES_BUCKET, {
    public: false,
  });
  if (!error) return;
  const msg = error.message.toLowerCase();
  if (msg.includes('already exists') || msg.includes('duplicate')) return;
  throw new Error(`Failed to initialize storage bucket: ${error.message}`);
}

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
    const { data: fileData, error: fileError } = await getSupabaseAdmin()
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
    const pdfBytes = new Uint8Array(await file.arrayBuffer());
    // Keep parsing and storage bytes separate because parser internals may detach buffers.
    const parseBytes = pdfBytes.slice();

    // pdf-parse v2 uses a class-based API: new PDFParse({ data }) then .getText()
    await ensurePdfGlobals();
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: parseBytes });
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

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const storagePath = `${fileId}/${Date.now()}-${safeName}`;
    await ensureFilesBucket();
    const { error: storageError } = await getSupabaseAdmin().storage
      .from(FILES_BUCKET)
      .upload(storagePath, pdfBytes, {
        contentType: file.type || 'application/pdf',
        upsert: true,
      });
    if (storageError) {
      throw new Error(`Failed to store PDF for preview: ${storageError.message}`);
    }

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

