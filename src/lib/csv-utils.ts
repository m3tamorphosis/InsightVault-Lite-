/**
 * Converts a CSV row object into a readable sentence for embedding.
 * Handles missing values by filtering out empty or null fields.
 */
export function rowToText(row: Record<string, any>): string {
    return Object.entries(row)
        .filter(([_, value]) => value !== null && value !== undefined && value !== '')
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ');
}
