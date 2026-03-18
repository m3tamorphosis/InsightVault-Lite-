import { getSupabaseAdmin } from './supabase';

export interface ChunkMetadata {
    fileType?: 'csv' | 'pdf';
    category?: string | null;
    source?: string | null;
    [key: string]: unknown;
}

function sanitizePostgresText(input: string): string {
    return input.replace(/\u0000/g, '');
}

export async function storeChunks(
    fileId: string,
    chunks: { content: string; embedding: number[]; pageNumber?: number; metadata?: ChunkMetadata }[]
): Promise<void> {
    const { error } = await getSupabaseAdmin()
        .from('chunks')
        .insert(
            chunks.map(chunk => ({
                file_id: fileId,
                content: sanitizePostgresText(chunk.content),
                embedding: chunk.embedding,
                page_number: chunk.pageNumber ?? null,
                file_type: chunk.metadata?.fileType ?? null,
                category: chunk.metadata?.category ?? null,
                source: chunk.metadata?.source ?? null,
                metadata: chunk.metadata ?? {},
            }))
        );

    if (error) {
        console.error('Supabase Store Chunks Error:', error);
        const detail = [error.message, error.details, error.hint]
            .filter(Boolean)
            .join(' | ');
        throw new Error(`Failed to store chunks in database: ${detail || 'Unknown Supabase error'}`);
    }
}

export async function searchSimilarChunks(
    queryEmbedding: number[],
    fileId: string,
    threshold = 0.5,
    limit = 5,
    filters?: { fileType?: 'csv' | 'pdf'; category?: string; source?: string }
) {
    const { data, error } = await getSupabaseAdmin().rpc('match_chunks', {
        query_embedding: queryEmbedding,
        match_threshold: threshold,
        match_count: limit,
        filter_file_id: fileId,
        filter_file_type: filters?.fileType ?? null,
        filter_category: filters?.category ?? null,
        filter_source: filters?.source ?? null,
    });

    if (error) {
        console.error('Supabase Search Error:', error);
        throw new Error('Failed to search for similar context');
    }

    return data as {
        id: string;
        content: string;
        similarity: number;
        page_number: number | null;
        file_type: 'csv' | 'pdf' | null;
        category: string | null;
        source: string | null;
        metadata: Record<string, unknown> | null;
    }[];
}

export async function getAllChunks(fileId: string): Promise<string[]> {
    const { data, error } = await getSupabaseAdmin()
        .from('chunks')
        .select('content')
        .eq('file_id', fileId)
        .order('id', { ascending: true });

    if (error) {
        console.error('Supabase GetAllChunks Error:', error);
        throw new Error('Failed to fetch all chunks');
    }

    return (data as { content: string }[]).map(d => d.content);
}
