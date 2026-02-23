import { NextResponse } from 'next/server';
import type OpenAI from 'openai';
import { openai, createQueryEmbedding } from '@/lib/openai';
import { searchSimilarChunks } from '@/lib/vector-store';
import { getCsvRows, getFileType } from '@/lib/csv-store';

// ── Shared types ────────────────────────────────────────────────────────────

export interface ChartData {
  type: 'bar' | 'line' | 'pie' | 'scatter';
  title: string;
  xKey: string;
  yKey: string;
  data: Array<Record<string, string | number>>;
}

// ── Dataset schema ──────────────────────────────────────────────────────────

interface DatasetSchema {
  allFields: string[];
  numericFields: string[];
  categoricalFields: string[];
  titleField: string | null;
  ranges: Record<string, { min: number; max: number }>;
  topValues: Record<string, string[]>;
}

const TITLE_CANDIDATES = new Set(['title', 'name', 'movie', 'film', 'song', 'book', 'product', 'item', 'show']);

function buildSchema(records: Record<string, string>[]): DatasetSchema {
  if (records.length === 0) {
    return { allFields: [], numericFields: [], categoricalFields: [], titleField: null, ranges: {}, topValues: {} };
  }

  const fieldSet = new Set<string>();
  for (const rec of records) for (const k of Object.keys(rec)) fieldSet.add(k);
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
      if (nums.length) ranges[field] = { min: Math.min(...nums), max: Math.max(...nums) };
    } else {
      const unique = new Set(vals.map(v => v.toLowerCase()));
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
  return { allFields, numericFields, categoricalFields, titleField, ranges, topValues };
}

// ── Record helpers ──────────────────────────────────────────────────────────

function findField(record: Record<string, string>, target: string): string | null {
  const t = target.toLowerCase().trim();
  if (record[t]) return t;
  for (const key of Object.keys(record)) {
    if (key.includes(t) || t.includes(key)) return key;
  }
  return null;
}

function formatRecord(rec: Record<string, string>): string {
  return Object.entries(rec)
    .map(([k, v]) => `${k.charAt(0).toUpperCase() + k.slice(1)}: ${v}`)
    .join(', ');
}

// ── Schema description for the system prompt ────────────────────────────────

function buildSchemaPrompt(schema: DatasetSchema, rowCount: number): string {
  const rangeStr = Object.entries(schema.ranges).slice(0, 8)
    .map(([f, r]) => `${f}: ${r.min}–${r.max}`).join(', ');
  const catSamples = schema.categoricalFields.slice(0, 4)
    .map(f => `${f}: [${(schema.topValues[f] ?? []).slice(0, 5).join(', ')}]`).join('; ');

  return [
    `Dataset: ${rowCount} rows, ${schema.allFields.length} columns.`,
    `All columns: ${schema.allFields.join(', ')}.`,
    schema.numericFields.length ? `Numeric columns: ${schema.numericFields.join(', ')}.` : '',
    schema.categoricalFields.length ? `Categorical columns: ${schema.categoricalFields.join(', ')}.` : '',
    schema.titleField ? `Title/name column: ${schema.titleField}.` : '',
    rangeStr ? `Value ranges: ${rangeStr}.` : '',
    catSamples ? `Sample category values — ${catSamples}.` : '',
  ].filter(Boolean).join('\n');
}

// ── Tool definitions ────────────────────────────────────────────────────────

function buildTools(schema: DatasetSchema): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const numOpts = schema.numericFields.join(', ') || 'none';
  const catOpts = schema.categoricalFields.join(', ') || 'none';

  return [
    {
      type: 'function',
      function: {
        name: 'top_n',
        description: `Get the top or bottom N records sorted by a numeric field, with an optional category filter. Available numeric fields: ${numOpts}.`,
        parameters: {
          type: 'object',
          properties: {
            field: { type: 'string', description: `Numeric field to sort by. Options: ${numOpts}` },
            n: { type: 'integer', description: 'Number of records to return (1–100)', minimum: 1, maximum: 100 },
            order: { type: 'string', enum: ['asc', 'desc'], description: 'desc = highest first, asc = lowest first' },
            filter_field: { type: 'string', description: `Optional: restrict to a category. Options: ${catOpts}` },
            filter_value: { type: 'string', description: 'Optional: the category value to match' },
          },
          required: ['field', 'n', 'order'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'aggregate',
        description: `Compute a single aggregate (count, sum, avg, min, max, count_distinct) over the dataset or a filtered subset. Available fields: ${schema.allFields.join(', ')}.`,
        parameters: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'],
              description: 'Aggregation type. Use "count" with field="rows" to count total records.',
            },
            field: { type: 'string', description: `Field to aggregate. Use "rows" for row count. Options: ${schema.allFields.join(', ')}` },
            filter_field: { type: 'string', description: `Optional: filter by this categorical field. Options: ${catOpts}` },
            filter_value: { type: 'string', description: 'Optional: value to match in filter_field' },
          },
          required: ['type', 'field'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'filter_records',
        description: `Filter and list records matching a numeric condition (e.g. rating > 8, age < 30). Available numeric fields: ${numOpts}.`,
        parameters: {
          type: 'object',
          properties: {
            field: { type: 'string', description: 'Numeric field to filter on' },
            op: { type: 'string', enum: ['<', '>', '=', '<=', '>='], description: 'Comparison operator' },
            value: { type: 'number', description: 'Threshold value' },
          },
          required: ['field', 'op', 'value'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'group_by',
        description: `Break down a metric by each category value (e.g. total sales by region, avg rating by genre). Available categorical fields: ${catOpts}. Available numeric fields: ${numOpts}.`,
        parameters: {
          type: 'object',
          properties: {
            group_field: { type: 'string', description: `Categorical field to group by. Options: ${catOpts}` },
            metric_field: { type: 'string', description: `Numeric field to aggregate per group. Options: ${numOpts}` },
            agg_type: {
              type: 'string',
              enum: ['sum', 'avg', 'max', 'min', 'count'],
              description: 'How to aggregate per group',
            },
          },
          required: ['group_field', 'agg_type'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'trend',
        description: `Compute a time-series trend: aggregate a metric bucketed by time period. Use for "over time", "by year", "monthly trend" questions.`,
        parameters: {
          type: 'object',
          properties: {
            time_field: { type: 'string', description: 'The time/year/date column' },
            metric_field: { type: 'string', description: 'The numeric column to aggregate' },
            period: { type: 'string', enum: ['year', 'month', 'decade'], description: 'Bucketing granularity' },
            agg_type: {
              type: 'string',
              enum: ['avg', 'sum'],
              description: 'Use avg for ratings/scores, sum for revenue/counts',
            },
          },
          required: ['time_field', 'metric_field', 'period', 'agg_type'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_values',
        description: `List all distinct values for a column. Use for "what are all genres", "list all countries", etc. Available fields: ${schema.allFields.join(', ')}.`,
        parameters: {
          type: 'object',
          properties: {
            field: { type: 'string', description: 'Column whose distinct values to list' },
          },
          required: ['field'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'outliers',
        description: `Detect statistical outliers in a numeric field using the IQR method. Available numeric fields: ${numOpts}.`,
        parameters: {
          type: 'object',
          properties: {
            field: { type: 'string', description: `Numeric column to analyze. Options: ${numOpts}` },
          },
          required: ['field'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'lookup_record',
        description: `Find and display records that match a name, title, or keyword. Use for "tell me about X", "find X", "show me X" questions.`,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Name, title, or keyword to search for' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'dataset_info',
        description: 'Describe the dataset: all column names, their types, row count, and value ranges.',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];
}

// ── Tool executors ──────────────────────────────────────────────────────────

type Args = Record<string, unknown>;
type ToolResult = { answer: string; context?: string; chartData?: ChartData };

function execTopN(args: Args, records: Record<string, string>[], schema: DatasetSchema): ToolResult {
  const field = String(args.field);
  const n = Math.min(Number(args.n) || 10, 100);
  const order = String(args.order) as 'asc' | 'desc';
  const filterField = args.filter_field ? String(args.filter_field) : null;
  const filterValue = args.filter_value ? String(args.filter_value) : null;

  let rows = records.filter(rec => {
    const k = findField(rec, field);
    return k !== null && !isNaN(parseFloat(rec[k]));
  });

  if (filterField && filterValue) {
    const filtered = rows.filter(rec => {
      const k = findField(rec, filterField);
      return k !== null && rec[k].trim().toLowerCase() === filterValue.toLowerCase();
    });
    if (filtered.length > 0) rows = filtered;
  }

  if (rows.length === 0) {
    return { answer: `No records with a numeric "${field}" field found.` };
  }

  rows.sort((a, b) => {
    const ak = findField(a, field)!;
    const bk = findField(b, field)!;
    return order === 'desc'
      ? parseFloat(b[bk]) - parseFloat(a[ak])
      : parseFloat(a[ak]) - parseFloat(b[bk]);
  });

  const topRows = rows.slice(0, n);
  const titleKey = schema.titleField ?? 'title';
  const filterNote = filterField && filterValue ? ` (${filterField}: ${filterValue})` : '';

  const lines = topRows.map((rec, i) => {
    const sortK = findField(rec, field)!;
    const sortVal = rec[sortK];
    const title = rec[titleKey] ?? rec['title'] ?? rec['name'] ?? null;
    const label = title
      ? `${i + 1}. ${title} (${field}: ${sortVal})`
      : `${i + 1}. ${field}: ${sortVal}`;
    const rest = Object.entries(rec)
      .filter(([k]) => k !== titleKey && k !== 'title' && k !== 'name')
      .map(([k, v]) => `${k.charAt(0).toUpperCase() + k.slice(1)}: ${v}`)
      .join(' | ');
    return `${label}\n   ${rest}`;
  });

  const chartData: ChartData = {
    type: 'bar',
    title: `Top ${n}${filterNote} by ${field}`,
    xKey: 'label',
    yKey: field,
    data: topRows.map(rec => {
      const tk = schema.titleField ?? 'title';
      const name = rec[tk] ?? rec['title'] ?? rec['name'] ?? 'Record';
      const sk = findField(rec, field)!;
      const val = parseFloat(rec[sk]);
      const lbl = name.length > 14 ? name.slice(0, 14) + '…' : name;
      return { label: lbl, [field]: isNaN(val) ? 0 : val };
    }),
  };

  return {
    answer: lines.join('\n\n'),
    context: `topN:${n} field:${field} order:${order} filter:${filterField}=${filterValue} total:${rows.length}`,
    chartData,
  };
}

function execAggregate(args: Args, records: Record<string, string>[]): ToolResult {
  const type = String(args.type);
  const field = String(args.field);
  const filterField = args.filter_field ? String(args.filter_field) : null;
  const filterValue = args.filter_value ? String(args.filter_value) : null;

  let rows = records;
  if (filterField && filterValue) {
    rows = records.filter(rec => {
      const k = findField(rec, filterField);
      return k !== null && rec[k].trim().toLowerCase() === filterValue.toLowerCase();
    });
  }

  if (type === 'count') {
    return { answer: `${rows.length}`, context: `stat:count total:${rows.length}` };
  }

  if (type === 'count_distinct') {
    const seen = new Set<string>();
    for (const rec of rows) {
      const k = findField(rec, field);
      if (k && rec[k]) seen.add(rec[k].trim());
    }
    const vals = Array.from(seen);
    return {
      answer: `${vals.length}`,
      context: `stat:countDistinct field:${field} n:${vals.length} total:${rows.length} values:${vals.slice(0, 30).join(',')}`,
    };
  }

  const values: number[] = [];
  for (const rec of rows) {
    const k = findField(rec, field);
    if (k) {
      const num = parseFloat(rec[k]);
      if (!isNaN(num)) values.push(num);
    }
  }

  if (values.length === 0) {
    return { answer: `No numeric values found for "${field}".` };
  }

  let answer = '';
  if (type === 'sum') answer = values.reduce((a, b) => a + b, 0).toLocaleString();
  else if (type === 'avg') answer = (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2);
  else if (type === 'min') answer = `${Math.min(...values)}`;
  else if (type === 'max') answer = `${Math.max(...values)}`;

  return {
    answer,
    context: `stat:${type} field:${field} n:${values.length} filter:${filterField}=${filterValue}`,
  };
}

function execFilterRecords(args: Args, records: Record<string, string>[]): ToolResult {
  const field = String(args.field);
  const op = String(args.op);
  const value = Number(args.value);

  const matched = records.filter(rec => {
    const k = findField(rec, field);
    if (!k) return false;
    const num = parseFloat(rec[k]);
    if (isNaN(num)) return false;
    if (op === '<') return num < value;
    if (op === '>') return num > value;
    if (op === '=') return num === value;
    if (op === '<=') return num <= value;
    if (op === '>=') return num >= value;
    return false;
  });

  if (matched.length === 0) {
    return { answer: `No records found where ${field} ${op} ${value}.` };
  }

  const opLabel: Record<string, string> = { '<': 'under', '>': 'over', '=': 'equal to', '<=': '≤', '>=': '≥' };
  const lines = matched.slice(0, 15).map((rec, i) => `${i + 1}. ${formatRecord(rec)}`);
  const trailing = matched.length > 15 ? `\n…and ${matched.length - 15} more.` : '';

  return {
    answer: `Found ${matched.length} record(s) where ${field} is ${opLabel[op] ?? op} ${value}:\n\n${lines.join('\n')}${trailing}`,
  };
}

function execGroupBy(args: Args, records: Record<string, string>[], schema: DatasetSchema): ToolResult {
  const groupField = String(args.group_field);
  const metricField = args.metric_field ? String(args.metric_field) : '';
  const aggType = String(args.agg_type) as 'sum' | 'avg' | 'max' | 'min' | 'count';

  const groups: Record<string, number[]> = {};
  for (const rec of records) {
    const gk = findField(rec, groupField);
    if (!gk) continue;
    const gval = rec[gk]?.trim();
    if (!gval) continue;

    if (aggType === 'count') {
      groups[gval] = groups[gval] ?? [];
      groups[gval].push(1);
    } else {
      const mk = findField(rec, metricField);
      if (!mk) continue;
      const num = parseFloat(rec[mk]);
      if (!isNaN(num)) {
        groups[gval] = groups[gval] ?? [];
        groups[gval].push(num);
      }
    }
  }

  if (Object.keys(groups).length === 0) {
    return { answer: `No data found for group field "${groupField}".` };
  }

  const results = Object.entries(groups).map(([group, vals]) => {
    let score: number;
    if (aggType === 'sum') score = vals.reduce((a, b) => a + b, 0);
    else if (aggType === 'avg') score = vals.reduce((a, b) => a + b, 0) / vals.length;
    else if (aggType === 'max') score = Math.max(...vals);
    else if (aggType === 'min') score = Math.min(...vals);
    else score = vals.length;
    return { group, score };
  }).sort((a, b) => b.score - a.score);

  const lines = results.map((r, i) =>
    `${i + 1}. ${r.group}: ${Number.isInteger(r.score) ? r.score.toLocaleString() : r.score.toFixed(2)}`
  );

  const chartData: ChartData = {
    type: results.length <= 8 ? 'pie' : 'bar',
    title: `${aggType} ${metricField || 'count'} by ${groupField}`,
    xKey: 'group',
    yKey: 'value',
    data: results.slice(0, 10).map(r => ({
      group: r.group.length > 14 ? r.group.slice(0, 14) + '…' : r.group,
      value: parseFloat(r.score.toFixed(2)),
    })),
  };

  return {
    answer: lines.join('\n'),
    context: `groupBy:${aggType} metric:${metricField} group:${groupField} groups:${results.length}`,
    chartData,
  };
}

function execTrend(args: Args, records: Record<string, string>[], _schema?: DatasetSchema): ToolResult {
  const timeField = String(args.time_field);
  const metricField = String(args.metric_field);
  const period = String(args.period) as 'year' | 'month' | 'decade';
  const aggType = String(args.agg_type) as 'avg' | 'sum';

  const buckets: Record<string, number[]> = {};
  for (const rec of records) {
    const tk = findField(rec, timeField);
    const mk = findField(rec, metricField);
    if (!tk || !mk) continue;
    const rawTime = parseFloat(rec[tk]);
    const metricNum = parseFloat(rec[mk]);
    if (isNaN(rawTime) || isNaN(metricNum)) continue;

    const bucket = period === 'decade'
      ? `${Math.floor(rawTime / 10) * 10}s`
      : period === 'month'
      ? rec[tk].trim().slice(0, 7)
      : `${Math.floor(rawTime)}`;

    buckets[bucket] = buckets[bucket] ?? [];
    buckets[bucket].push(metricNum);
  }

  const trendData = Object.entries(buckets)
    .map(([p, vals]) => ({
      period: p,
      value: parseFloat((
        aggType === 'sum'
          ? vals.reduce((a, b) => a + b, 0)
          : vals.reduce((a, b) => a + b, 0) / vals.length
      ).toFixed(2)),
      count: vals.length,
    }))
    .sort((a, b) => a.period.localeCompare(b.period));

  if (trendData.length === 0) {
    return { answer: 'No trend data found for the specified fields.' };
  }

  const best = [...trendData].sort((a, b) => b.value - a.value)[0];
  const first = trendData[0];
  const last = trendData[trendData.length - 1];
  const delta = last.value - first.value;
  const direction = delta > 0.05 ? 'increased' : delta < -0.05 ? 'decreased' : 'stayed relatively stable';
  const aggLabel = aggType === 'sum' ? 'total' : 'avg';

  const summary = aggType === 'sum'
    ? `${best.period} had the highest total ${metricField} at ${best.value.toLocaleString()} (${best.count} records).`
    : `${metricField} ${direction} from ${first.value} (${first.period}) to ${last.value} (${last.period}).`;

  const lines = trendData.map(d =>
    `${d.period}: ${d.value.toLocaleString()} ${aggLabel} (${d.count} records)${d.period === best.period ? ' ← highest' : ''}`
  );

  const chartData: ChartData = {
    type: 'line',
    title: `${aggType === 'sum' ? 'Total' : 'Avg'} ${metricField} by ${period}`,
    xKey: 'period',
    yKey: metricField,
    data: trendData.map(d => ({ period: d.period, [metricField]: d.value })),
  };

  return {
    answer: [summary, '', ...lines].join('\n'),
    context: `trend:${period} metric:${metricField} time:${timeField} points:${trendData.length}`,
    chartData,
  };
}

function execListValues(args: Args, records: Record<string, string>[]): ToolResult {
  const field = String(args.field);
  const seen = new Set<string>();
  for (const rec of records) {
    const k = findField(rec, field);
    if (k && rec[k]?.trim()) seen.add(rec[k].trim());
  }
  const values = Array.from(seen).sort();
  if (values.length === 0) return { answer: `No values found for "${field}".` };
  const lines = values.map((v, i) => `${i + 1}. ${v}`).join('\n');
  return {
    answer: `${values.length} unique ${field} values:\n\n${lines}`,
    context: `listAll field:${field} count:${values.length}`,
  };
}

function execOutliers(args: Args, records: Record<string, string>[], schema: DatasetSchema): ToolResult {
  const field = String(args.field);
  const recVals: { rec: Record<string, string>; val: number }[] = [];
  for (const rec of records) {
    const k = findField(rec, field);
    if (k) {
      const num = parseFloat(rec[k]);
      if (!isNaN(num)) recVals.push({ rec, val: num });
    }
  }

  if (recVals.length < 4) {
    return { answer: 'Not enough data to detect outliers (need at least 4 records).' };
  }

  const sorted = recVals.map(r => r.val).sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;

  const outliers = recVals.filter(({ val }) => val < lo || val > hi);
  if (outliers.length === 0) {
    return {
      answer: `No outliers in "${field}". All ${recVals.length} records fall within ${lo.toFixed(2)}–${hi.toFixed(2)} (IQR method).`,
    };
  }

  const titleKey = schema.titleField ?? 'title';
  const lines = outliers.slice(0, 15).map((o, i) => {
    const title = o.rec[titleKey] ?? o.rec['title'] ?? o.rec['name'] ?? null;
    return title
      ? `${i + 1}. ${title} (${field}: ${o.val})`
      : `${i + 1}. ${field}: ${o.val}`;
  });
  const trailing = outliers.length > 15 ? `\n…and ${outliers.length - 15} more.` : '';

  const chartData: ChartData = {
    type: 'bar',
    title: `Outliers by ${field}`,
    xKey: 'label',
    yKey: field,
    data: outliers.slice(0, 15).map(o => {
      const title = o.rec[titleKey] ?? o.rec['title'] ?? o.rec['name'] ?? `val ${o.val}`;
      return { label: title.length > 14 ? title.slice(0, 14) + '…' : title, [field]: o.val };
    }),
  };

  return {
    answer: [
      `Found ${outliers.length} outlier(s) in "${field}". Normal range: ${lo.toFixed(2)}–${hi.toFixed(2)} (IQR method, ${recVals.length} records).`,
      '',
      ...lines,
      trailing,
    ].join('\n').trim(),
    context: `outliers:${outliers.length} field:${field} q1:${q1} q3:${q3} iqr:${iqr.toFixed(2)}`,
    chartData,
  };
}

function execLookupRecord(args: Args, records: Record<string, string>[], schema: DatasetSchema): ToolResult {
  const query = String(args.query).toLowerCase().trim();
  const searchFields = schema.titleField
    ? [schema.titleField, ...schema.categoricalFields]
    : schema.allFields;

  const matched = records.filter(rec => {
    for (const f of searchFields) {
      const k = findField(rec, f);
      if (k && rec[k].toLowerCase().includes(query)) return true;
    }
    return false;
  });

  if (matched.length === 0) {
    return { answer: `No records matching "${query}" found.` };
  }

  const lines = matched.slice(0, 5).map((rec, i) => `${i + 1}. ${formatRecord(rec)}`);
  const trailing = matched.length > 5 ? `\n…and ${matched.length - 5} more.` : '';
  return { answer: lines.join('\n\n') + trailing };
}

function execDatasetInfo(records: Record<string, string>[], schema: DatasetSchema): ToolResult {
  const parts = [
    `${records.length} records, ${schema.allFields.length} columns.`,
    '',
    `Columns: ${schema.allFields.join(', ')}.`,
  ];
  if (schema.numericFields.length) parts.push(`\nNumeric: ${schema.numericFields.join(', ')}.`);
  if (schema.categoricalFields.length) parts.push(`Categorical: ${schema.categoricalFields.join(', ')}.`);
  const rangeStr = Object.entries(schema.ranges).map(([f, r]) => `${f}: ${r.min}–${r.max}`).join(', ');
  if (rangeStr) parts.push(`\nRanges: ${rangeStr}.`);

  return {
    answer: parts.join('\n'),
    context: `schema:${schema.allFields.join(',')} rows:${records.length}`,
  };
}

function executeTool(
  name: string,
  args: Args,
  records: Record<string, string>[],
  schema: DatasetSchema
): ToolResult {
  switch (name) {
    case 'top_n':         return execTopN(args, records, schema);
    case 'aggregate':     return execAggregate(args, records);
    case 'filter_records': return execFilterRecords(args, records);
    case 'group_by':      return execGroupBy(args, records, schema);
    case 'trend':         return execTrend(args, records);
    case 'list_values':   return execListValues(args, records);
    case 'outliers':      return execOutliers(args, records, schema);
    case 'lookup_record': return execLookupRecord(args, records, schema);
    case 'dataset_info':  return execDatasetInfo(records, schema);
    default:              return { answer: `Unknown tool: ${name}.` };
  }
}

// ── SSE streaming helper ─────────────────────────────────────────────────────

function sseStream(
  run: (emit: (chunk: string) => void) => Promise<{ chartData?: ChartData; context?: string; sources?: string[] }>
): Response {
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        const meta = await run((chunk) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk })}\n\n`));
        });
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, ...meta })}\n\n`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// ── POST handler ────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  try {
    const { message, fileId, history = [] } = await req.json();

    if (!message || !fileId) {
      return NextResponse.json({ error: 'Message and fileId are required' }, { status: 400 });
    }

    const fileType = await getFileType(fileId);

    // ── PDF path: RAG + GPT (streaming) ─────────────────────────────────────
    if (fileType === 'pdf') {
      const queryEmbedding = await createQueryEmbedding(message);
      const contextChunks = await searchSimilarChunks(queryEmbedding, fileId, 0.15, 12);
      const contextText = contextChunks.map(c => {
        const pageRef = c.page_number ? ` [p. ${c.page_number}]` : '';
        return `${c.content}${pageRef}`;
      }).join('\n---\n');

      return sseStream(async (emit) => {
        const stream = await openai.chat.completions.create({
          model: 'gpt-4o',
          temperature: 0,
          stream: true,
          messages: [
            {
              role: 'system',
              content: `You are InsightVault, an expert document analyst. Answer questions using ONLY the provided document excerpts below.

Guidelines:
- Give a thorough answer using specific details, figures, quotes, and examples from the context.
- Use **bold** to highlight key terms, names, numbers, or findings.
- Use bullet points (- item) for multi-part answers or lists; use short paragraphs for single-topic answers.
- If the answer has multiple distinct parts, use headers (### Section) to organize them.
- If the context is insufficient, state what IS available and what is missing — never guess.
- No intro phrases. Start with the direct answer.
- Never fabricate information not present in the excerpts.
- Cite the page number using [p. N] format when referencing specific information.

DOCUMENT EXCERPTS — ${contextChunks.length} relevant sections from the uploaded file:
${contextText || 'No relevant context found.'}`,
            },
            ...(history.slice(-6) as { role: 'user' | 'assistant'; content: string }[]),
            { role: 'user', content: message },
          ],
        });

        const sources = contextChunks.map(c => c.content);
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content ?? '';
          if (delta) emit(delta);
        }
        return { sources };
      });
    }

    // ── CSV path: load rows → tool calling ──────────────────────────────────
    const records = await getCsvRows(fileId);
    const schema = buildSchema(records);
    const tools = buildTools(schema);
    const schemaCtx = buildSchemaPrompt(schema, records.length);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `You are InsightVault, an expert data analyst. The user uploaded a CSV dataset. Call the most appropriate tool to retrieve data, then a synthesis pass will turn the results into a clear, insightful response.

${schemaCtx}

Tool selection guide:
- Ranking / "top N" / "best" / "worst" → top_n
- Single stat: count, total, average, min, max, distinct count → aggregate
- "per category", "by genre", "by region", breakdown → group_by
- Time series, "over years", "by decade", monthly trend → trend
- Numeric threshold filter ("rating > 8", "age < 30") → filter_records
- "list all X", "what values does X have" → list_values
- Anomalies, statistical outliers → outliers
- "tell me about X", "find X", "show me X" → lookup_record
- "what columns", "describe dataset", "what fields" → dataset_info
- Conversational follow-ups with no new data need → answer directly without calling a tool

Rules:
- No intro phrases. Start with the finding.
- Plain text only, no markdown.
- Never fabricate numbers not in tool results.`,
        },
        ...(history.slice(-8) as { role: 'user' | 'assistant'; content: string }[]),
        { role: 'user', content: message },
      ],
      tools,
      tool_choice: 'auto',
    });

    const choice = response.choices[0];

    // Conversational answer — LLM responded without calling a tool (streaming)
    if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls?.length) {
      return sseStream(async (emit) => {
        const stream = await openai.chat.completions.create({
          model: 'gpt-4o',
          temperature: 0,
          stream: true,
          messages: [
            {
              role: 'system',
              content: `You are InsightVault, an expert data analyst. Answer the user's question about their CSV dataset conversationally and analytically.

${schemaCtx}

Rules:
- No intro phrases. Start directly with the answer.
- Use **bold** to highlight key numbers or findings.
- Use bullet points for multi-part answers.
- Never fabricate numbers not in the dataset schema.`,
            },
            ...(history.slice(-8) as { role: 'user' | 'assistant'; content: string }[]),
            { role: 'user', content: message },
          ],
        });
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content ?? '';
          if (delta) emit(delta);
        }
        return { sources: [] };
      });
    }

    // Execute ALL requested tool calls
    const toolCalls = choice.message.tool_calls;
    const toolResults: ToolResult[] = toolCalls.map(tc => {
      const args = JSON.parse(tc.function.arguments) as Args;
      return executeTool(tc.function.name, args, records, schema);
    });

    // Build tool-role messages for the synthesis pass
    const toolMessages: OpenAI.Chat.Completions.ChatCompletionToolMessageParam[] = toolCalls.map((tc, i) => ({
      role: 'tool',
      tool_call_id: tc.id,
      content: toolResults[i].context
        ? `${toolResults[i].answer}\n[meta: ${toolResults[i].context}]`
        : toolResults[i].answer,
    }));

    const firstResult = toolResults[0];

    // Synthesis pass (streaming)
    return sseStream(async (emit) => {
      const stream = await openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0.4,
        stream: true,
        messages: [
          {
            role: 'system',
            content: `You are InsightVault, an expert data analyst. Tool results have been retrieved. Synthesize them into a clear, insightful, well-formatted response.

Dataset context (use to compare results):
${schemaCtx}

Guidelines:
- Lead with the single most important finding in bold (**like this**).
- Put results in context: compare against dataset ranges, averages, or totals where relevant.
- For lists of items use bullet points (- item). For a single stat, use a short paragraph.
- Note patterns, contrasts, or surprising observations — go beyond restating raw numbers.
- Use **bold** to highlight key numbers, names, or findings.
- If a chart is displayed, reference it briefly (e.g. "the chart shows the full breakdown").
- No intro phrases like "Sure!" or "Great question!". Be direct and analytical.
- Never invent data not present in the tool results.
- Format markdown: **bold**, *italic*, bullet lists (- item), numbered lists (1. item).`,
          },
          ...(history.slice(-8) as { role: 'user' | 'assistant'; content: string }[]),
          { role: 'user', content: message },
          choice.message,
          ...toolMessages,
        ],
      });
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? '';
        if (delta) emit(delta);
      }
      return { context: firstResult.context, chartData: firstResult.chartData, sources: [] };
    });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('Chat API Error:', msg);
    return NextResponse.json({ error: 'Chat processing failed' }, { status: 500 });
  }
}
