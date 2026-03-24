import { NextResponse } from 'next/server';
import { getOpenAI, createQueryEmbedding } from '@/lib/openai';
import { getCsvRows, getFileType } from '@/lib/csv-store';
import { searchSimilarChunks } from '@/lib/vector-store';

const FALLBACK_CSV = [
  'Rank the regions by total sales and show the most appropriate chart.',
  'Show the sales trend over time and explain the main pattern.',
  'How does total sales break down by category? Explain the distribution and show the most appropriate chart.',
  'Which product has the highest total sales?',
  'How does the total sales amount vary by region for the product Laptop? Explain the result briefly and show the most appropriate chart.',
  'Compare the highest and lowest sales records, summarize the result for a manager, and send it to Slack.',
];

const FALLBACK_PDF = [
  'What is this document about?',
  'Summarise the key points',
  'What are the main conclusions?',
  'Find any specific numbers or statistics',
];

function normalizeSuggestion(text: string): string {
  return text
    .replace(/'([A-Za-z_][A-Za-z0-9_]*)'/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSuggestions(text: string | null | undefined): string[] | null {
  if (!text) return null;
  try {
    const json = text.replace(/```json|```/g, '').trim();
    const arr = JSON.parse(json);
    if (Array.isArray(arr) && arr.length > 0) return (arr as unknown[]).map(value => normalizeSuggestion(String(value))).slice(0, 4);
  } catch { /* fall through */ }
  return null;
}


function findHeader(headers: string[], candidates: string[]): string | null {
  for (const candidate of candidates) {
    const exact = headers.find(header => header.toLowerCase() == candidate);
    if (exact) return exact;
  }
  for (const candidate of candidates) {
    const partial = headers.find(header => header.toLowerCase().includes(candidate));
    if (partial) return partial;
  }
  return null;
}

function buildCsvSuggestions(records: Array<Record<string, string>>, exclude: string[]): string[] {
  if (records.length === 0) return FALLBACK_CSV;

  const headers = Object.keys(records[0]);
  const totalField = findHeader(headers, ['total', 'sales', 'amount', 'revenue', 'value']);
  const regionField = findHeader(headers, ['region', 'city', 'location']);
  const categoryField = findHeader(headers, ['category']);
  const productField = findHeader(headers, ['product', 'name', 'item', 'title']);
  const dateField = findHeader(headers, ['order_date', 'date', 'created_at']);

  const sampleProduct = productField
    ? records.map(row => String(row[productField] ?? '').trim()).find(Boolean)
    : null;

  const suggestions: string[] = [];

  if (regionField && totalField) {
    suggestions.push(`Rank the ${regionField} values by ${totalField} and show the most appropriate chart.`);
  }
  if (dateField && totalField) {
    suggestions.push(`Show the ${totalField} trend over ${dateField} and explain the main pattern.`);
  }
  if (categoryField && totalField) {
    suggestions.push(`How does ${totalField} break down by ${categoryField}? Explain the distribution and show the most appropriate chart.`);
  }
  if (productField && totalField) {
    suggestions.push(`Which ${productField} has the highest ${totalField}?`);
  }
  if (productField && regionField && totalField && sampleProduct) {
    suggestions.push(`How does the ${totalField} amount vary by ${regionField} for the ${productField} ${sampleProduct}? Explain the result briefly and show the most appropriate chart.`);
  }
  suggestions.push('Compare the highest and lowest sales records, summarize the result for a manager, and send it to Slack.');

  const normalizedExclude = new Set(exclude.map(item => normalizeSuggestion(item).toLowerCase()));
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const suggestion of suggestions) {
    const normalized = normalizeSuggestion(suggestion);
    const key = normalized.toLowerCase();
    if (seen.has(key) || normalizedExclude.has(key)) continue;
    seen.add(key);
    deduped.push(normalized);
  }

  return deduped.length > 0 ? deduped.slice(0, 6) : FALLBACK_CSV;
}

export async function GET(req: Request) {
  let fallback = FALLBACK_CSV;
  try {
    const openai = getOpenAI();
    const { searchParams } = new URL(req.url);
    const fileId = searchParams.get('fileId');
    if (!fileId) return NextResponse.json({ suggestions: fallback });

    const excludeRaw = searchParams.get('exclude');
    const exclude: string[] = excludeRaw ? (() => { try { return JSON.parse(excludeRaw); } catch { return []; } })() : [];

    const fileType = await getFileType(fileId);
    fallback = fileType === 'pdf' ? FALLBACK_PDF : FALLBACK_CSV;

    // ── CSV: schema-aware suggestions ──────────────────────────────────────
    if (fileType === 'csv') {
      const records = await getCsvRows(fileId);
      if (records.length === 0) return NextResponse.json({ suggestions: FALLBACK_CSV });

      const suggestions = buildCsvSuggestions(records, exclude);
      return NextResponse.json({ suggestions });
    }

    // ── PDF: content-aware suggestions ─────────────────────────────────────
    const embedding = await createQueryEmbedding('overview main topics summary key points');
    const chunks = await searchSimilarChunks(embedding, fileId, 0.0, 6);
    const sample = chunks.map(c => c.content).join('\n---\n').slice(0, 2500);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.7,
      messages: [{
        role: 'user',
        content: `You are helping a user explore an uploaded document. Here is a sample of the document content:

${sample || 'No content available.'}

Generate exactly 4 specific questions a reader would naturally want to ask about this document. Requirements:
- Make them specific to the actual content shown, not generic
- Cover: what the document is about, a key claim or finding, a specific detail or number, and a broader takeaway or implication
- Phrase them naturally and professionally
- Do not suggest charts, graphs, plots, visualizations, dashboards, or spreadsheet analysis
- Keep the questions focused on document understanding, evidence, findings, qualifications, claims, or implications
- Do not wrap section names, field names, or example values in quotation marks
${exclude.length ? `- Do NOT repeat or rephrase any of these already-asked questions: ${exclude.map(q => `"${q}"`).join(', ')}` : ''}

Return ONLY a JSON array of 4 strings. No markdown, no explanation.`,
      }],
    });

    const suggestions = parseSuggestions(response.choices[0].message.content);
    return NextResponse.json({ suggestions: suggestions ?? FALLBACK_PDF });

  } catch {
    return NextResponse.json({ suggestions: fallback });
  }
}

