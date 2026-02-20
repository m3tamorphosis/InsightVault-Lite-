import { supabaseAdmin } from './supabase';

/**
 * Efficiently inserts multiple chunks into Supabase.
 */
export async function storeChunks(fileId: string, chunks: { content: string; embedding: number[] }[]) {
    const { error } = await supabaseAdmin
        .from('chunks')
        .insert(
            chunks.map(chunk => ({
                file_id: fileId,
                content: chunk.content,
                embedding: chunk.embedding,
            }))
        );

    if (error) {
        console.error('Supabase Store Chunks Error:', error);
        throw new Error('Failed to store chunks in database');
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
    const { data, error } = await supabaseAdmin.rpc('match_chunks', {
        query_embedding: queryEmbedding,
        match_threshold: threshold,
        match_count: limit,
        filter_file_id: fileId,
    });

    if (error) {
        console.error('Supabase Search Error:', error);
        throw new Error('Failed to search for similar context');
    }

    return data as { id: string; content: string; similarity: number }[];
}

/**
 * Fetches ALL content chunks for a file (used for full-dataset aggregations).
 */
export async function getAllChunks(fileId: string): Promise<string[]> {
    const { data, error } = await supabaseAdmin
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
