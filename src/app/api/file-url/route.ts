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

    const { data, error } = await supabaseAdmin
      .from('files')
      .select('type')
      .eq('id', fileId)
      .single();

    if (error || !data) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
    if ((data as { type: string }).type !== 'pdf') {
      return NextResponse.json({ error: 'PDF files only' }, { status: 400 });
    }

    const { data: objects, error: listError } = await supabaseAdmin.storage
      .from(FILES_BUCKET)
      .list(fileId, { limit: 100 });
    if (listError) {
      return NextResponse.json({ error: listError.message }, { status: 500 });
    }
    if (!objects || objects.length === 0) {
      return NextResponse.json({ error: 'No stored PDF preview available' }, { status: 404 });
    }
    const latest = [...objects]
      .filter(o => !!o.name)
      .sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())[0];
    if (!latest?.name) {
      return NextResponse.json({ error: 'No stored PDF preview available' }, { status: 404 });
    }
    const storagePath = `${fileId}/${latest.name}`;

    const { data: signed, error: signedError } = await supabaseAdmin.storage
      .from(FILES_BUCKET)
      .createSignedUrl(storagePath, 60 * 60);

    if (signedError || !signed?.signedUrl) {
      return NextResponse.json({ error: signedError?.message ?? 'Failed to create signed URL' }, { status: 500 });
    }

    return NextResponse.json({ url: signed.signedUrl });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
