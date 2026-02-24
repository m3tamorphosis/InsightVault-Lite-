import { getSupabaseAdmin } from './supabase';

function sanitizePostgresText(input: string): string {
    // PostgreSQL text values cannot contain null bytes.
    return input.replace(/\u0000/g, '');
}

/**
 * Efficiently inserts multiple chunks into Supabase.
 */
export async function storeChunks(
    fileId: string,
    chunks: { content: string; embedding: number[]; pageNumber?: number }[]
): Promise<void> {
    const { error } = await getSupabaseAdmin()
        .from('chunks')
        .insert(
            chunks.map(chunk => ({
                file_id: fileId,
                content: sanitizePostgresText(chunk.content),
                embedding: chunk.embedding,
                page_number: chunk.pageNumber ?? null,
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

/**
 * Performs similarity search in Supabase using the match_chunks function.
 */
export async function searchSimilarChunks(
    queryEmbedding: number[],
    fileId: string,
    threshold = 0.5,
    limit = 5
) {
    const { data, error } = await getSupabaseAdmin().rpc('match_chunks', {
        query_embedding: queryEmbedding,
        match_threshold: threshold,
        match_count: limit,
        filter_file_id: fileId,
    });

    if (error) {
        console.error('Supabase Search Error:', error);
        throw new Error('Failed to search for similar context');
    }

    return data as { id: string; content: string; similarity: number; page_number: number | null }[];
}

/**
 * Fetches ALL content chunks for a file (used for full-dataset aggregations).
 */
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

