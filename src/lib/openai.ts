import OpenAI from 'openai';

let client: OpenAI | null = null;

export function getOpenAI(): OpenAI {
    if (client) return client;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error(
            'The OPENAI_API_KEY environment variable is missing or empty; set it before calling OpenAI APIs.'
        );
    }

    client = new OpenAI({ apiKey });
    return client;
}

// text-embedding-3-small: max 300,000 tokens per request
// Each CSV row is typically 100-600 tokens; 100 rows/batch stays well under the limit.
const EMBEDDING_BATCH_SIZE = 100;

/**
 * Generates embeddings for an array of strings.
 * Automatically batches large inputs to stay within the 300K token/request limit.
 */
export async function createEmbeddings(inputs: string[]) {
    const openai = getOpenAI();
    const all: number[][] = [];
    for (let i = 0; i < inputs.length; i += EMBEDDING_BATCH_SIZE) {
        const batch = inputs.slice(i, i + EMBEDDING_BATCH_SIZE);
        try {
            const response = await openai.embeddings.create({
                model: 'text-embedding-3-small',
                input: batch,
            });
            all.push(...response.data.map(item => item.embedding));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : JSON.stringify(error);
            console.error('OpenAI Embeddings Error (full):', msg);
            throw new Error(`OpenAI Error: ${msg}`);
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
