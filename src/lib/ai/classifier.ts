import { getOpenAI } from '@/lib/openai';
import type { ExternalAction, QueryClassification, QueryIntent, RetrievalMode } from './types';

const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const STRONG_COMPARISON_REGEX = /\b(compare|comparison|difference|versus|vs\.?|against|highest and lowest|top and bottom|strongest and weakest)\b/i;
const STRONG_ACTION_REGEX = /\b(send|share|email|mail|slack|post|notify|deliver)\b/i;
const STRONG_SUMMARY_REGEX = /\b(summary|summarize|summarise|overview|tl;dr|brief)\b/i;
const CHART_REQUEST_REGEX = /\b(chart|bar chart|line chart|pie chart|scatter|graph|plot|visuali[sz]e|visualization)\b/i;

function detectIntentFromRules(query: string): QueryIntent {
  const normalized = query.toLowerCase();

  if (STRONG_ACTION_REGEX.test(normalized)) {
    return 'action';
  }
  if (STRONG_COMPARISON_REGEX.test(normalized)) {
    return 'comparison';
  }
  if (STRONG_SUMMARY_REGEX.test(normalized)) {
    return 'summary';
  }
  return 'analysis';
}

function detectRetrievalMode(intent: QueryIntent): RetrievalMode {
  if (intent === 'summary') return 'broad';
  if (intent === 'comparison') return 'comparative';
  return 'focused';
}

function hasComparisonSignals(query: string): boolean {
  return STRONG_COMPARISON_REGEX.test(query);
}
function hasChartSignals(query: string): boolean {
  return CHART_REQUEST_REGEX.test(query);
}


function detectExternalAction(query: string): ExternalAction {
  const normalized = query.toLowerCase();
  if (/\bslack\b/.test(normalized)) return 'slack';
  if (/\bemail|mail\b/.test(normalized) || EMAIL_REGEX.test(query)) return 'email';
  return null;
}

function ruleBasedClassification(query: string): QueryClassification {
  const intent = detectIntentFromRules(query);
  const requestedAction = detectExternalAction(query);

  return {
    intent,
    confidence: requestedAction || intent !== 'analysis' ? 0.82 : 0.68,
    rationale: 'Rule-based classification fallback derived from query language.',
    retrievalMode: detectRetrievalMode(intent),
    requestedAction,
  };
}

function parseClassifierResponse(raw: string | null | undefined): QueryClassification | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as {
      intent?: QueryIntent;
      confidence?: number;
      rationale?: string;
      retrievalMode?: RetrievalMode;
      requestedAction?: ExternalAction;
    };

    if (!parsed.intent || !parsed.retrievalMode) return null;

    return {
      intent: parsed.intent,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.7))),
      rationale: parsed.rationale?.trim() || 'LLM classification response.',
      retrievalMode: parsed.retrievalMode,
      requestedAction: parsed.requestedAction ?? null,
    };
  } catch {
    return null;
  }
}

export async function classifyQuery(
  query: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }> = []
): Promise<QueryClassification> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error('Empty queries are not allowed.');
  }

  if (hasChartSignals(trimmed) && !detectExternalAction(trimmed)) {
    const chartIntent: QueryIntent = hasComparisonSignals(trimmed) ? 'comparison' : 'analysis';
    return {
      intent: chartIntent,
      confidence: 0.9,
      rationale: 'Rule-based override kept this as a chart request without an external delivery action.',
      retrievalMode: chartIntent === 'comparison' ? 'comparative' : 'focused',
      requestedAction: null,
    };
  }
  const fallback = ruleBasedClassification(trimmed);

  try {
    const openai = getOpenAI();
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `Classify the user's intent for a document intelligence workflow.

Return JSON only with:
- intent: "summary" | "analysis" | "comparison" | "action"
- confidence: number from 0 to 1
- rationale: short string
- retrievalMode: "broad" | "focused" | "comparative"
- requestedAction: "slack" | "email" | null

Use "action" only when the user explicitly wants a result sent or triggered externally.`,
        },
        ...history.slice(-4),
        { role: 'user', content: trimmed },
      ],
    });

    const llmResult = parseClassifierResponse(response.choices[0]?.message?.content);
    if (!llmResult) {
      console.warn('[classifier] Falling back to rules after unparsable LLM output.');
      return fallback;
    }

    if (llmResult.intent === 'action' && !llmResult.requestedAction) {
      llmResult.requestedAction = detectExternalAction(trimmed);
    }

    if (STRONG_ACTION_REGEX.test(trimmed)) {
      return {
        ...llmResult,
        intent: 'action',
        retrievalMode: hasComparisonSignals(trimmed) ? 'comparative' : detectRetrievalMode('action'),
        requestedAction: llmResult.requestedAction ?? detectExternalAction(trimmed),
        rationale: `${llmResult.rationale} Rule override kept this as an explicit action request.${hasComparisonSignals(trimmed) ? ' Comparison-aware retrieval was preserved.' : ''}`,
      };
    }

    if (hasChartSignals(trimmed) && !detectExternalAction(trimmed) && llmResult.intent === 'action') {
      return {
        ...llmResult,
        intent: hasComparisonSignals(trimmed) ? 'comparison' : 'analysis',
        retrievalMode: hasComparisonSignals(trimmed) ? 'comparative' : 'focused',
        requestedAction: null,
        rationale: `${llmResult.rationale} Rule override kept this as a chart-generation request rather than an external action.`,
      };
    }

    if (STRONG_COMPARISON_REGEX.test(trimmed)) {
      return {
        ...llmResult,
        intent: 'comparison',
        retrievalMode: detectRetrievalMode('comparison'),
        rationale: `${llmResult.rationale} Rule override kept this as an explicit comparison request.`,
      };
    }

    if (STRONG_SUMMARY_REGEX.test(trimmed) && llmResult.intent === 'analysis') {
      return {
        ...llmResult,
        intent: 'summary',
        retrievalMode: detectRetrievalMode('summary'),
        rationale: `${llmResult.rationale} Rule override kept this as an explicit summary request.`,
      };
    }

    return llmResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown classifier error';
    console.warn('[classifier] Using rule fallback:', message);
    return fallback;
  }
}

export function extractEmailTarget(query: string): string | null {
  return query.match(EMAIL_REGEX)?.[0] ?? null;
}

