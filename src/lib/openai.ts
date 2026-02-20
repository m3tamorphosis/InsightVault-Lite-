import OpenAI from 'openai';

export const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// text-embedding-3-small: max 300,000 tokens per request
// Each CSV row is typically 100-600 tokens; 100 rows/batch stays well under the limit.
const EMBEDDING_BATCH_SIZE = 100;

/**
 * Generates embeddings for an array of strings.
 * Automatically batches large inputs to stay within the 300K token/request limit.
 */
export async function createEmbeddings(inputs: string[]) {
    const all: number[][] = [];
    for (let i = 0; i < inputs.length; i += EMBEDDING_BATCH_SIZE) {
        const batch = inputs.slice(i, i + EMBEDDING_BATCH_SIZE);
        try {
            const response = await openai.embeddings.create({
                model: 'text-embedding-3-small',
                input: batch,
            });
            all.push(...response.data.map(item => item.embedding));
        } catch (error: any) {
            console.error('OpenAI Embeddings Error (full):', JSON.stringify(error?.message || error));
            throw new Error(`OpenAI Error: ${error?.message || JSON.stringify(error)}`);
        }
    }
    return all;
}

/**
 * Generates an embedding for a single user query.
 */
export async function createQueryEmbedding(query: string) {
    const result = await createEmbeddings([query]);
    return result[0];
}
