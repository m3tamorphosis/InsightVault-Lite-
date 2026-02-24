import { NextResponse } from 'next/server';
import { getOpenAI, createQueryEmbedding } from '@/lib/openai';
import { getCsvRows, getFileType } from '@/lib/csv-store';
import { searchSimilarChunks } from '@/lib/vector-store';

const FALLBACK_CSV = [
  'What are the top 5 rows by value?',
  'Show me a chart of totals by category',
  'What is the average across all records?',
  'Find any outliers or anomalies',
];

const FALLBACK_PDF = [
  'What is this document about?',
  'Summarise the key points',
  'What are the main conclusions?',
  'Find any specific numbers or statistics',
];

function parseSuggestions(text: string | null | undefined): string[] | null {
  if (!text) return null;
  try {
    const json = text.replace(/```json|```/g, '').trim();
    const arr = JSON.parse(json);
    if (Array.isArray(arr) && arr.length > 0) return (arr as unknown[]).map(String).slice(0, 4);
  } catch { /* fall through */ }
  return null;
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

      const allFields = Object.keys(records[0]);
      const numericFields: string[] = [];
      const categoricalFields: string[] = [];
      const sampleValues: Record<string, string[]> = {};

      for (const field of allFields) {
        const vals = records.slice(0, 200).map(r => r[field]).filter(Boolean);
        if (!vals.length) continue;
        const numCount = vals.filter(v => !isNaN(parseFloat(v)) && isFinite(+v)).length;
        if (numCount / vals.length > 0.6) {
          numericFields.push(field);
        } else {
          categoricalFields.push(field);
          sampleValues[field] = [...new Set(vals)].slice(0, 4);
        }
      }

      const schemaDesc = [
        `${records.length} rows.`,
        `Columns: ${allFields.join(', ')}.`,
        numericFields.length ? `Numeric fields: ${numericFields.join(', ')}.` : '',
        categoricalFields.length
          ? `Categorical fields: ${categoricalFields
              .map(f => `${f} (e.g. ${(sampleValues[f] ?? []).slice(0, 3).join(', ')})`)
              .join('; ')}.`
          : '',
      ].filter(Boolean).join(' ');

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0.7,
        messages: [{
          role: 'user',
          content: `You are helping a user explore a CSV dataset. Here is the dataset schema:

${schemaDesc}

Generate exactly 4 specific, interesting questions the user might ask. Requirements:
- Reference actual column names and example values from the schema
- Cover different analysis types: one ranking question, one aggregation or average, one breakdown by category, and one trend or outlier question
- Make each question feel natural and specific (not generic)
${exclude.length ? `- Do NOT repeat or rephrase any of these already-asked questions: ${exclude.map(q => `"${q}"`).join(', ')}` : ''}

Return ONLY a JSON array of 4 strings. No markdown, no explanation.`,
        }],
      });

      const suggestions = parseSuggestions(response.choices[0].message.content);
      return NextResponse.json({ suggestions: suggestions ?? FALLBACK_CSV });
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
- Phrase them naturally as a curious reader would
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

