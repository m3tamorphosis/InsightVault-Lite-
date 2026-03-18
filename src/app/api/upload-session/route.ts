import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getErrorMessage } from '@/lib/error-utils';

export const runtime = 'nodejs';

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const FILES_BUCKET = 'insightvault-files';

async function ensureFilesBucket(): Promise<void> {
  const { error } = await getSupabaseAdmin().storage.createBucket(FILES_BUCKET, {
    public: false,
  });
  if (!error) return;
  const msg = error.message.toLowerCase();
  if (msg.includes('already exists') || msg.includes('duplicate')) return;
  throw new Error(`Failed to initialize storage bucket: ${error.message}`);
}

type SessionRequest = {
  fileName?: string;
  fileSize?: number;
  category?: string;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as SessionRequest;
    const fileName = String(body.fileName ?? '').trim();
    const fileSize = Number(body.fileSize ?? 0);
    const requestedCategory = String(body.category ?? '').trim() || null;

    if (!fileName) {
      return NextResponse.json({ error: 'Missing file name' }, { status: 400 });
    }
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      return NextResponse.json({ error: 'Invalid file size' }, { status: 400 });
    }

    const nameLower = fileName.toLowerCase();
    const isCSV = nameLower.endsWith('.csv');
    const isPDF = nameLower.endsWith('.pdf');
    if (!isCSV && !isPDF) {
      return NextResponse.json(
        { error: 'Unsupported file type. Please upload a CSV or PDF file.' },
        { status: 400 }
      );
    }
    if (fileSize > MAX_FILE_SIZE) {
      const msg = isPDF ? 'PDF file is too large (max 20 MB)' : 'CSV file is too large (max 20 MB)';
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    const fileType = isCSV ? 'csv' : 'pdf';
    const category = requestedCategory || (fileType === 'pdf' ? 'document' : 'tabular');

    const { data: fileData, error: fileError } = await getSupabaseAdmin()
      .from('files')
      .insert({ name: fileName, type: fileType, source: fileName, category })
      .select()
      .single();

    if (fileError) throw fileError;
    const fileId: string = (fileData as { id: string }).id;

    const safeName = fileName.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const storagePath = `${fileId}/${Date.now()}-${safeName}`;

    await ensureFilesBucket();
    const { data: signed, error: signedError } = await getSupabaseAdmin().storage
      .from(FILES_BUCKET)
      .createSignedUploadUrl(storagePath);

    if (signedError) {
      throw new Error(`Failed to create upload session: ${signedError.message}`);
    }

    return NextResponse.json({
      success: true,
      fileId,
      fileType,
      storagePath,
      token: signed.token,
    });
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
    console.error('Upload Session API Error:', msg);
    return NextResponse.json({ error: msg || 'Failed to create upload session' }, { status: 500 });
  }
}

