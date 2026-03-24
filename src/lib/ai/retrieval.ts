import { createQueryEmbedding } from '@/lib/openai';
import { getCsvRows, getFileType } from '@/lib/csv-store';
import { searchSimilarChunks } from '@/lib/vector-store';
import type { QueryClassification, RetrievedDocument, RetrievalFilters, RetrievalResult } from './types';

const METRIC_FIELD_PRIORITY = ['total', 'amount', 'sales', 'revenue', 'value', 'price', 'unit_price'];
const AGGREGATION_QUERY_REGEX = /\b(rank|ranking|top\s+\d+|bottom\s+\d+|top|bottom|sum|total sales|total by|breakdown|average|avg|mean|per\s+region|by\s+region|per\s+category|by\s+category|by\s+product|per\s+product|group\s+by|across\s+different|for each|each product|order dates?|date comparison|dates?\b|highest total sales|lowest total sales|highest|lowest|outlier|trend)\b/i;
const CHART_REQUEST_REGEX = /\b(chart|bar chart|line chart|pie chart|scatter|graph|plot|visuali[sz]e|visualization)\b/i;

function filterSummary(filters?: RetrievalFilters): string {
  if (!filters) return 'none';
  return [
    filters.fileType ? `fileType=${filters.fileType}` : null,
    filters.category ? `category=${filters.category}` : null,
    filters.source ? `source=${filters.source}` : null,
  ]
    .filter(Boolean)
    .join(', ') || 'none';
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(token => token.trim())
    .filter(token => token.length >= 3);
}

function toNumericValue(value: string | undefined): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[$,?\s]/g, '');
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function scoreCsvRow(query: string, row: Record<string, string>): number {
  const haystack = Object.values(row).join(' ').toLowerCase();
  const tokens = tokenize(query);
  if (tokens.length === 0) return 0;

  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += 1;
  }
  return score / tokens.length;
}

function findMetricField(headers: string[]): string | null {
  const normalized = headers.map(header => header.toLowerCase());
  for (const preferred of METRIC_FIELD_PRIORITY) {
    const index = normalized.findIndex(header => header === preferred || header.includes(preferred));
    if (index >= 0) return headers[index];
  }

  for (const header of headers) {
    if (/total|amount|sales|revenue|value|price/i.test(header)) {
      return header;
    }
  }

  return null;
}

function buildRowContent(headers: string[], row: Record<string, string>): string {
  return headers.map(header => `${header}: ${row[header] ?? ''}`).join(', ');
}

function isAggregationCsvQuery(query: string): boolean {
  return AGGREGATION_QUERY_REGEX.test(query);
}

function isChartRequest(query: string): boolean {
  return CHART_REQUEST_REGEX.test(query);
}

function buildAggregateDocuments(rows: Record<string, string>[]): RetrievedDocument[] {
  if (rows.length === 0) return [];

  const headers = Object.keys(rows[0]);
  return rows.slice(0, 50).map((row, index) => ({
    id: `csv-aggregate-${index}`,
    content: buildRowContent(headers, row),
    score: 1,
    source: 'csv_rows',
    category: 'tabular',
    fileType: 'csv',
    metadata: {
      rowIndex: index,
      headers,
      row,
      aggregateScope: 'full_dataset',
      totalRowsInDataset: rows.length,
    },
  }));
}

function buildComparisonDocuments(rows: Record<string, string>[]): RetrievedDocument[] {
  if (rows.length === 0) return [];

  const headers = Object.keys(rows[0]);
  const metricField = findMetricField(headers);
  if (!metricField) return [];

  const ranked = rows
    .map((row, index) => ({
      row,
      index,
      metricValue: toNumericValue(row[metricField]),
    }))
    .filter((item): item is { row: Record<string, string>; index: number; metricValue: number } => item.metricValue !== null)
    .sort((a, b) => b.metricValue - a.metricValue);

  if (ranked.length === 0) return [];

  const highest = ranked[0];
  const lowest = ranked[ranked.length - 1];
  const selected = highest.index === lowest.index ? [highest] : [highest, lowest];

  return selected.map((item, orderIndex) => ({
    id: `csv-compare-${item.index}`,
    content: buildRowContent(headers, item.row),
    score: orderIndex === 0 ? 1 : 0.98,
    source: 'csv_rows',
    category: 'tabular',
    fileType: 'csv',
    metadata: {
      rowIndex: item.index,
      headers,
      comparisonRole: orderIndex === 0 ? 'highest' : 'lowest',
      metricField,
      metricValue: item.metricValue,
      row: item.row,
    },
  }));
}

function buildCsvDocuments(query: string, rows: Record<string, string>[], classification: QueryClassification): RetrievedDocument[] {
  if (classification.intent === 'comparison' || classification.retrievalMode === 'comparative') {
    const comparisonDocs = buildComparisonDocuments(rows);
    if (comparisonDocs.length > 0) return comparisonDocs;
  }

  if ((classification.intent === 'analysis' || classification.intent === 'summary') && (isAggregationCsvQuery(query) || isChartRequest(query))) {
    return buildAggregateDocuments(rows);
  }

  const scored = rows
    .map((row, index) => ({ row, index, score: scoreCsvRow(query, row) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  const headers = rows[0] ? Object.keys(rows[0]) : [];

  if (scored.length === 0) {
    return rows.slice(0, 5).map((row, index) => ({
      id: `csv-fallback-${index}`,
      content: buildRowContent(headers, row),
      score: 0,
      source: 'csv_rows',
      category: 'tabular',
      fileType: 'csv',
      metadata: { rowIndex: index, fallback: true, headers, row },
    }));
  }

  return scored.map(item => ({
    id: `csv-${item.index}`,
    content: buildRowContent(headers, item.row),
    score: Number(item.score.toFixed(3)),
    source: 'csv_rows',
    category: 'tabular',
    fileType: 'csv',
    metadata: { rowIndex: item.index, headers, row: item.row },
  }));
}

export async function retrieveDocuments(params: {
  fileId: string;
  query: string;
  classification: QueryClassification;
  filters?: RetrievalFilters;
}): Promise<RetrievalResult> {
  const { fileId, query, classification, filters } = params;
  const fileType = filters?.fileType ?? await getFileType(fileId);

  if (fileType === 'csv') {
    const rows = await getCsvRows(fileId);
    const documents = buildCsvDocuments(query, rows, classification);
    const warnings: string[] = [];

    if (rows.length === 0) {
      warnings.push('The CSV file has no stored rows.');
    } else if (documents.some(doc => doc.metadata?.aggregateScope === 'full_dataset')) {
      warnings.push('The system provided a broad dataset slice for direct aggregation and ranking over the CSV rows.');
    } else if (documents.length > 0 && documents.every(doc => doc.score === 0)) {
      warnings.push('No strong row-level matches were found, so the system used representative rows instead.');
    }

    return {
      fileType,
      documents,
      warnings,
      retrievalMeta: {
        thresholdUsed: 0,
        documentsConsidered: rows.length,
        filterSummary: filterSummary(filters),
      },
    };
  }

  const baseThreshold = classification.retrievalMode === 'broad' ? 0.12 : 0.2;
  const fallbackThreshold = classification.retrievalMode === 'broad' ? 0.05 : 0.1;
  const queryEmbedding = await createQueryEmbedding(query);

  let matches = await searchSimilarChunks(queryEmbedding, fileId, baseThreshold, 10, {
    fileType,
    category: filters?.category,
    source: filters?.source,
  });

  const warnings: string[] = [];
  let thresholdUsed = baseThreshold;

  if (matches.length === 0) {
    warnings.push('No chunks cleared the primary similarity threshold. A fallback retrieval pass was attempted.');
    matches = await searchSimilarChunks(queryEmbedding, fileId, fallbackThreshold, 6, {
      fileType,
      category: filters?.category,
      source: filters?.source,
    });
    thresholdUsed = fallbackThreshold;
  }

  const documents: RetrievedDocument[] = matches.map(match => ({
    id: match.id,
    content: match.content,
    score: match.similarity,
    pageNumber: match.page_number,
    source: match.source ?? 'document',
    category: match.category ?? null,
    fileType: 'pdf',
    metadata: match.metadata ?? {},
  }));

  if (documents.length === 0) {
    warnings.push('No relevant context was found for this query.');
  } else if (documents[0].score < 0.2) {
    warnings.push('The retrieved evidence is weakly related to the query, so the answer may be partial.');
  }

  return {
    fileType: 'pdf',
    documents,
    warnings,
    retrievalMeta: {
      thresholdUsed,
      documentsConsidered: documents.length,
      filterSummary: filterSummary(filters),
    },
  };
}
