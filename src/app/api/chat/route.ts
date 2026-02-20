import { NextResponse } from 'next/server';
import { openai, createQueryEmbedding } from '@/lib/openai';
import { searchSimilarChunks, getAllChunks } from '@/lib/vector-store';

// ── Shared types ───────────────────────────────────────────────────────────

export interface ChartData {
  type: 'bar' | 'line';
  title: string;
  xKey: string;
  yKey: string;
  data: Array<Record<string, string | number>>;
}

// ── Dataset schema ─────────────────────────────────────────────────────────

interface DatasetSchema {
  allFields: string[];
  numericFields: string[];
  categoricalFields: string[];
  titleField: string | null;
  aliases: Record<string, string>;   // normalized word → actual field name (lowercase)
  ranges: Record<string, { min: number; max: number }>;
  topValues: Record<string, string[]>; // field → top values by frequency
}

// Known synonyms for common numeric fields — mapped to actual dataset columns
const FIELD_SYNONYMS: Record<string, string[]> = {
  rating:     ['rate', 'score', 'imdb', 'stars', 'rated'],
  boxoffice:  ['boxoffice', 'box_office', 'revenue', 'gross', 'earning', 'earnings'],
  units_sold: ['sold', 'qty', 'quantity', 'units', 'items_sold', 'count_sold', 'sales', 'sales_volume', 'volume', 'amount_sold'],
  duration:   ['runtime', 'length', 'minutes', 'mins', 'long', 'time'],
  year:       ['release', 'released', 'yr', 'decade'],
  age:        ['old', 'years_old'],
  fare:       ['ticket', 'price', 'cost', 'fee', 'paid', 'unit_price', 'rate', 'charge'],
  votes:      ['vote', 'reviews', 'review'],
  profit:     ['margin', 'net', 'gain', 'earnings', 'income'],
};

const TITLE_CANDIDATES = new Set(['title', 'name', 'movie', 'film', 'song', 'book', 'product', 'item', 'show']);

/**
 * Scans all records to infer field types, ranges, and top values.
 * Returns a schema object used by all detection functions.
 */
function buildSchema(records: Record<string, string>[]): DatasetSchema {
  if (records.length === 0) {
    return { allFields: [], numericFields: [], categoricalFields: [], titleField: null, aliases: {}, ranges: {}, topValues: {} };
  }

  // Collect all unique field names (already lowercase from parseChunk)
  const fieldSet = new Set<string>();
  for (const rec of records) {
    for (const k of Object.keys(rec)) fieldSet.add(k);
  }
  const allFields = Array.from(fieldSet);

  const numericFields: string[] = [];
  const categoricalFields: string[] = [];
  const ranges: Record<string, { min: number; max: number }> = {};
  const topValues: Record<string, string[]> = {};

  for (const field of allFields) {
    const vals = records.flatMap(r => r[field]?.trim() ? [r[field].trim()] : []);
    if (!vals.length) continue;

    const numCount = vals.filter(v => !isNaN(parseFloat(v)) && isFinite(+v)).length;
    if (numCount / vals.length > 0.6) {
      numericFields.push(field);
      const nums = vals.map(Number).filter(n => !isNaN(n) && isFinite(n));
      if (nums.length > 0) ranges[field] = { min: Math.min(...nums), max: Math.max(...nums) };
    } else {
      const unique = new Set(vals.map(v => v.toLowerCase()));
      // Categorical: low cardinality or low uniqueness ratio
      if (unique.size <= 50 || unique.size / vals.length < 0.3) {
        categoricalFields.push(field);
        const freq: Record<string, number> = {};
        for (const v of vals) freq[v] = (freq[v] ?? 0) + 1;
        topValues[field] = Object.entries(freq)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([v]) => v);
      }
    }
  }

  const titleField = allFields.find(f => TITLE_CANDIDATES.has(f)) ?? null;

  // Build alias map: user-typed word → actual field name
  const aliases: Record<string, string> = {};
  const addAlias = (a: string, t: string) => {
    const key = a.toLowerCase().trim();
    if (key) aliases[key] = t;
  };

  for (const f of allFields) {
    addAlias(f, f);
    addAlias(f.replace(/[_\s]+/g, ''), f);   // boxoffice → boxoffice
    addAlias(f.replace(/[_\s]+/g, ' '), f);  // box_office → box office
    if (f.endsWith('s')) addAlias(f.slice(0, -1), f); // genres → genre
  }

  // Map known synonym groups to actual dataset fields
  for (const [canonical, syns] of Object.entries(FIELD_SYNONYMS)) {
    const actual = allFields.find(f => f.includes(canonical))
      ?? allFields.find(f => syns.some(s => f.includes(s)));
    if (actual) {
      addAlias(canonical, actual);
      for (const s of syns) {
        addAlias(s, actual);
        addAlias(s.replace(/[\s_]+/g, ''), actual);
      }
    }
  }

  return { allFields, numericFields, categoricalFields, titleField, aliases, ranges, topValues };
}

/** Resolve a user word to an actual field name using schema aliases + fuzzy matching */
function resolveField(target: string, schema: DatasetSchema): string | null {
  const t = target.toLowerCase().trim();
  if (!t) return null;
  if (schema.aliases[t]) return schema.aliases[t];
  const tClean = t.replace(/[_\s]+/g, '');
  if (schema.aliases[tClean]) return schema.aliases[tClean];
  // Fuzzy substring match — require ≥4 chars to avoid common English words
  // like "in", "on", "at", "of" accidentally matching field names (e.g. "in" → "cabin")
  for (const f of schema.allFields) {
    if (t.length >= 4 && f.includes(t)) return f;
    if (f.length >= 4 && t.includes(f)) return f;
  }
  return null;
}

/** Pick the most relevant numeric field for ranking (rating > boxoffice > first numeric) */
function defaultRankField(schema: DatasetSchema): string {
  const preferred = ['rating', 'score', 'imdb', 'votes', 'boxoffice', 'revenue'];
  for (const pref of preferred) {
    const r = resolveField(pref, schema);
    if (r && schema.numericFields.includes(r)) return r;
  }
  return schema.numericFields[0] ?? 'rating';
}

// ── Query detection ────────────────────────────────────────────────────────

interface TopNResult {
  isTopN: boolean;
  n: number;
  field: string;
  order: 'asc' | 'desc';
  categoryFilter: { field: string; value: string } | null;
}

/**
 * Detects "top N / bottom N" ranking queries.
 * Also detects compound filters like "top 10 crime movies" → categoryFilter: {genre, Crime}.
 */
function detectTopN(msg: string, schema: DatasetSchema): TopNResult {
  const lower = msg.toLowerCase();
  const none: TopNResult = { isTopN: false, n: 0, field: '', order: 'desc', categoryFilter: null };

  let n = 0;
  let order: 'asc' | 'desc' = 'desc';

  const topMatch = lower.match(/\b(top|best|highest rated?|most)\b[^a-z0-9]*([0-9]+)/);
  if (topMatch) { n = Math.min(parseInt(topMatch[2]), 100); order = 'desc'; }

  const bottomMatch = lower.match(/\b(bottom|worst|lowest rated?|least)\b[^a-z0-9]*([0-9]+)/);
  if (!topMatch && bottomMatch) { n = Math.min(parseInt(bottomMatch[2]), 100); order = 'asc'; }

  if (n === 0) return none;

  // Detect sort field — explicit "by X" or first numeric word in query
  const byMatch = lower.match(/\bby\s+([a-z][a-z0-9\s_]*?)(?:\s|$)/);
  let field: string;
  if (byMatch) {
    field = resolveField(byMatch[1].trim(), schema) ?? defaultRankField(schema);
  } else {
    let found: string | null = null;
    for (const word of lower.split(/\W+/)) {
      const r = resolveField(word, schema);
      if (r && schema.numericFields.includes(r)) { found = r; break; }
    }
    field = found ?? defaultRankField(schema);
  }

  // Detect categorical value filter: "top 10 crime movies" → genre=Crime
  let categoryFilter: TopNResult['categoryFilter'] = null;
  outer: for (const catField of schema.categoricalFields) {
    for (const val of (schema.topValues[catField] ?? [])) {
      if (lower.includes(val.toLowerCase())) {
        categoryFilter = { field: catField, value: val };
        break outer;
      }
    }
  }

  return { isTopN: true, n, field, order, categoryFilter };
}

/**
 * Detects "best genre", "worst director", "most popular country".
 * Uses dynamic categorical fields from schema instead of a hardcoded list.
 */
function detectGroupRank(msg: string, schema: DatasetSchema): { isGroupRank: boolean; groupField: string; metric: string; order: 'asc' | 'desc' } {
  const lower = msg.toLowerCase();
  const rankField = defaultRankField(schema);
  const none = { isGroupRank: false, groupField: '', metric: '', order: 'desc' as const };

  const classify = (field: string) => {
    if (/\b(best|top|highest|greatest|highest.?rated?)\b/.test(lower))
      return { isGroupRank: true, groupField: field, metric: rankField, order: 'desc' as const };
    if (/\b(worst|lowest|weakest|lowest.?rated?)\b/.test(lower))
      return { isGroupRank: true, groupField: field, metric: rankField, order: 'asc' as const };
    if (/\b(most popular|most common|most frequent|popular)\b/.test(lower))
      return { isGroupRank: true, groupField: field, metric: 'count', order: 'desc' as const };
    return null;
  };

  // Direct field name match
  for (const f of schema.categoricalFields) {
    if (lower.includes(f)) { const r = classify(f); if (r) return r; }
  }

  // Alias match (e.g. "genre" → resolves to "Genre")
  for (const word of lower.split(/\W+/)) {
    const resolved = resolveField(word, schema);
    if (resolved && schema.categoricalFields.includes(resolved)) {
      const r = classify(resolved); if (r) return r;
    }
  }

  return none;
}

/**
 * Detects aggregation queries: count, countDistinct, avg, sum, min, max,
 * findRecordMin, findRecordMax. Uses schema to validate field names.
 */
function detectAggregation(msg: string, schema: DatasetSchema): { isAggregate: boolean; type: string; field: string } {
  const lower = msg.toLowerCase();
  const entityWords = new Set(['passenger', 'passengers', 'people', 'person', 'persons',
    'row', 'rows', 'record', 'records', 'entry', 'entries', 'item', 'items',
    'survivor', 'survivors', 'movie', 'movies', 'film', 'films']);

  // Filler words to skip when scanning for the meaningful field word
  const countFillers = new Set(['total', 'all', 'overall', 'are', 'were', 'is', 'the', 'of', 'a', 'an', 'been', 'have', 'has', 'much', 'many']);

  // Count rows / distinct / sum — "how many X", "total X", "count of X"
  if (/\b(how many|number of|total|count)\b/.test(lower)) {
    // Collect all words after the trigger keyword, skip fillers, take first meaningful word
    const triggerMatch = lower.match(/\b(how many|number of|total|count)\b(.*)/);
    let meaningful = '';
    if (triggerMatch) {
      for (const w of triggerMatch[2].split(/\W+/)) {
        if (!w || countFillers.has(w)) continue;
        meaningful = w;
        break;
      }
    }
    if (meaningful) {
      if (entityWords.has(meaningful)) return { isAggregate: true, type: 'count', field: 'rows' };
      const resolved = resolveField(meaningful, schema);
      if (resolved && schema.numericFields.includes(resolved)) {
        // "total sold", "how many units sold" → sum, not countDistinct
        return { isAggregate: true, type: 'sum', field: resolved };
      }
      if (resolved) return { isAggregate: true, type: 'countDistinct', field: resolved };
    }
    if (/\b(row|record|movie|film|passenger|item|entry|product|order)\b/.test(lower)) {
      return { isAggregate: true, type: 'count', field: 'rows' };
    }
  }

  // Average — skip entity words and ID-like fields
  const avgMatch = lower.match(/\b(average|mean|avg)\b[^a-z]*\b([a-z][a-z0-9_]*)\b/);
  if (avgMatch) {
    const word = avgMatch[2];
    if (!entityWords.has(word)) {
      const resolved = resolveField(word, schema);
      if (resolved && schema.numericFields.includes(resolved) && !resolved.endsWith('id') && resolved !== 'id')
        return { isAggregate: true, type: 'avg', field: resolved };
    }
  }

  // Sum
  const sumMatch = lower.match(/\b(sum|total)\b[^a-z]*(of\b[^a-z]*)?\b([a-z][a-z0-9_]*)\b/);
  if (sumMatch) {
    const word = sumMatch[3];
    if (!entityWords.has(word)) {
      const resolved = resolveField(word, schema);
      if (resolved && schema.numericFields.includes(resolved))
        return { isAggregate: true, type: 'sum', field: resolved };
    }
  }

  // Temporal: "earliest", "latest", "newest", "most recent"
  const temporalMinKw = lower.match(/\b(earliest|first to|when.*first|when.*open)\b/);
  const temporalMaxKw = lower.match(/\b(latest|newest|most recent|last to)\b/);
  if (temporalMinKw || temporalMaxKw) {
    const timeField = schema.numericFields.find(f => /\b(year|yr|open|founded|established|launched|start|date)\b/.test(f))
      ?? schema.numericFields.find(f => /year|date/.test(f));
    if (timeField) {
      return { isAggregate: true, type: temporalMinKw ? 'findRecordMin' : 'findRecordMax', field: timeField };
    }
  }

  // Keyword-based findRecordMin/Max (youngest, oldest, cheapest, etc.)
  const minKw = lower.match(/\b(youngest|cheapest|smallest|shortest)\b/);
  const maxKw = lower.match(/\b(oldest|most expensive|largest|tallest|longest)\b/);
  if (minKw) {
    const map: Record<string, string> = { youngest: 'age', cheapest: 'fare', shortest: 'duration', smallest: 'rating' };
    const f = resolveField(map[minKw[1]] ?? schema.numericFields[0], schema) ?? schema.numericFields[0];
    if (f) return { isAggregate: true, type: 'findRecordMin', field: f };
  }
  if (maxKw) {
    const kw = maxKw[1].replace(' ', '_');
    const map: Record<string, string> = { oldest: 'age', most_expensive: 'fare', longest: 'duration', largest: 'rating', tallest: 'age' };
    const f = resolveField(map[kw] ?? schema.numericFields[0], schema) ?? schema.numericFields[0];
    if (f) return { isAggregate: true, type: 'findRecordMax', field: f };
  }

  // Generic min/max numeric
  const minMatch = lower.match(/\b(min|minimum|lowest|smallest|least)\b[^a-z]*\b([a-z][a-z0-9_]*)\b/);
  if (minMatch) {
    const resolved = resolveField(minMatch[2], schema);
    if (resolved && schema.numericFields.includes(resolved))
      return { isAggregate: true, type: 'min', field: resolved };
  }
  const maxMatch = lower.match(/\b(max|maximum|highest|largest|greatest|most)\b[^a-z]*\b([a-z][a-z0-9_]*)\b/);
  if (maxMatch && !entityWords.has(maxMatch[2])) {
    const resolved = resolveField(maxMatch[2], schema);
    if (resolved && schema.numericFields.includes(resolved))
      return { isAggregate: true, type: 'max', field: resolved };
  }

  // Best / worst single record (no number = not top-N)
  if (/\b(best|top rated|highest rated)\b/.test(lower) && !/\b[0-9]+\b/.test(lower)) {
    return { isAggregate: true, type: 'findRecordMax', field: defaultRankField(schema) };
  }
  if (/\b(worst|lowest rated|poorest)\b/.test(lower) && !/\b[0-9]+\b/.test(lower)) {
    return { isAggregate: true, type: 'findRecordMin', field: defaultRankField(schema) };
  }

  return { isAggregate: false, type: '', field: '' };
}

/**
 * Detects numeric filter conditions like "rating over 8", "age under 5".
 * Validates the field against schema numeric fields.
 */
function detectFilter(msg: string, schema: DatasetSchema): { isFilter: boolean; field: string; op: string; value: number } | null {
  const lower = msg.toLowerCase();
  const match = lower.match(/\b([a-z][a-z0-9_]*)\b[^a-z0-9]*\b(under|below|less than|younger than|cheaper than|over|above|greater than|older than|more than)\b[^0-9]*([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;

  const [, fieldWord, opWord, numStr] = match;
  const resolved = resolveField(fieldWord, schema) ?? fieldWord;
  const op = ['under', 'below', 'less than', 'younger than', 'cheaper than'].some(w => opWord.includes(w)) ? '<' : '>';
  return { isFilter: true, field: resolved, op, value: parseFloat(numStr) };
}

interface FilteredAggResult {
  isFilteredAgg: boolean;
  aggType: 'sum' | 'avg' | 'count';
  metricField: string;
  filterField: string;
  filterValue: string;
}

/**
 * Detects filtered aggregations: "total revenue in Electronics", "avg price for North".
 * Must run before detectAggregation so it intercepts category-scoped queries.
 */
function detectFilteredAgg(msg: string, schema: DatasetSchema): FilteredAggResult {
  const lower = msg.toLowerCase();
  const none: FilteredAggResult = { isFilteredAgg: false, aggType: 'sum', metricField: '', filterField: '', filterValue: '' };

  if (!/\b(total|sum|average|avg|mean|count|how many)\b/.test(lower)) return none;

  // Require "in/for/from/within [value]" at or near the end
  const filterMatch = lower.match(/\b(?:in|for|from|within)\s+([a-z][a-z0-9\s]*)(?:\s*[?.]?\s*$)/);
  if (!filterMatch) return none;
  const filterPhrase = filterMatch[1].trim();

  // Find which categorical field contains this value
  let filterField = '';
  let filterValue = '';
  for (const catField of schema.categoricalFields) {
    for (const val of (schema.topValues[catField] ?? [])) {
      const v = val.toLowerCase();
      if (v === filterPhrase || v === filterPhrase.replace(/s$/, '') || filterPhrase === v + 's') {
        filterField = catField;
        filterValue = val;
        break;
      }
    }
    if (filterField) break;
  }
  if (!filterField) return none;

  // Metric field = words between the agg keyword and the filter clause
  const aggIdx = lower.search(/\b(total|sum|average|avg|mean|count|how many)\b/);
  const filterIdx = lower.search(/\b(?:in|for|from|within)\s/);
  const mid = lower.slice(aggIdx, filterIdx > aggIdx ? filterIdx : lower.length);

  let metricField = '';
  const stop = new Set(['total', 'sum', 'average', 'avg', 'mean', 'count', 'how', 'many', 'the', 'of', 'a', 'an', 'is', 'are']);
  for (const word of mid.split(/\W+/)) {
    if (stop.has(word) || word.length < 2) continue;
    const r = resolveField(word, schema);
    if (r && schema.numericFields.includes(r)) { metricField = r; break; }
  }

  // Decide agg type: avg if explicitly requested; count only if no numeric field found;
  // otherwise sum ("how many sold in X" = sum of sold, not count of rows)
  const aggType: 'sum' | 'avg' | 'count' =
    /\b(average|avg|mean)\b/.test(lower) ? 'avg' :
    metricField && metricField !== 'rows' ? 'sum' : 'count';

  if (!metricField) metricField = aggType === 'count' ? 'rows' : defaultRankField(schema);

  return { isFilteredAgg: true, aggType, metricField, filterField, filterValue };
}

/**
 * Detects "list all X", "give me all X", "show all X", "what are all X" queries.
 * Routes to a full distinct-value scan instead of RAG (which only sees 8 chunks).
 */
function detectListAll(msg: string, schema: DatasetSchema): { isListAll: boolean; field: string } {
  const lower = msg.toLowerCase();
  const none = { isListAll: false, field: '' };

  if (!/\b(all|list|show|give|display|what are|get)\b/.test(lower)) return none;

  // Find the first word that resolves to a known field (categorical preferred)
  const words = lower.split(/\W+/).filter(w => w.length >= 2);
  for (const word of words) {
    const resolved = resolveField(word, schema);
    if (!resolved) continue;
    // Prefer categorical fields (product names, categories, etc.)
    if (schema.categoricalFields.includes(resolved)) return { isListAll: true, field: resolved };
    // Also accept allFields (e.g. "list all years")
    if (schema.allFields.includes(resolved)) return { isListAll: true, field: resolved };
  }
  return none;
}

/**
 * Detects trend queries like "rating by year", "monthly trend", "over time".
 * Finds a time field (year/date) and a metric field to aggregate per period.
 */
function detectTrend(msg: string, schema: DatasetSchema): {
  isTrend: boolean; timeField: string; metricField: string; period: 'year' | 'month' | 'decade'; aggType: 'avg' | 'sum'
} {
  const lower = msg.toLowerCase();
  const none = { isTrend: false, timeField: '', metricField: '', period: 'year' as const, aggType: 'avg' as const };

  const isTrendKeyword = /\b(trend|over time|per year|by year|yearly|annual|per month|by month|monthly|over the years|progression|through the years|year by year|each year)\b/.test(lower);
  const isHighestYear = /\b(highest|best|which|high).{0,20}\b(year|month)\b/.test(lower)
    || /\b(year|month).{0,20}\b(highest|most|best|high)\b/.test(lower);
  if (!isTrendKeyword && !isHighestYear) return none;

  // Find a time-like field in schema
  const timeField = schema.numericFields.find(f => /\b(year|yr)\b/.test(f))
    ?? schema.numericFields.find(f => /\b(date|released|release)\b/.test(f))
    ?? schema.allFields.find(f => /\b(year|yr|date|released|release)\b/.test(f));
  if (!timeField) return none;

  const period: 'year' | 'month' | 'decade' =
    /\b(month|monthly)\b/.test(lower) ? 'month' :
    /\b(decade)\b/.test(lower) ? 'decade' : 'year';

  // Try to find an explicit metric: "rating trend by year", "trend of boxoffice"
  let metricField = '';
  const patterns = [
    lower.match(/\btrend\s+(?:of\s+)?([a-z][a-z0-9_\s]*?)\s+(?:by|per|over)\b/)?.[1],
    lower.match(/\b([a-z][a-z0-9_]*)\s+(?:trend|per year|by year|over time)\b/)?.[1],
    lower.match(/\bby\s+([a-z][a-z0-9_]+)\b/)?.[1],
  ];
  for (const m of patterns) {
    if (m) {
      const r = resolveField(m.trim(), schema);
      if (r && schema.numericFields.includes(r) && r !== timeField) { metricField = r; break; }
    }
  }
  if (!metricField) metricField = defaultRankField(schema);

  // Use sum for revenue/sales-type fields or "highest year" queries; avg otherwise
  const aggType: 'avg' | 'sum' = isHighestYear
    || /\b(revenue|sales|income|profit|units|amount|total)\b/.test(lower)
    ? 'sum' : 'avg';

  return { isTrend: true, timeField, metricField, period, aggType };
}

/**
 * Detects conditional count queries:
 * - "how many survived"          → count(survived=1)  [binary 0/1 field]
 * - "how many in pclass 3"       → count(pclass=3)
 * - "how many passenger who have cabin" → count(cabin is not empty)
 */
function detectConditionalCount(msg: string, schema: DatasetSchema): {
  isConditionalCount: boolean; field: string; value: string | null; op: '=' | 'nonempty'
} {
  const lower = msg.toLowerCase();
  const none = { isConditionalCount: false, field: '', value: null, op: '=' as const };
  if (!/\b(how many|count|number of)\b/.test(lower)) return none;

  // "have/has/with [field]" → nonempty — e.g. "how many passenger who have cabin"
  const haveMatch = lower.match(/\b(?:have|has|with)\s+(?:a\s+|an\s+)?([a-z][a-z0-9_]*)\b/);
  if (haveMatch) {
    const resolved = resolveField(haveMatch[1], schema);
    if (resolved) return { isConditionalCount: true, field: resolved, value: null, op: 'nonempty' };
  }

  // "[field] [number]" pair — e.g. "how many in pclass 3", "how many who avail pclass 1"
  const fieldNumMatch = lower.match(/\b([a-z][a-z0-9_]*)\s+([0-9]+)\b/);
  if (fieldNumMatch) {
    const resolved = resolveField(fieldNumMatch[1], schema);
    if (resolved && resolved !== 'rows') {
      return { isConditionalCount: true, field: resolved, value: fieldNumMatch[2], op: '=' };
    }
  }

  // Binary numeric field (range 0–1) used as verb — e.g. "how many survived"
  for (const field of schema.numericFields) {
    const r = schema.ranges[field];
    if (r && r.min === 0 && r.max === 1 && new RegExp(`\\b${field}\\b`).test(lower)) {
      return { isConditionalCount: true, field, value: '1', op: '=' };
    }
  }

  return none;
}

/** Detects outlier/anomaly queries */
function detectOutliers(msg: string): boolean {
  return /\b(outlier|outliers|anomaly|anomalies|unusual|extreme values?|abnormal)\b/.test(msg.toLowerCase());
}

/** Quick check: does this query look like it needs structured computation? */
function isStructuralQuery(msg: string): boolean {
  const lower = msg.toLowerCase();
  return /\b(top|bottom|best|worst|highest|lowest)\b[^a-z0-9]*[0-9]/.test(lower)
    || /\b(how many|count|number of|average|mean|avg|sum|total|minimum|maximum|min|max)\b/.test(lower)
    || /\b(best|worst|top|most popular|most common)\b/.test(lower)
    || /\b(under|below|less than|over|above|greater than|younger than|older than)\b.{0,15}[0-9]/.test(lower)
    || /\b(what are|list|show|give|display|get).{0,20}\b(column|field|header|attribute)/.test(lower)
    || /\b(all|list all|show all|give me all|what are all|get all|display all)\b/.test(lower)
    || /\b(trend|over time|per year|by year|yearly|monthly|per month|over the years)\b/.test(lower)
    || /\b(outlier|outliers|anomaly|anomalies|unusual|extreme values?)\b/.test(lower)
    || /\b(highest|best|which|high).{0,20}\b(year|month)\b/.test(lower)
    || /\b(year|month).{0,20}\b(highest|most revenue|most sales|best)\b/.test(lower)
    || /\b(earliest|latest|newest|most recent|first to|last to)\b/.test(lower)
    || /\b(information about|info about|tell me about|describe|summary of|overview of)\b.{0,20}\b(dataset|data|file|csv)\b/.test(lower)
    || /\b(what is this|what's this|about this)\b.{0,20}\b(dataset|data|file|csv)\b/.test(lower)
    || /\b(about (this|the) dataset|about (this|the) data)\b/.test(lower)
    || /\b(per|by each|for each)\s+[a-z]/.test(lower)
    || /\b(highest|lowest)\b/.test(lower);
}

/**
 * Detects follow-up questions that reference a prior answer.
 * Skips all structured paths and is answered with conversation history.
 * Pass historyLength > 0 to enable context-aware short-message detection.
 */
function isFollowUp(msg: string, historyLength = 0): boolean {
  const lower = msg.trim().toLowerCase();

  // Single-word / bare follow-ups
  if (/^(why\??|reason\??|reasoning\??|explain\??|elaborate\??|how\??|details?\??)$/.test(lower)) return true;
  // "and the worst/best?"
  if (/^and (the )?(worst|best|top|lowest|highest|bottom)\??$/.test(lower)) return true;
  // "what about X?" — short follow-up
  if (/^what about\b/.test(lower) && lower.length < 35) return true;
  // "what are those/these/they?"
  if (/^what are (those|these|they)\??$/.test(lower)) return true;
  // "list them", "show them", "show me"
  if (/^(list|show) (them|it|me)\??$/.test(lower)) return true;

  // Back-reference + explain intent
  const hasBackRef = /\b(this|these|that|those|the results?|the list|the ranking|the answer|them|it|above|previous|that result)\b/.test(lower);
  const hasExplainIntent = /^(why|how come|what does|what do|what are|what is|explain|elaborate|tell me more|can you explain|could you explain|what about|so why|and why|give me reason|what is the reason|how is|compare|is that|are these|list|show)/.test(lower);
  if (hasBackRef && hasExplainIntent) return true;

  // Short vague message with conversation history → treat as conversational follow-up
  // (avoids falling through to RAG which has no semantic match for vague questions)
  if (historyLength > 0 && lower.length < 60 && !isStructuralQuery(msg)) return true;

  return false;
}

/** Generate a few example queries based on the actual schema to guide the user */
function buildSuggestions(schema: DatasetSchema): string {
  const tips: string[] = [];
  const noun = schema.titleField ? schema.titleField + 's' : 'records';
  if (schema.numericFields.length > 0) {
    tips.push(`"top 10 by ${schema.numericFields[0]}"`);
    tips.push(`"average ${schema.numericFields[0]}"`);
  }
  if (schema.categoricalFields.length > 0) {
    tips.push(`"best ${schema.categoricalFields[0]}"`);
    const topVal = schema.topValues[schema.categoricalFields[0]]?.[0];
    if (topVal) tips.push(`"top 10 ${topVal} ${noun}"`);
  }
  return tips.length > 0 ? `\n\nTry: ${tips.slice(0, 3).join(' or ')}` : '';
}

// ── Parsing / formatting helpers ──────────────────────────────────────────

/** Parses "key: value, key: value" text chunks into lowercase key-value objects */
function parseChunk(text: string): Record<string, string> {
  const fields = text.split(/, (?=[A-Za-z][A-Za-z0-9_]*: )/);
  const result: Record<string, string> = {};
  for (const f of fields) {
    const idx = f.indexOf(': ');
    if (idx !== -1) result[f.slice(0, idx).trim().toLowerCase()] = f.slice(idx + 2).trim();
  }
  return result;
}

/** Find the actual key in a record matching the target (schema-aware fuzzy match) */
function findField(record: Record<string, string>, target: string, schema?: DatasetSchema): string | null {
  const t = schema ? (resolveField(target, schema) ?? target.toLowerCase()) : target.toLowerCase();
  if (record[t]) return t;
  for (const key of Object.keys(record)) {
    if (key.includes(t) || t.includes(key)) return key;
  }
  return null;
}

/** Formats a parsed record back into a readable string */
function formatRecord(rec: Record<string, string>): string {
  return Object.entries(rec)
    .map(([k, v]) => `${k.charAt(0).toUpperCase() + k.slice(1)}: ${v}`)
    .join(', ');
}

/** Formats a record as a numbered ranking entry */
function formatRankedEntry(rank: number, rec: Record<string, string>, sortField: string, schema: DatasetSchema): string {
  const sortKey = findField(rec, sortField, schema);
  const sortValue = sortKey ? rec[sortKey] : null;
  const titleKey = schema.titleField ?? 'title';
  const title = rec[titleKey] ?? rec['title'] ?? rec['name'] ?? rec['movie'] ?? null;

  const label = title
    ? `${rank}. ${title}${sortValue && sortKey ? ` (${sortKey}: ${sortValue})` : ''}`
    : `${rank}.${sortValue && sortKey ? ` ${sortKey}: ${sortValue}` : ''}`;

  const details = Object.entries(rec)
    .filter(([k]) => k !== titleKey && k !== 'title' && k !== 'name' && k !== 'movie')
    .map(([k, v]) => `${k.charAt(0).toUpperCase() + k.slice(1)}: ${v}`)
    .join(' | ');

  return `${label}\n   ${details}`;
}

/**
 * Detects group-by breakdown queries: "revenue per department", "total sales by category".
 * Returns a per-group aggregation (all groups), sorted by value descending.
 */
function detectGroupBy(msg: string, schema: DatasetSchema): {
  isGroupBy: boolean; groupField: string; metricField: string; aggType: 'sum' | 'avg' | 'max' | 'min' | 'count'
} {
  const lower = msg.toLowerCase();
  const none = { isGroupBy: false, groupField: '', metricField: '', aggType: 'sum' as const };

  // Match "per [field]", "by each [field]", "for each [field]"
  // Also match "by [field]" at the very end of the sentence (not "by year/month" for trends)
  const perMatch = lower.match(/\b(?:per|by each|for each)\s+([a-z][a-z0-9_]*)\b/)
    ?? lower.match(/\bby\s+([a-z][a-z0-9_]*)\s*[?.]?\s*$/)?.index !== undefined
      ? lower.match(/\bby\s+([a-z][a-z0-9_]*)\s*[?.]?\s*$/)
      : null;
  if (!perMatch) return none;

  const groupWord = perMatch[1];
  // Don't treat time fields as group-by fields
  if (/^(year|month|date|time|day|week|quarter)s?$/.test(groupWord)) return none;
  const resolved = resolveField(groupWord, schema);
  if (!resolved || !schema.categoricalFields.includes(resolved)) return none;

  const aggType: 'sum' | 'avg' | 'max' | 'min' | 'count' =
    /\b(average|avg|mean)\b/.test(lower) ? 'avg' :
    /\b(max|maximum|highest)\b/.test(lower) ? 'max' :
    /\b(min|minimum|lowest)\b/.test(lower) ? 'min' :
    /\b(count|how many)\b/.test(lower) ? 'count' : 'sum';

  const skip = new Set(['per', 'by', 'each', 'for', 'in', 'total', 'sum', 'average', 'avg',
    'mean', 'max', 'min', 'highest', 'lowest', 'the', 'of', 'a', 'an', 'revenue', groupWord]);
  let metricField = '';
  for (const word of lower.split(/\W+/)) {
    if (skip.has(word) || word.length < 2) continue;
    const r = resolveField(word, schema);
    if (r && schema.numericFields.includes(r)) { metricField = r; break; }
  }
  // Re-resolve the explicit metric word without the skip guard on "revenue" etc.
  if (!metricField) {
    for (const word of lower.split(/\W+/)) {
      if (['per', 'by', 'each', 'for', 'in', 'the', 'of', 'a', 'an', groupWord].includes(word)) continue;
      const r = resolveField(word, schema);
      if (r && schema.numericFields.includes(r)) { metricField = r; break; }
    }
  }
  if (!metricField && aggType !== 'count') metricField = defaultRankField(schema);

  return { isGroupBy: true, groupField: resolved, metricField, aggType };
}

// ── Main route handler ─────────────────────────────────────────────────────

export async function POST(req: Request) {
  try {
    const { message, fileId, history = [] } = await req.json();

    if (!message || !fileId) {
      return NextResponse.json({ error: 'Message and fileId are required' }, { status: 400 });
    }

    // ── Contextual field lookup ───────────────────────────────────────────
    // "give me monthly sales about this shop" → resolve entity from history → exact lookup
    const msgLower0 = message.toLowerCase();
    const hasBackRef = /\b(this|that|it|the same|about this|for this|of this|for that)\b/.test(msgLower0);
    if (hasBackRef && history.length > 0) {
      const allChunks0 = await getAllChunks(fileId);
      const records0 = allChunks0.filter(c => !c.startsWith('This dataset has')).map(parseChunk);
      const schema0 = buildSchema(records0);

      // Find field name in the message
      let ctxMetric = '';
      for (const word of msgLower0.split(/\W+/).filter((w: string) => w.length >= 3)) {
        const r = resolveField(word, schema0);
        if (r && schema0.numericFields.includes(r)) { ctxMetric = r; break; }
      }

      if (ctxMetric) {
        // Find entity name in last assistant message
        const lastAnswer = [...history].reverse().find(h => h.role === 'assistant')?.content ?? '';
        const searchFields = schema0.titleField
          ? [schema0.titleField, ...schema0.categoricalFields]
          : schema0.categoricalFields;

        let ctxEntityField = '';
        let ctxEntityValue = '';
        outer0: for (const field of searchFields) {
          for (const val of (schema0.topValues[field] ?? [])) {
            if (val.length >= 3 && lastAnswer.toLowerCase().includes(val.toLowerCase())) {
              ctxEntityField = field;
              ctxEntityValue = val;
              break outer0;
            }
          }
        }

        if (ctxEntityField && ctxEntityValue) {
          const matched0 = records0.filter(rec => {
            const key = findField(rec, ctxEntityField, schema0);
            return key && rec[key]?.trim().toLowerCase() === ctxEntityValue.toLowerCase();
          });

          if (matched0.length > 0) {
            const nums = matched0.flatMap(rec => {
              const key = findField(rec, ctxMetric, schema0);
              const n = key ? parseFloat(rec[key]) : NaN;
              return isNaN(n) ? [] : [n];
            });
            if (nums.length > 0) {
              const total = nums.reduce((a, b) => a + b, 0);
              const globalVals = records0.flatMap(rec => {
                const key = findField(rec, ctxMetric, schema0);
                const n = key ? parseFloat(rec[key]) : NaN;
                return isNaN(n) ? [] : [n];
              });
              const globalAvg = globalVals.reduce((a, b) => a + b, 0) / globalVals.length;
              const rank = [...globalVals].sort((a, b) => b - a).indexOf(total) + 1;
              const pct = ((total / globalVals.reduce((a, b) => a + b, 0)) * 100).toFixed(1);
              const vsAvg = total > globalAvg
                ? `${((total / globalAvg - 1) * 100).toFixed(0)}% above average`
                : `${((1 - total / globalAvg) * 100).toFixed(0)}% below average`;
              const answer = `${ctxEntityValue}: ${ctxMetric} = ${total.toLocaleString()}\n\n` +
                `Ranked #${rank} of ${globalVals.length} records by ${ctxMetric}. ` +
                `${pct}% of total dataset ${ctxMetric}. ${vsAvg} (global avg: ${globalAvg.toFixed(0)}).`;
              return NextResponse.json({ answer, sources: [] });
            }
          }
        }
      }
    }

    // ── Follow-up path ───────────────────────────────────────────────────
    if (isFollowUp(message, history.length)) {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `You are a data analyst assistant. A user has uploaded a dataset and is asking a follow-up question. Your job is to reason ONLY from the conversation history, which contains prior answers computed directly from that dataset.

CORE RULES:
1. Treat the conversation history as the ONLY source of truth.
2. Never use prior knowledge.
3. Never guess missing values.
4. Never fabricate records, numbers, dates, or breakdowns.
5. If the information is not in the conversation history, say exactly: "The dataset does not contain enough information to answer this question."

STRICT RULES — violating these is worse than saying "I don't know":
- NEVER invent numbers, dates, years, breakdowns, or sub-components not explicitly shown in the conversation history.
- NEVER decompose a single total/sum into yearly, monthly, or category components unless those components were explicitly listed in a previous answer.
- NEVER guess field names, country names, city names, or any data values.

Give the answer directly — just the value or explanation, nothing else.
- No intro phrases like "Based on the data", "The dataset shows", "Great question", etc.
- If showing a single record: Field: Value format. Start with name/title if present.
- If listing ≤5 items: comma-separated with "and" before last.
- If listing >5 items: numbered list, one per line.
- No markdown (no **, no __, no ##, no backticks). Plain text only.
- Never include raw ID fields (movieid, id, userid, etc.).`
          },
          ...history.slice(-10) as { role: 'user' | 'assistant'; content: string }[],
          { role: 'user', content: message }
        ],
      });
      return NextResponse.json({ answer: completion.choices[0].message.content, sources: [] });
    }

    // ── Structured paths (load all chunks + build schema once) ───────────
    if (isStructuralQuery(message)) {
      const allChunks = await getAllChunks(fileId);
      const dataChunks = allChunks.filter(c => !c.startsWith('This dataset has'));
      const records = dataChunks.map(parseChunk);
      const schema = buildSchema(records);

      // ── Dataset info: "give me information about this dataset" ──────────
      const msgLower = message.toLowerCase();
      if (/\b(information about|info about|tell me about|describe|summary of|overview of)\b.{0,20}\b(dataset|data|file|csv)\b/.test(msgLower)
        || /\b(about (this|the) dataset|about (this|the) data)\b/.test(msgLower)
        || /\b(what is this|what's this)\b.{0,20}\b(dataset|data|file|csv)\b/.test(msgLower)) {
        const fieldList = schema.allFields.join(', ');
        const answer = `${records.length} records, ${schema.allFields.length} columns.\n\nColumns: ${fieldList}.`;
        return NextResponse.json({ answer, context: `schema:${schema.allFields.join(',')} rows:${records.length}`, sources: [] });
      }

      // ── Schema queries: "what are the columns", "how many columns" ───────
      if (/\b(column|field|header|attribute|feature)s?\b/.test(msgLower)) {
        const fieldList = schema.allFields.length > 1
          ? schema.allFields.slice(0, -1).join(', ') + ', and ' + schema.allFields[schema.allFields.length - 1]
          : schema.allFields[0] ?? '';
        if (/\b(what are|list|show|display)\b/.test(msgLower)) {
          return NextResponse.json({
            answer: fieldList,
            context: `columns:${schema.allFields.join(',')} count:${schema.allFields.length}`,
            sources: []
          });
        }
        if (/\b(how many|count|number of)\b/.test(msgLower)) {
          return NextResponse.json({
            answer: `${schema.allFields.length}`,
            context: `columns:${schema.allFields.join(',')} count:${schema.allFields.length}`,
            sources: []
          });
        }
      }

      const listAll = detectListAll(message, schema);

      // ── List all values: "give me all products", "list all categories" ──
      if (listAll.isListAll) {
        const seen = new Set<string>();
        for (const rec of records) {
          const key = findField(rec, listAll.field, schema);
          if (key && rec[key]?.trim()) seen.add(rec[key].trim());
        }
        const values = Array.from(seen).sort();
        if (values.length === 0) {
          return NextResponse.json({ answer: `No values found for "${listAll.field}".`, sources: [] });
        }
        const lines = values.map((v, i) => `${i + 1}. ${v}`).join('\n');
        return NextResponse.json({
          answer: `${values.length} unique ${listAll.field} values:\n\n${lines}`,
          context: `listAll field:${listAll.field} count:${values.length} values:${values.slice(0, 30).join(',')}`,
          sources: []
        });
      }

      const topN = detectTopN(message, schema);
      const groupBy = !topN.isTopN
        ? detectGroupBy(message, schema)
        : { isGroupBy: false, groupField: '', metricField: '', aggType: 'sum' as const };
      const groupRank = (!topN.isTopN && !groupBy.isGroupBy)
        ? detectGroupRank(message, schema)
        : { isGroupRank: false, groupField: '', metric: '', order: 'desc' as const };
      const condCount = (!topN.isTopN && !groupBy.isGroupBy && !groupRank.isGroupRank)
        ? detectConditionalCount(message, schema)
        : { isConditionalCount: false, field: '', value: null, op: '=' as const };
      const filteredAgg = (!topN.isTopN && !groupBy.isGroupBy && !groupRank.isGroupRank && !condCount.isConditionalCount)
        ? detectFilteredAgg(message, schema)
        : { isFilteredAgg: false, aggType: 'sum' as const, metricField: '', filterField: '', filterValue: '' };
      const agg = (!topN.isTopN && !groupBy.isGroupBy && !groupRank.isGroupRank && !condCount.isConditionalCount && !filteredAgg.isFilteredAgg)
        ? detectAggregation(message, schema)
        : { isAggregate: false, type: '', field: '' };
      const filter = (!topN.isTopN && !groupBy.isGroupBy && !groupRank.isGroupRank && !condCount.isConditionalCount && !filteredAgg.isFilteredAgg && !agg.isAggregate)
        ? detectFilter(message, schema)
        : null;
      const trend = (!topN.isTopN && !groupBy.isGroupBy && !groupRank.isGroupRank && !filteredAgg.isFilteredAgg && !agg.isAggregate && !filter)
        ? detectTrend(message, schema)
        : { isTrend: false, timeField: '', metricField: '', period: 'year' as const, aggType: 'avg' as const };
      const hasOutlierQuery = (!topN.isTopN && !groupBy.isGroupBy && !groupRank.isGroupRank && !filteredAgg.isFilteredAgg && !agg.isAggregate && !filter && !trend.isTrend)
        ? detectOutliers(message)
        : false;

      // ── Top-N ranking ──────────────────────────────────────────────────
      if (topN.isTopN) {
        let rankable = records.filter(rec => {
          const key = findField(rec, topN.field, schema);
          return key !== null && !isNaN(parseFloat(rec[key]));
        });

        // Apply compound category filter (e.g. "top 10 crime movies")
        if (topN.categoryFilter) {
          const { field: catField, value: catValue } = topN.categoryFilter;
          const filtered = rankable.filter(rec => {
            const key = findField(rec, catField, schema);
            return key !== null && rec[key].trim().toLowerCase() === catValue.toLowerCase();
          });
          if (filtered.length > 0) rankable = filtered;
        }

        if (rankable.length === 0) {
          return NextResponse.json({
            answer: `No records with a "${topN.field}" value found in this dataset.${buildSuggestions(schema)}`,
            sources: []
          });
        }

        const sorted = rankable.sort((a, b) => {
          const aKey = findField(a, topN.field, schema)!;
          const bKey = findField(b, topN.field, schema)!;
          return topN.order === 'desc'
            ? parseFloat(b[bKey]) - parseFloat(a[aKey])
            : parseFloat(a[aKey]) - parseFloat(b[bKey]);
        });

        const topRecords = sorted.slice(0, topN.n);
        const actualSortKey = findField(topRecords[0], topN.field, schema) ?? topN.field;
        const filterNote = topN.categoryFilter ? ` (${topN.categoryFilter.field}: ${topN.categoryFilter.value})` : '';

        const lines = topRecords.map((rec, i) => formatRankedEntry(i + 1, rec, topN.field, schema));
        const answer = lines.join('\n\n');

        const context = `topN:${topN.n} field:${actualSortKey} order:${topN.order} filter:${topN.categoryFilter ? `${topN.categoryFilter.field}=${topN.categoryFilter.value}` : 'none'} records:${rankable.length}`;

        const chartData: ChartData = {
          type: 'bar',
          title: `Top ${topN.n}${filterNote} by ${actualSortKey}`,
          xKey: 'label',
          yKey: actualSortKey,
          data: topRecords.map(rec => {
            const tk = schema.titleField ?? 'title';
            const name = rec[tk] ?? rec['title'] ?? rec['name'] ?? rec['movie'] ?? 'Record';
            const sk = findField(rec, topN.field, schema);
            const val = sk ? parseFloat(rec[sk]) : 0;
            const label = name.length > 14 ? name.slice(0, 14) + '…' : name;
            return { label, [actualSortKey]: isNaN(val) ? 0 : val };
          })
        };

        return NextResponse.json({ answer, context, sources: [], chartData });
      }

      // ── Group-by breakdown: "revenue per department", "total sales by category" ──
      if (groupBy.isGroupBy) {
        const groups: Record<string, number[]> = {};
        for (const rec of records) {
          const gKey = findField(rec, groupBy.groupField, schema);
          if (!gKey) continue;
          const gVal = rec[gKey]?.trim();
          if (!gVal) continue;
          if (groupBy.aggType === 'count') {
            groups[gVal] = (groups[gVal] ?? []);
            groups[gVal].push(1);
          } else {
            const mKey = findField(rec, groupBy.metricField, schema);
            if (!mKey) continue;
            const num = parseFloat(rec[mKey]);
            if (!isNaN(num)) {
              groups[gVal] = (groups[gVal] ?? []);
              groups[gVal].push(num);
            }
          }
        }

        if (Object.keys(groups).length === 0) {
          return NextResponse.json({ answer: `No data found for "${groupBy.groupField}".`, sources: [] });
        }

        const results = Object.entries(groups).map(([group, vals]) => {
          let score: number;
          if (groupBy.aggType === 'sum') score = vals.reduce((a, b) => a + b, 0);
          else if (groupBy.aggType === 'avg') score = vals.reduce((a, b) => a + b, 0) / vals.length;
          else if (groupBy.aggType === 'max') score = Math.max(...vals);
          else if (groupBy.aggType === 'min') score = Math.min(...vals);
          else score = vals.length;
          return { group, score, count: vals.length };
        }).sort((a, b) => b.score - a.score);

        const lines = results.map((r, i) => `${i + 1}. ${r.group}: ${Number.isInteger(r.score) ? r.score.toLocaleString() : r.score.toFixed(2)}`);
        const answer = lines.join('\n');

        const chartData: ChartData = {
          type: 'bar',
          title: `${groupBy.aggType} ${groupBy.metricField} by ${groupBy.groupField}`,
          xKey: 'group',
          yKey: 'value',
          data: results.slice(0, 10).map(r => ({
            group: r.group.length > 14 ? r.group.slice(0, 14) + '…' : r.group,
            value: parseFloat(r.score.toFixed(2))
          }))
        };

        return NextResponse.json({
          answer,
          context: `groupBy:${groupBy.aggType} metric:${groupBy.metricField} group:${groupBy.groupField} groups:${results.length}`,
          sources: [],
          chartData
        });
      }

      // ── Group-rank: "best genre", "worst director" ─────────────────────
      if (groupRank.isGroupRank) {
        const groups: Record<string, number[]> = {};
        for (const rec of records) {
          const gKey = findField(rec, groupRank.groupField, schema);
          if (!gKey) continue;
          const gVal = rec[gKey]?.trim();
          if (!gVal) continue;

          if (groupRank.metric === 'count') {
            groups[gVal] = (groups[gVal] ?? []);
            groups[gVal].push(1);
          } else {
            const mKey = findField(rec, groupRank.metric, schema);
            if (!mKey) continue;
            const num = parseFloat(rec[mKey]);
            if (!isNaN(num)) {
              groups[gVal] = (groups[gVal] ?? []);
              groups[gVal].push(num);
            }
          }
        }

        const ranked = Object.entries(groups)
          .map(([group, vals]) => ({
            group,
            score: vals.reduce((a, b) => a + b, 0) / vals.length,
            count: vals.length,
          }))
          .sort((a, b) => groupRank.order === 'desc' ? b.score - a.score : a.score - b.score);

        if (ranked.length === 0) {
          return NextResponse.json({
            answer: `No data found for field "${groupRank.groupField}".${buildSuggestions(schema)}`,
            sources: []
          });
        }

        const best = ranked[0];
        const context = `ranking: ${ranked.slice(0, 10).map((r, i) =>
          `${i + 1}.${r.group}(${groupRank.metric === 'count' ? r.count : r.score.toFixed(2)})`
        ).join(',')} total:${records.length} field:${groupRank.groupField} metric:${groupRank.metric}`;

        const metricLabel = groupRank.metric === 'count' ? 'appearances' : `avg ${groupRank.metric}`;

        const chartData: ChartData = {
          type: 'bar',
          title: `${groupRank.groupField} by ${metricLabel}`,
          xKey: 'group',
          yKey: 'value',
          data: ranked.slice(0, 10).map(r => ({
            group: r.group.length > 14 ? r.group.slice(0, 14) + '…' : r.group,
            value: parseFloat((groupRank.metric === 'count' ? r.count : r.score).toFixed(2))
          }))
        };

        return NextResponse.json({ answer: `${best.group}`, context, sources: [], chartData });
      }

      // ── Filter: "rating over 8", "age under 5" ─────────────────────────
      if (filter) {
        const matched = records.filter(rec => {
          const key = findField(rec, filter.field, schema);
          if (!key) return false;
          const num = parseFloat(rec[key]);
          if (isNaN(num)) return false;
          return filter.op === '<' ? num < filter.value : num > filter.value;
        });

        if (matched.length === 0) {
          return NextResponse.json({
            answer: `No records found where ${filter.field} is ${filter.op === '<' ? 'under' : 'over'} ${filter.value}. All ${records.length} records were checked.`,
            sources: []
          });
        }

        const lines = matched.slice(0, 10).map((rec, i) => `${i + 1}. ${formatRecord(rec)}`);
        const opLabel = filter.op === '<' ? 'under' : 'over';
        const answer = [
          `Found ${matched.length} record(s) where ${filter.field} is ${opLabel} ${filter.value}:`,
          ``,
          lines.join('\n'),
          matched.length > 10 ? `\n…and ${matched.length - 10} more.` : ''
        ].join('\n');

        return NextResponse.json({ answer, sources: [] });
      }

      // ── Conditional count: "how many survived", "how many in pclass 3" ──
      if (condCount.isConditionalCount) {
        if (condCount.op === 'nonempty') {
          const count = records.filter(rec => {
            const key = findField(rec, condCount.field, schema);
            return key !== null && rec[key]?.trim().length > 0;
          }).length;
          return NextResponse.json({
            answer: `${count}`,
            context: `stat:condCount field:${condCount.field} op:nonempty result:${count} total:${records.length}`,
            sources: []
          });
        } else {
          const targetVal = condCount.value!;
          const count = records.filter(rec => {
            const key = findField(rec, condCount.field, schema);
            if (!key) return false;
            const v = rec[key]?.trim().toLowerCase();
            return v === targetVal.toLowerCase() || parseFloat(v) === parseFloat(targetVal);
          }).length;
          return NextResponse.json({
            answer: `${count}`,
            context: `stat:condCount field:${condCount.field} op:= value:${condCount.value} result:${count} total:${records.length}`,
            sources: []
          });
        }
      }

      // ── Filtered aggregation: "total revenue in Electronics" ────────────
      if (filteredAgg.isFilteredAgg) {
        const filtered = records.filter(rec => {
          const key = findField(rec, filteredAgg.filterField, schema);
          return key !== null && rec[key]?.trim().toLowerCase() === filteredAgg.filterValue.toLowerCase();
        });

        if (filtered.length === 0) {
          return NextResponse.json({
            answer: `No records found where ${filteredAgg.filterField} = "${filteredAgg.filterValue}".`,
            sources: []
          });
        }

        let answer = '';

        if (filteredAgg.aggType === 'count') {
          answer = `${filtered.length}`;
        } else {
          const values = filtered.flatMap(rec => {
            const key = findField(rec, filteredAgg.metricField, schema);
            if (!key) return [];
            const num = parseFloat(rec[key]);
            return isNaN(num) ? [] : [num];
          });

          if (values.length === 0) {
            return NextResponse.json({
              answer: `No numeric values for "${filteredAgg.metricField}" where ${filteredAgg.filterField} = "${filteredAgg.filterValue}".`,
              sources: []
            });
          }

          if (filteredAgg.aggType === 'sum') {
            const result = values.reduce((a, b) => a + b, 0);
            answer = `${result.toLocaleString()}`;
          } else {
            const avg = values.reduce((a, b) => a + b, 0) / values.length;
            answer = `${avg.toFixed(2)}`;
          }
        }

        return NextResponse.json({
          answer,
          context: `filteredAgg:${filteredAgg.aggType} metric:${filteredAgg.metricField} filter:${filteredAgg.filterField}=${filteredAgg.filterValue} n:${filtered.length} total:${records.length}`,
          sources: []
        });
      }

      // ── Aggregation: count, avg, sum, min, max, findRecord ────────────
      if (agg.isAggregate) {
        let answer = '';
        let context = '';

        if (agg.type === 'count') {
          answer = `${records.length}`;
          context = `stat:count total:${records.length}`;

        } else if (agg.type === 'countDistinct') {
          const seen = new Set<string>();
          for (const rec of records) {
            const key = findField(rec, agg.field, schema);
            if (key && rec[key]) seen.add(rec[key].trim());
          }
          const seenArr = Array.from(seen);
          answer = `${seenArr.length}`;
          context = `stat:countDistinct field:${agg.field} n:${seenArr.length} total:${records.length} values:${seenArr.slice(0, 30).join(',')}`;

        } else if (agg.type === 'findRecordMin' || agg.type === 'findRecordMax') {
          let extremeRec: Record<string, string> | null = null;
          let extremeVal = agg.type === 'findRecordMin' ? Infinity : -Infinity;

          for (const rec of records) {
            const key = findField(rec, agg.field, schema);
            if (key) {
              const num = parseFloat(rec[key]);
              if (!isNaN(num)) {
                if ((agg.type === 'findRecordMin' && num < extremeVal) ||
                    (agg.type === 'findRecordMax' && num > extremeVal)) {
                  extremeVal = num;
                  extremeRec = rec;
                }
              }
            }
          }

          if (extremeRec) {
            const titleKey = schema.titleField ?? 'title';
            const title = extremeRec[titleKey] ?? extremeRec['title'] ?? extremeRec['name'] ?? null;
            const label = agg.type === 'findRecordMin' ? 'Earliest/Lowest' : 'Latest/Highest';
            answer = title ?? `${extremeVal}`;
            context = `record:${formatRecord(extremeRec)} field:${agg.field} val:${extremeVal} label:${label.toLowerCase()} total:${records.length}`;
          } else {
            answer = `No record with a valid "${agg.field}" value found.`;
          }

        } else {
          const values: number[] = [];
          for (const rec of records) {
            const key = findField(rec, agg.field, schema);
            if (key) {
              const num = parseFloat(rec[key]);
              if (!isNaN(num)) values.push(num);
            }
          }

          if (values.length === 0) {
            answer = `No numeric values found for "${agg.field}" in the dataset.${buildSuggestions(schema)}`;
          } else if (agg.type === 'avg') {
            const avg = values.reduce((a, b) => a + b, 0) / values.length;
            answer = `${avg.toFixed(2)}`;
            context = `stat:avg field:${agg.field} n:${values.length} total:${records.length} range:${schema.ranges[agg.field]?.min ?? '?'}-${schema.ranges[agg.field]?.max ?? '?'}`;
          } else if (agg.type === 'sum') {
            const sum = values.reduce((a, b) => a + b, 0);
            answer = `${sum.toFixed(2)}`;
            context = `stat:sum field:${agg.field} n:${values.length} total:${records.length}`;
          } else if (agg.type === 'min') {
            const minVal = Math.min(...values);
            answer = `${minVal}`;
            context = `stat:min field:${agg.field} n:${values.length} total:${records.length}`;
          } else if (agg.type === 'max') {
            const maxVal = Math.max(...values);
            answer = `${maxVal}`;
            context = `stat:max field:${agg.field} n:${values.length} total:${records.length}`;
          }
        }

        return NextResponse.json({ answer, context, sources: [] });
      }

      // ── Trend: "rating by year", "yearly trend", "monthly trend" ──────────
      if (trend.isTrend) {
        const buckets: Record<string, number[]> = {};
        for (const rec of records) {
          const tKey = findField(rec, trend.timeField, schema);
          const mKey = findField(rec, trend.metricField, schema);
          if (!tKey || !mKey) continue;
          const rawTime = parseFloat(rec[tKey]);
          if (isNaN(rawTime)) continue;
          const metricNum = parseFloat(rec[mKey]);
          if (isNaN(metricNum)) continue;

          let bucket: string;
          if (trend.period === 'decade') {
            bucket = `${Math.floor(rawTime / 10) * 10}s`;
          } else if (trend.period === 'month') {
            bucket = rec[tKey].trim().slice(0, 7);
          } else {
            bucket = `${Math.floor(rawTime)}`;
          }
          if (!buckets[bucket]) buckets[bucket] = [];
          buckets[bucket].push(metricNum);
        }

        const bucketKeys = Object.keys(buckets);
        if (bucketKeys.length === 0) {
          return NextResponse.json({
            answer: `No trend data found. The dataset may not have a clear time or metric field.${buildSuggestions(schema)}`,
            sources: []
          });
        }

        const trendData = bucketKeys
          .map(p => ({
            period: p,
            value: parseFloat((
              trend.aggType === 'sum'
                ? buckets[p].reduce((a, b) => a + b, 0)
                : buckets[p].reduce((a, b) => a + b, 0) / buckets[p].length
            ).toFixed(2)),
            count: buckets[p].length
          }))
          .sort((a, b) => a.period.localeCompare(b.period));

        const best = [...trendData].sort((a, b) => b.value - a.value)[0];
        const aggLabel = trend.aggType === 'sum' ? 'total' : 'avg';

        const first = trendData[0];
        const last = trendData[trendData.length - 1];
        const delta = last.value - first.value;
        const direction = delta > 0.05 ? 'increased' : delta < -0.05 ? 'decreased' : 'stayed relatively stable';

        const trendLines = trendData.map(d =>
          `${d.period}: ${d.value.toLocaleString()} ${aggLabel} (${d.count} records)${d.period === best.period ? ' ← highest' : ''}`
        );
        const summary = trend.aggType === 'sum'
          ? `${best.period} had the highest total ${trend.metricField} at ${best.value.toLocaleString()} (across ${best.count} records).`
          : `${trend.metricField} ${direction} from ${first.value} (${first.period}) to ${last.value} (${last.period}) across ${trendData.length} ${trend.period}s.`;

        const chartData: ChartData = {
          type: 'line',
          title: `${trend.aggType === 'sum' ? 'Total' : 'Avg'} ${trend.metricField} by ${trend.period}`,
          xKey: 'period',
          yKey: trend.metricField,
          data: trendData.map(d => ({ period: d.period, [trend.metricField]: d.value }))
        };

        return NextResponse.json({
          answer: [summary, '', ...trendLines].join('\n'),
          context: `trend:${trend.period} field:${trend.metricField} timeField:${trend.timeField} points:${trendData.length}`,
          sources: [],
          chartData
        });
      }

      // ── Outliers: IQR-based detection on the primary numeric field ─────────
      if (hasOutlierQuery) {
        const targetField = defaultRankField(schema);
        const recVals: { rec: Record<string, string>; val: number }[] = [];
        for (const rec of records) {
          const key = findField(rec, targetField, schema);
          if (key) {
            const num = parseFloat(rec[key]);
            if (!isNaN(num)) recVals.push({ rec, val: num });
          }
        }

        if (recVals.length < 4) {
          return NextResponse.json({ answer: `Not enough data to detect outliers (need at least 4 records).`, sources: [] });
        }

        const sorted = recVals.map(r => r.val).sort((a, b) => a - b);
        const q1 = sorted[Math.floor(sorted.length * 0.25)];
        const q3 = sorted[Math.floor(sorted.length * 0.75)];
        const iqr = q3 - q1;
        const lo = q1 - 1.5 * iqr;
        const hi = q3 + 1.5 * iqr;

        const outliers = recVals.filter(({ val }) => val < lo || val > hi);

        if (outliers.length === 0) {
          return NextResponse.json({
            answer: `No outliers detected in "${targetField}" (IQR method). All ${recVals.length} records fall within the normal range of ${lo.toFixed(2)}–${hi.toFixed(2)}.`,
            sources: []
          });
        }

        const titleKey = schema.titleField ?? 'title';
        const lines = outliers.slice(0, 15).map((o, i) => {
          const title = o.rec[titleKey] ?? o.rec['title'] ?? o.rec['name'] ?? null;
          return title
            ? `${i + 1}. ${title} (${targetField}: ${o.val})`
            : `${i + 1}. ${targetField}: ${o.val}`;
        });

        const summary = `Found ${outliers.length} outlier(s) in "${targetField}". Normal range: ${lo.toFixed(2)}–${hi.toFixed(2)} (IQR method, ${recVals.length} records).`;
        const trailing = outliers.length > 15 ? `\n…and ${outliers.length - 15} more.` : '';

        const chartData: ChartData = {
          type: 'bar',
          title: `Outliers by ${targetField}`,
          xKey: 'label',
          yKey: targetField,
          data: outliers.slice(0, 15).map(o => {
            const title = o.rec[titleKey] ?? o.rec['title'] ?? o.rec['name'] ?? `val ${o.val}`;
            const label = title.length > 14 ? title.slice(0, 14) + '…' : title;
            return { label, [targetField]: o.val };
          })
        };

        return NextResponse.json({
          answer: [summary, '', ...lines, trailing].join('\n').trim(),
          context: `outliers:${outliers.length} field:${targetField} q1:${q1} q3:${q3} iqr:${iqr.toFixed(2)}`,
          sources: [],
          chartData
        });
      }

      // Structural detected but no path matched — fall through to RAG
    }

    // ── Standard RAG path ─────────────────────────────────────────────────
    const queryEmbedding = await createQueryEmbedding(message);
    const contextChunks = await searchSimilarChunks(queryEmbedding, fileId, 0.2, 8);
    const contextText = contextChunks.map(c => c.content).join('\n---\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a data analyst assistant. A user has uploaded a dataset. Your job is to read, understand, and reason ONLY from that dataset.

CORE RULES:
1. Treat the dataset as the ONLY source of truth.
2. Never use prior knowledge.
3. Never guess missing values.
4. Never fabricate records.
5. If information is not present, say exactly: "The dataset does not contain enough information to answer this question."

Before answering, silently:
1. Identify the relevant rows/records from the CONTEXT that relate to the question.
2. Extract the exact values from those rows.
3. Verify the answer is explicitly present in the CONTEXT — not inferred, not assumed.

Give the answer directly — just the value or name, nothing else.
- No intro phrases like "Based on the data", "The dataset shows", "Great question", etc.
- If numerical → return the exact number from the CONTEXT.
- If multiple matches → list them all.
- No markdown formatting (no **, no __, no ##, no backticks). Plain text only.
- Never include raw ID fields (movieid, id, userid, etc.).

CONTEXT (${contextChunks.length} chunks retrieved from the uploaded dataset):
${contextText || 'No context retrieved.'}
`
        },
        ...history.slice(-6) as { role: 'user' | 'assistant'; content: string }[],
        { role: 'user', content: message }
      ],
    });

    return NextResponse.json({
      answer: completion.choices[0].message.content,
      sources: contextChunks.map(c => c.content).filter(s => !s.startsWith('This dataset has'))
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Chat API Error:', message);
    return NextResponse.json({ error: 'Chat processing failed' }, { status: 500 });
  }
}
