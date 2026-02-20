import { NextResponse } from 'next/server';
import Papa from 'papaparse';
import { rowToText } from '@/lib/csv-utils';
import { createEmbeddings } from '@/lib/openai';
import { supabaseAdmin } from '@/lib/supabase';
import { storeChunks } from '@/lib/vector-store';

export async function POST(req: Request) {
    try {
        const formData = await req.formData();
        const file = formData.get('file') as File;

        if (!file) {
            return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
        }

        const text = await file.text();
        const { data, errors } = Papa.parse(text, {
            header: true,
            skipEmptyLines: true
        });

        if (errors.length > 0) {
            return NextResponse.json({ error: 'CSV parsing error', details: errors }, { status: 400 });
        }

        // 1. Register file
        const { data: fileData, error: fileError } = await supabaseAdmin
            .from('files')
            .insert({ name: file.name })
            .select()
            .single();

        if (fileError) throw fileError;

        // 2. Prepare text content from rows
        const rows = data as any[];
        const columns = Object.keys(rows[0] || {});

        // Add a schema chunk so questions like "what are the columns/headers?" get answered
        const schemaChunk = `This dataset has ${rows.length} rows and ${columns.length} columns. The column names (headers) are: ${columns.join(', ')}.`;
        const rowTexts = [schemaChunk, ...rows.map(row => rowToText(row))];

        // 3. Generate embeddings
        const embeddings = await createEmbeddings(rowTexts);

        // 4. Batch insert into Supabase
        const chunksToStore = rowTexts.map((content, i) => ({
            content,
            embedding: embeddings[i],
        }));

        await storeChunks(fileData.id, chunksToStore);

        return NextResponse.json({
            success: true,
            message: `Processed ${data.length} rows from ${file.name}`,
            fileId: fileData.id
        });
    } catch (error: any) {
        console.error('Upload API Error:', error);
        return NextResponse.json({ error: error.message || 'Upload failed' }, { status: 500 });
    }
}
