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

function buildCsvContext(retrieval: RetrievalResult, classification: QueryClassification): ProcessedContext {
  const headers = Array.isArray(retrieval.documents[0]?.metadata?.headers)
    ? (retrieval.documents[0]?.metadata?.headers as string[])
    : [];

  const comparisonChart = classification.intent === 'comparison' ? buildComparisonChart(retrieval) : undefined;

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
    chartData: comparisonChart,
  };
}

export function processContext(params: {
  classification: QueryClassification;
  retrieval: RetrievalResult;
}): ProcessedContext {
  const { classification, retrieval } = params;

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
    : buildCsvContext(retrieval, classification);
}
