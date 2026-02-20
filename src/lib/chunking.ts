/**
 * Splits text into chunks of 500-1000 characters.
 * RAG requires chunking because:
 * 1. LLMs have context limits (too much text won't fit).
 * 2. It helps retrieve only the most relevant sections of data.
 * 3. It improves retrieval precision by focusing on smaller contexts.
 */
export function chunkText(text: string, minSize = 500, maxSize = 1000): string[] {
    const chunks: string[] = [];
    let startIndex = 0;

    while (startIndex < text.length) {
        let endIndex = startIndex + maxSize;

        // If not at the end, try to find a good breaking point (period or newline)
        if (endIndex < text.length) {
            const remainingText = text.slice(startIndex, startIndex + maxSize + 200); // look ahead a bit
            const lastPeriod = remainingText.lastIndexOf('.', maxSize);
            const lastNewline = remainingText.lastIndexOf('\n', maxSize);

            const breakPoint = Math.max(lastPeriod, lastNewline);

            if (breakPoint > minSize) {
                endIndex = startIndex + breakPoint + 1;
            }
        }

        chunks.push(text.slice(startIndex, endIndex).trim());
        startIndex = endIndex;
    }

    return chunks.filter(c => c.length > 0);
}
