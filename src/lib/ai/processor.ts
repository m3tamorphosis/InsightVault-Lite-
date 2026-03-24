import type { ChartData, ProcessedContext, QueryClassification, RetrievalResult } from './types';

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}...`;
}

function buildPdfContext(retrieval: RetrievalResult): ProcessedContext {
  const uniqueDocs = retrieval.documents.filter((doc, index, all) => {
    return all.findIndex(other => other.content === doc.content) === index;
  });

  const contextText = uniqueDocs
    .map((doc, index) => {
      const pageLabel = doc.pageNumber ? `page ${doc.pageNumber}` : 'unknown page';
      const categoryLabel = doc.category ? `category=${doc.category}` : 'category=uncategorized';
      return [
        `Excerpt ${index + 1} (${pageLabel}, source=${doc.source}, ${categoryLabel}, score=${doc.score.toFixed(3)}):`,
        truncate(doc.content.trim(), 1600),
      ].join('\n');
    })
    .join('\n\n---\n\n');

  return {
    contextText,
    warnings: retrieval.warnings,
    sources: uniqueDocs.map(doc => {
      const page = doc.pageNumber ? ` [p. ${doc.pageNumber}]` : '';
      return `${truncate(doc.content, 180)}${page}`;
    }),
  };
}

function formatLabel(row: Record<string, string>, preferredKeys: string[]): string {
  for (const key of preferredKeys) {
    const value = row[key];
    if (value && value.trim()) return value.trim();
  }
  return 'Record';
}

function toNumericValue(value: string | undefined): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[$,?\s]/g, '');
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeComparable(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_-]/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findHeader(headers: string[], candidates: string[]): string | null {
  for (const candidate of candidates) {
    const exact = headers.find(header => header.toLowerCase() === candidate);
    if (exact) return exact;
  }

  for (const candidate of candidates) {
    const partial = headers.find(header => header.toLowerCase().includes(candidate));
    if (partial) return partial;
  }

  return null;
}

function inferGroupField(headers: string[], query: string): string | null {
  const lower = query.toLowerCase();

  if (/\b(date|time|timeline|over time|by date|per date|trend over time|sales trend over time)\b/.test(lower)) {
    return findHeader(headers, ['order_date', 'date', 'created_at']);
  }
  if (/\bregion|regions|by region|per region\b/.test(lower)) {
    return findHeader(headers, ['region', 'city', 'location']);
  }
  if (/\bcategory|categories|by category|per category\b/.test(lower)) {
    return findHeader(headers, ['category']);
  }
  if (/\bproduct|products|by product|per product|each product\b/.test(lower)) {
    return findHeader(headers, ['product', 'name', 'item', 'title']);
  }
  if (/\bcustomer|customers|by customer|per customer\b/.test(lower)) {
    return findHeader(headers, ['customer_name', 'customer', 'name']);
  }

  return null;
}

function extractTopLimit(query: string): number | null {
  const match = query.match(/\b(top|bottom)\s+(\d+)\b/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[2], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function inferMetricField(headers: string[], query: string): string | null {
  const lower = query.toLowerCase();

  if (/\bquantity|qty\b/.test(lower)) {
    return findHeader(headers, ['quantity', 'qty']);
  }
  if (/\baverage price|avg price|mean price|price\b/.test(lower)) {
    return findHeader(headers, ['price', 'unit_price']);
  }
  if (/\border_id|order id\b/.test(lower)) {
    return findHeader(headers, ['order_id']);
  }
  if (/\btotal|sales|revenue|amount|value\b/.test(lower)) {
    return findHeader(headers, ['total', 'sales', 'amount', 'revenue', 'value']);
  }

  return null;
}

function inferRowFilters(
  rows: Record<string, string>[],
  headers: string[],
  query: string,
  excludedFields: string[]
): Array<{ field: string; value: string }> {
  const normalizedQuery = ` ${normalizeComparable(query)} `;
  const excluded = new Set(excludedFields.map(field => field.toLowerCase()));
  const filters: Array<{ field: string; value: string }> = [];

  for (const header of headers) {
    if (excluded.has(header.toLowerCase())) continue;
    if (/date|time|id|price|total|amount|sales|revenue|value|quantity/i.test(header)) continue;

    const uniqueValues = Array.from(
      new Set(
        rows
          .map(row => String(row[header] ?? '').trim())
          .filter(value => value.length >= 3)
      )
    );

    const matchedValues = uniqueValues.filter(value => {
      const normalizedValue = normalizeComparable(value);
      return normalizedValue.length >= 3 && normalizedQuery.includes(` ${normalizedValue} `);
    });

    if (matchedValues.length === 1) {
      filters.push({ field: header, value: matchedValues[0] });
    }
  }

  return filters;
}

function detectAggregateChartPlan(query: string, headers: string[]): {
  groupField: string;
  metricField: string;
  type: ChartData['type'];
  useAverage: boolean;
  topLimit: number | null;
  wantsBottom: boolean;
} | null {
  const lower = query.toLowerCase();
  const explicitChart = /\b(chart|graph|plot|visuali[sz]e|visualization)\b/.test(lower);
  const trendIntent = /\b(date|time|timeline|over time|by date|per date|trend|sales trend)\b/.test(lower);
  const rankingIntent = /\b(rank|ranking|top\s+\d+|bottom\s+\d+|top|bottom)\b/.test(lower);
  const distributionIntent = /\b(breakdown|share|distribution|composition)\b/.test(lower);
  const groupedIntent = /\b(by region|per region|by category|per category|by product|per product|by customer|per customer|for each|each product|each category|each region|each customer)\b/.test(lower);
  const directLookup = /\b(which|what is|who is|when is|is there|does|do)\b/.test(lower) && !trendIntent && !rankingIntent && !distributionIntent && !groupedIntent;

  if (directLookup && !explicitChart) return null;
  if (!trendIntent && !rankingIntent && !distributionIntent && !groupedIntent && !explicitChart) return null;

  const groupField = inferGroupField(headers, query);
  const metricField = inferMetricField(headers, query);
  if (!groupField || !metricField) return null;

  const topLimit = extractTopLimit(query);
  const wantsBottom = /\bbottom(?:\s+\d+)?\b/.test(lower);
  const useAverage = /\baverage|avg|mean\b/.test(lower);

  if (trendIntent) {
    return { groupField, metricField, type: 'line', useAverage, topLimit, wantsBottom };
  }

  if (distributionIntent) {
    return { groupField, metricField, type: 'pie', useAverage, topLimit, wantsBottom };
  }

  if (rankingIntent || groupedIntent || explicitChart) {
    return { groupField, metricField, type: 'bar', useAverage, topLimit, wantsBottom };
  }

  return null;
}

function buildAggregateChartTitle(params: {
  metricField: string;
  groupField: string;
  useAverage: boolean;
  topLimit: number | null;
  wantsBottom: boolean;
  filters: Array<{ field: string; value: string }>;
}): string {
  const { metricField, groupField, useAverage, topLimit, wantsBottom, filters } = params;
  const metricLabel = metricField.replace(/_/g, ' ');
  const groupLabel = groupField.replace(/_/g, ' ');
  const filterLabel = filters.map(filter => filter.value).join(' and ');

  if (topLimit) {
    return `${wantsBottom ? 'Bottom' : 'Top'} ${topLimit} ${groupLabel} by ${metricLabel}`;
  }

  if (filterLabel) {
    return `${useAverage ? 'Average' : 'Total'} ${metricLabel} for ${filterLabel} by ${groupLabel}`;
  }

  return `${useAverage ? 'Average' : 'Total'} ${metricLabel} by ${groupLabel}`;
}

function buildAggregateChart(retrieval: RetrievalResult, query: string): ChartData | undefined {
  const docs = retrieval.documents.filter(doc => doc.metadata?.aggregateScope === 'full_dataset' && doc.metadata?.row);
  if (docs.length < 2) return undefined;

  const headers = Array.isArray(docs[0].metadata?.headers)
    ? (docs[0].metadata?.headers as string[])
    : Object.keys((docs[0].metadata?.row ?? {}) as Record<string, string>);
  const rows = docs.map(doc => (doc.metadata?.row ?? {}) as Record<string, string>);
  const chartPlan = detectAggregateChartPlan(query, headers);
  if (!chartPlan) return undefined;

  const { groupField, metricField, type, useAverage, topLimit, wantsBottom } = chartPlan;
  const inferredFilters = inferRowFilters(rows, headers, query, [groupField, metricField]);
  const filteredRows = inferredFilters.length > 0
    ? rows.filter(row => inferredFilters.every(filter => String(row[filter.field] ?? '').trim().toLowerCase() === filter.value.trim().toLowerCase()))
    : rows;

  if (filteredRows.length === 0) return undefined;

  const grouped = new Map<string, { total: number; count: number }>();

  for (const row of filteredRows) {
    const groupValue = String(row[groupField] ?? '').trim();
    const metricValue = toNumericValue(row[metricField]);
    if (!groupValue || metricValue === null) continue;
    const current = grouped.get(groupValue) ?? { total: 0, count: 0 };
    current.total += metricValue;
    current.count += 1;
    grouped.set(groupValue, current);
  }

  let data = Array.from(grouped.entries()).map(([label, stats]) => ({
    label,
    [metricField]: useAverage ? Number((stats.total / Math.max(stats.count, 1)).toFixed(2)) : Number(stats.total.toFixed(2)),
  }));

  if (data.length < 2) return undefined;

  data.sort((a, b) => {
    const left = Number(a[metricField]);
    const right = Number(b[metricField]);
    return wantsBottom ? left - right : right - left;
  });

  if (topLimit) {
    data = data.slice(0, topLimit);
  }

  if (data.length < 2) return undefined;

  const resolvedType = type === 'pie' && data.length > 6 ? 'bar' : type;
  const title = buildAggregateChartTitle({
    metricField,
    groupField,
    useAverage,
    topLimit,
    wantsBottom,
    filters: inferredFilters,
  });

  return {
    type: resolvedType,
    title,
    xKey: 'label',
    yKey: metricField,
    data,
  };
}

function buildComparisonChart(retrieval: RetrievalResult): ChartData | undefined {
  const comparisonDocs = retrieval.documents.filter(doc => doc.metadata?.comparisonRole && doc.metadata?.metricField);
  if (comparisonDocs.length < 2) return undefined;

  const metricField = String(comparisonDocs[0].metadata?.metricField ?? 'value');
  const data = comparisonDocs.map(doc => {
    const row = (doc.metadata?.row ?? {}) as Record<string, string>;
    const labelBase = formatLabel(row, ['product', 'name', 'item', 'title', 'customer', 'region']);
    const role = String(doc.metadata?.comparisonRole ?? 'record');
    const metricValue = Number(doc.metadata?.metricValue ?? 0);
    return {
      label: `${labelBase} (${role})`,
      [metricField]: metricValue,
    };
  });

  const metricLabel = metricField.replace(/_/g, ' ');

  return {
    type: 'bar',
    title: `Highest vs Lowest Sales Record (${metricLabel})`,
    xKey: 'label',
    yKey: metricField,
    data,
  };
}

function buildCsvContext(retrieval: RetrievalResult, classification: QueryClassification, query: string): ProcessedContext {
  const headers = Array.isArray(retrieval.documents[0]?.metadata?.headers)
    ? (retrieval.documents[0]?.metadata?.headers as string[])
    : [];

  const comparisonChart = classification.intent === 'comparison' ? buildComparisonChart(retrieval) : undefined;
  const aggregateChart = classification.intent !== 'comparison' ? buildAggregateChart(retrieval, query) : undefined;

  const contextRows = retrieval.documents
    .map((doc, index) => {
      const role = typeof doc.metadata?.comparisonRole === 'string' ? `, role=${doc.metadata.comparisonRole}` : '';
      return `Row ${index + 1} (score=${doc.score.toFixed(3)}${role}): ${doc.content}`;
    })
    .join('\n');

  const intentNote =
    classification.intent === 'comparison'
      ? 'Focus on differences, similarities, ranking signals, and the practical business implications of the highest and lowest records.'
      : classification.intent === 'summary'
        ? 'Focus on a concise overview of the dataset slice represented below.'
        : 'Focus on patterns, anomalies, and directly supported insights from the rows below.';

  return {
    contextText: [
      headers.length ? `Columns: ${headers.join(', ')}` : null,
      intentNote,
      contextRows || 'No matching rows were retrieved.',
    ]
      .filter(Boolean)
      .join('\n\n'),
    warnings: retrieval.warnings,
    sources: retrieval.documents.map(doc => truncate(doc.content, 180)),
    chartData: comparisonChart ?? aggregateChart,
  };
}

export function processContext(params: {
  classification: QueryClassification;
  retrieval: RetrievalResult;
  query: string;
}): ProcessedContext {
  const { classification, retrieval, query } = params;

  if (retrieval.documents.length === 0) {
    return {
      contextText: '',
      warnings: [
        ...retrieval.warnings,
        'The generation step must acknowledge that no grounded evidence was retrieved.',
      ],
      sources: [],
    };
  }

  return retrieval.fileType === 'pdf'
    ? buildPdfContext(retrieval)
    : buildCsvContext(retrieval, classification, query);
}
