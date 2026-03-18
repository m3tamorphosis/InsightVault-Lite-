function normalizeParagraphs(text: string): string[] {
    return text
        .replace(/\r\n/g, '\n')
        .split(/\n\s*\n+/)
        .map(part => part.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
}

function splitLargeParagraph(paragraph: string, maxSize: number): string[] {
    if (paragraph.length <= maxSize) return [paragraph];

    const sentences = paragraph.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (sentences.length <= 1) {
        const parts: string[] = [];
        for (let index = 0; index < paragraph.length; index += maxSize) {
            parts.push(paragraph.slice(index, index + maxSize).trim());
        }
        return parts.filter(Boolean);
    }

    const chunks: string[] = [];
    let current = '';

    for (const sentence of sentences) {
        const candidate = current ? `${current} ${sentence}` : sentence;
        if (candidate.length <= maxSize) {
            current = candidate;
            continue;
        }

        if (current) chunks.push(current.trim());
        current = sentence;
    }

    if (current) chunks.push(current.trim());
    return chunks.filter(Boolean);
}

/**
 * Splits text by sections and paragraphs first, then merges them into retrieval-friendly chunks.
 */
export function chunkText(text: string, minSize = 500, maxSize = 1200): string[] {
    const chunks: string[] = [];
    const paragraphs = normalizeParagraphs(text).flatMap(paragraph => splitLargeParagraph(paragraph, maxSize));

    let current = '';
    for (const paragraph of paragraphs) {
        const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
        if (candidate.length <= maxSize) {
            current = candidate;
            continue;
        }

        if (current) chunks.push(current.trim());
        current = paragraph;
    }

    if (current) chunks.push(current.trim());

    const merged: string[] = [];
    for (const chunk of chunks) {
        const previous = merged[merged.length - 1];
        if (previous && previous.length < minSize) {
            merged[merged.length - 1] = `${previous}\n\n${chunk}`.trim();
        } else {
            merged.push(chunk);
        }
    }

    return merged.filter(Boolean);
}

export interface TextChunk {
  content: string;
  pageNumber: number;
}

export function chunkTextWithPages(text: string, minSize = 500, maxSize = 1000): TextChunk[] {
  const pages = text.split('\f');
  const result: TextChunk[] = [];

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const pageText = pages[pageIdx].trim();
    if (!pageText) continue;
    const pageNum = pageIdx + 1;
    const pageChunks = chunkText(pageText, minSize, maxSize);
    for (const c of pageChunks) {
      if (c) result.push({ content: c, pageNumber: pageNum });
    }
  }

  if (result.length === 0) {
    return chunkText(text, minSize, maxSize).map(c => ({ content: c, pageNumber: 1 }));
  }
  return result;
}
