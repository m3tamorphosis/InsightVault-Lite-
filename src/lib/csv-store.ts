import { supabaseAdmin } from './supabase';

const BATCH_SIZE = 500;

/**
 * Inserts CSV rows as JSONB into the csv_rows table in batches.
 */
export async function storeCsvRows(
  fileId: string,
  rows: Record<string, unknown>[]
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE).map((data, j) => ({
      file_id: fileId,
      row_index: i + j,
      data,
    }));

    const { error } = await supabaseAdmin.from('csv_rows').insert(batch);
    if (error) throw new Error(`Failed to store CSV rows: ${error.message}`);
  }
}

/**
 * Fetches all rows for a CSV file, normalising keys to lowercase strings.
 */
export async function getCsvRows(fileId: string): Promise<Record<string, string>[]> {
  const { data, error } = await supabaseAdmin
    .from('csv_rows')
    .select('data')
    .eq('file_id', fileId)
    .order('row_index', { ascending: true });

  if (error) throw new Error(`Failed to fetch CSV rows: ${error.message}`);

  return (data as { data: Record<string, unknown> }[]).map(({ data: row }) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k.toLowerCase()] = v == null ? '' : String(v);
    }
    return out;
  });
}

/**
 * Returns the file type ('csv' | 'pdf') from the files table.
 */
export async function getFileType(fileId: string): Promise<'csv' | 'pdf'> {
  const { data, error } = await supabaseAdmin
    .from('files')
    .select('type')
    .eq('id', fileId)
    .single();

  if (error || !data) return 'csv'; // safe default
  return (data as { type: string }).type as 'csv' | 'pdf';
}
