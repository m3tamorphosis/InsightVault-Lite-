import { NextResponse } from 'next/server';
import { openai, createQueryEmbedding } from '@/lib/openai';
import { getCsvRows, getFileType } from '@/lib/csv-store';
import { searchSimilarChunks } from '@/lib/vector-store';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const fileId = searchParams.get('fileId');
    if (!fileId) return NextResponse.json({ summary: '' });

    const fileType = await getFileType(fileId);

    if (fileType === 'csv') {
      const records = await getCsvRows(fileId);
      if (!records.length) return NextResponse.json({ summary: '' });
      const fields = Object.keys(records[0]);
      const numericFields = fields.filter(f => {
        const vals = records.slice(0, 50).map(r => r[f]).filter(Boolean);
        const numCount = vals.filter(v => !isNaN(parseFloat(v)) && isFinite(+v)).length;
        return vals.length > 0 && numCount / vals.length > 0.6;
      });
      const sampleRow = Object.entries(records[0]).slice(0, 5).map(([k, v]) => `${k}: ${v}`).join(', ');
      const schemaDesc = `${records.length} rows, columns: ${fields.join(', ')}. Numeric: ${numericFields.join(', ')}. Sample row: ${sampleRow}`;
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0.3,
        messages: [{
          role: 'user',
          content: `Describe this CSV dataset in exactly 2 sentences. Be specific about what it contains. Schema: ${schemaDesc}\n\nReturn only the 2 sentences, no preamble.`,
        }],
      });
      return NextResponse.json({ summary: response.choices[0].message.content?.trim() ?? '' });
    }

    // PDF
    const embedding = await createQueryEmbedding('overview summary introduction what is this about');
    const chunks = await searchSimilarChunks(embedding, fileId, 0.0, 4);
    const sample = chunks.map(c => c.content).join('\n').slice(0, 2000);
    if (!sample) return NextResponse.json({ summary: '' });
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.3,
      messages: [{
        role: 'user',
        content: `Describe this document in exactly 2 sentences based on this excerpt. Be specific.\n\n${sample}\n\nReturn only the 2 sentences, no preamble.`,
      }],
    });
    return NextResponse.json({ summary: response.choices[0].message.content?.trim() ?? '' });
  } catch {
    return NextResponse.json({ summary: '' });
  }
}
