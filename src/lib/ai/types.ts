export type QueryIntent = 'summary' | 'analysis' | 'comparison' | 'action';

export type RetrievalMode = 'broad' | 'focused' | 'comparative';

export type ExternalAction = 'slack' | 'email' | null;

export interface ChartData {
  type: 'bar' | 'line' | 'pie' | 'scatter';
  title: string;
  xKey: string;
  yKey: string;
  data: Array<Record<string, string | number>>;
}

export interface QueryClassification {
  intent: QueryIntent;
  confidence: number;
  rationale: string;
  retrievalMode: RetrievalMode;
  requestedAction: ExternalAction;
}

export interface RetrievalFilters {
  fileType?: 'csv' | 'pdf';
  category?: string;
  source?: string;
}

export interface RetrievedDocument {
  id: string;
  content: string;
  score: number;
  pageNumber?: number | null;
  source: string;
  category?: string | null;
  fileType: 'csv' | 'pdf';
  metadata?: Record<string, unknown>;
}

export interface RetrievalResult {
  fileType: 'csv' | 'pdf';
  documents: RetrievedDocument[];
  warnings: string[];
  retrievalMeta: {
    thresholdUsed: number;
    documentsConsidered: number;
    filterSummary: string;
  };
}

export interface ProcessedContext {
  contextText: string;
  warnings: string[];
  sources: string[];
  chartData?: ChartData;
}

export interface DeliveryOptions {
  email?: string;
  slackWebhookUrl?: string;
}

export interface QueryRequest {
  message: string;
  fileId: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  filters?: RetrievalFilters;
  delivery?: DeliveryOptions;
}

