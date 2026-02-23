/**
 * Converts a CSV row object into a readable sentence for embedding.
 * Handles missing values by filtering out empty or null fields.
 */
export function rowToText(row: Record<string, unknown>): string {
    return Object.entries(row)
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ');
}
