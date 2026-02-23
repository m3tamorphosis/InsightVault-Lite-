import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

const FILES_BUCKET = 'insightvault-files';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const fileId = searchParams.get('fileId');
    if (!fileId) {
      return NextResponse.json({ error: 'fileId required' }, { status: 400 });
    }

    const { data: fileMeta, error: fileError } = await supabaseAdmin
      .from('files')
      .select('type, name')
      .eq('id', fileId)
      .single();

    if (fileError || !fileMeta) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    if ((fileMeta as { type: string }).type !== 'pdf') {
      return NextResponse.json({ error: 'PDF files only' }, { status: 400 });
    }

    const { data: objects, error: listError } = await supabaseAdmin.storage
      .from(FILES_BUCKET)
      .list(fileId, { limit: 100 });
    if (listError) {
      return NextResponse.json({ error: listError.message }, { status: 500 });
    }

    const latest = [...(objects ?? [])]
      .filter(o => !!o.name && o.name.toLowerCase().endsWith('.pdf'))
      .sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())[0];
    if (!latest?.name) {
      return NextResponse.json({ error: 'No stored PDF preview available' }, { status: 404 });
    }

    const objectPath = `${fileId}/${latest.name}`;
    const { data: fileBlob, error: downloadError } = await supabaseAdmin.storage
      .from(FILES_BUCKET)
      .download(objectPath);
    if (downloadError || !fileBlob) {
      return NextResponse.json({ error: downloadError?.message ?? 'Failed to load PDF' }, { status: 500 });
    }

    const bytes = await fileBlob.arrayBuffer();
    const downloadName = (fileMeta as { name: string }).name || latest.name;
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${downloadName.replace(/"/g, '')}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

