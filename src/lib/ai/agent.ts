import { getOpenAI } from '@/lib/openai';
import { classifyQuery, extractEmailTarget } from './classifier';
import { processContext } from './processor';
import { retrieveDocuments } from './retrieval';
import type {
  DeliveryOptions,
  ProcessedContext,
  QueryClassification,
  QueryRequest,
  RetrievalResult,
} from './types';

function isStrictEvidenceRequest(message: string): boolean {
  return /using only|use only|only information|explicitly stated|missing or unsupported|unsupported/i.test(message);
}

function isResumeLikePrompt(message: string, retrieval: RetrievalResult): boolean {
  return retrieval.fileType === 'pdf' && /cv|resume|curriculum vitae|hiring manager|role fit|qualifications/i.test(message);
}

function getResumeOutputMode(message: string): 'summary' | 'analysis' | 'strict' | 'delivery' {
  if (isStrictEvidenceRequest(message)) return 'strict';
  if (/send|share|slack|email|mail/i.test(message)) return 'delivery';
  if (/strengths|standout projects|role fit|fit for|hiring manager|qualifications/i.test(message)) return 'analysis';
  return 'summary';
}

function buildSystemPrompt(
  classification: QueryClassification,
  processed: ProcessedContext,
  retrieval: RetrievalResult,
  message: string
): string {
  const strictEvidence = isStrictEvidenceRequest(message);
  const resumeLike = isResumeLikePrompt(message, retrieval);
  const resumeMode = resumeLike ? getResumeOutputMode(message) : null;

  const baseRules = [
    `You are InsightVault Lite's production AI analyst.`,
    `Intent: ${classification.intent}.`,
    `Retrieval mode: ${classification.retrievalMode}.`,
    `File type: ${retrieval.fileType}.`,
    `Warnings: ${processed.warnings.join(' | ') || 'none'}.`,
    `Answer only with claims supported by the retrieved context.`,
    `If the evidence is weak or missing, say so clearly and propose a better next step.`,
    `Use concise markdown with short sections where helpful.`,
  ];

  const csvRules = retrieval.fileType === 'csv'
    ? [
        'For CSV answers, calculate directly from the retrieved rows when the question asks for totals, averages, rankings, sums, or date comparisons.',
        'Do not use LaTeX, math delimiters, escaped brackets, or equation notation such as \[ ... \], $$...$$, or \frac. Write calculations in plain text.',
        'When showing a calculation, use a simple format like: Average price = (55000 + 20000 + 2500 + 12000) / 4 = 22875.',
        'Avoid hedging with phrases like "the retrieved context does not provide sufficient data" when the rows shown are enough to compute the answer.',
      ]
    : [];

  const pdfRules = retrieval.fileType === 'pdf'
    ? [
        'For PDF answers, cite concrete evidence from the retrieved excerpts such as project names, roles, tools, technologies, and experience details.',
        'Do not repeat the same point across multiple sections unless it adds new evidence or a different interpretation.',
        resumeLike ? 'For CV or resume-style documents, prefer recruiter-ready language over generic praise.' : null,
        resumeLike ? 'Anchor each section to explicit evidence like named projects, work experience, technologies, education, and certifications.' : null,
        resumeLike ? 'Differentiate clearly between Summary, Strengths, Standout Projects, and Role Fit instead of restating the same content in each section.' : null,
        resumeLike ? 'Avoid broad statements like "strong candidate" unless they are immediately justified with document-backed evidence.' : null,
        resumeLike && resumeMode === 'summary' ? 'For resume summaries, use these exact sections when supported: Summary, Strongest Qualifications, Most Important Takeaway.' : null,
        resumeLike && resumeMode === 'analysis' ? 'For resume analysis, use these exact sections when supported: Strengths, Standout Projects, Role Fit.' : null,
        resumeLike && resumeMode === 'strict' ? 'For strict-evidence resume requests, use these exact sections: Supported Qualifications, Supported Projects, Missing or Unsupported Information.' : null,
        resumeLike && resumeMode === 'delivery' ? 'For resume delivery requests, write a polished hiring-manager-ready summary grounded in the document.' : null,
        strictEvidence ? 'When the user asks for only supported information, do not infer achievements, impact, seniority, or team dynamics unless the document explicitly states them.' : null,
        strictEvidence ? 'If an important detail is missing, say "Not stated in the document" or list it under "Missing or Unsupported Information" in a tight, factual way.' : null,
      ].filter(Boolean)
    : [];

  const intentRules =
    classification.intent === 'summary'
      ? ['Lead with a concise summary.', 'Then list the most important supporting points.']
      : classification.intent === 'comparison'
        ? [
            'Structure the answer using these exact sections when the data supports them: Highest Record, Lowest Record, Key Difference, Business Takeaway.',
            'Be explicit about the metric being compared and why the difference matters.',
            'Use a compact markdown table if it improves clarity.',
            'If chart data is available, align your explanation to the same comparison shown in the chart.',
          ]
        : classification.intent === 'action'
          ? [
              'Generate only the final content to be delivered.',
              'Assume delivery is handled by a separate tool after your response is created.',
              'Never say you cannot send, email, post, copy, paste, or manually share the result.',
              'Never discuss tool limitations or delivery limitations in the body.',
              'Start directly with the deliverable content.',
            ]
          : [
              'Highlight findings, trends, risks, and practical implications.',
              resumeLike ? 'For resume-style analysis, focus on evidence-backed qualifications, project relevance, and realistic role alignment.' : null,
              resumeLike ? 'Do not restate the same project or skill in multiple sections unless the new section adds different evidence.' : null,
              'Do not add a Recommended Follow-Up Questions section unless the user explicitly asks for follow-up questions.',
            ].filter(Boolean);

  return [...baseRules, ...csvRules, ...pdfRules, ...intentRules].join('\n');
}


function normalizeBlock(block: string): string {
  return block
    .toLowerCase()
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^>\s*/gm, '')
    .replace(/^[-*]\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMathFormatting(text: string): string {
  return text
    .replace(/\\\[|\\\]/g, '')
    .replace(/\$\$([\s\S]*?)\$\$/g, '$1')
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '($1) / ($2)')
    .replace(/\\text\{([^{}]+)\}/g, '$1')
    .replace(/\\,/g, ',')
    .replace(/\n{3,}/g, '\n\n');
}

export function normalizeGeneratedResponse(text: string): string {
  const withoutFollowUps = text.replace(/\n*#{0,6}\s*Recommended Follow-?up Questions[\s\S]*$/i, '').trim();
  const normalizedNewlines = normalizeMathFormatting(withoutFollowUps).replace(/\r\n/g, '\n').trim();
  if (!normalizedNewlines) return '';

  const blocks = normalizedNewlines
    .replace(/\n{3,}/g, '\n\n')
    .split(/\n\n+/)
    .map(block => block.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const dedupedBlocks: string[] = [];

  for (const block of blocks) {
    const key = normalizeBlock(block);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    dedupedBlocks.push(block);
  }

  return dedupedBlocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function buildUserPrompt(message: string, classification: QueryClassification, processed: ProcessedContext, retrieval: RetrievalResult): string {
  const contextBlock = processed.contextText
    ? `Retrieved context:\n${processed.contextText}`
    : 'No grounded context was retrieved.';

  if (classification.intent !== 'action') {
    const extraDirectives = retrieval.fileType === 'pdf'
      ? [
          isResumeLikePrompt(message, retrieval)
            ? 'Focus on evidence from the CV itself, such as named projects, technologies, roles, work experience, education, and certifications.'
            : null,
          isResumeLikePrompt(message, retrieval)
            ? 'Prefer short, concrete bullets over long generic paragraphs when listing strengths or qualifications.'
            : null,
          isResumeLikePrompt(message, retrieval)
            ? 'If you mention role fit, tie it directly to specific evidence from the document instead of generic praise.'
            : null,
          isStrictEvidenceRequest(message)
            ? 'Do not infer anything beyond what is explicitly supported by the retrieved text.'
            : null,
          isStrictEvidenceRequest(message)
            ? 'If information is missing, include a short section called Missing or Unsupported Information.'
            : null,
        ].filter(Boolean).join('\n')
      : '';

    return [contextBlock, extraDirectives, `User request:\n${message}`].filter(Boolean).join('\n\n');
  }

  const destination = classification.requestedAction === 'email' ? 'email' : 'Slack message';

  return [
    contextBlock,
    '',
    `Original user request: ${message}`,
    '',
    `Task: Create the final ${destination}-ready content that should be sent.`,
    'Do not mention sending limitations, manual workarounds, or copying/pasting.',
    'If evidence is weak, state that within the summary itself, but still produce the deliverable content.',
  ].join('\n');
}

export function sanitizeActionResponse(text: string): string {
  let cleaned = text.trim();

  const badLeadPatterns = [
    /^the retrieved context does not[^\n]*\n+/i,
    /^i(?:'m| am) unable to send[^\n]*\n+/i,
    /^however, you can[^\n]*\n+/i,
    /^feel free to copy and paste[^\n]*$/i,
  ];

  for (const pattern of badLeadPatterns) {
    cleaned = cleaned.replace(pattern, '').trim();
  }

  cleaned = cleaned
    .replace(/However, you can use the summary below and manually (?:send|post) it[^\n]*\n*/gi, '')
    .replace(/Feel free to copy and paste this text into your (?:email|Slack)(?: client| message)? to share it\.?/gi, '')
    .replace(/The retrieved context does not provide direct support for sending (?:emails|messages)(?: via Slack)?\.?/gi, '')
    .trim();

  return cleaned;
}

function toSlackMrkdwn(text: string): string {
  return text
    .replace(/^#{1,6}\s*(.+)$/gm, '*$1*')
    .replace(/^[-*]\s+/gm, '• ')
    .replace(/^›\s*$/gm, '•')
    .replace(/^›\s+/gm, '• ')
    .replace(/\*\*(.*?)\*\*/g, '*$1*')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatSlackMessage(message: string, responseText: string): string {
  const title = /summary/i.test(message) ? '*InsightVault Summary*' : '*InsightVault Update*';
  return [
    title,
    '',
    toSlackMrkdwn(responseText.trim()),
    '',
    '_Sent via InsightVault_',
  ].join('\n');
}

function stripMarkdownForEmail(text: string): string {
  return text
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^>\s?/gm, '')
    .trim();
}

function formatEmailSubject(message: string, responseText: string): string {
  const firstLine = stripMarkdownForEmail(responseText).split(/\r?\n/).find(line => line.trim().length > 0);
  if (firstLine && firstLine.length <= 90) {
    return firstLine;
  }
  if (/summary/i.test(message)) return 'InsightVault Summary';
  if (/analysis/i.test(message)) return 'InsightVault Analysis';
  if (/compare|comparison/i.test(message)) return 'InsightVault Comparison';
  return 'InsightVault Report';
}

function formatEmailBody(responseText: string): string {
  const body = stripMarkdownForEmail(responseText);
  return [
    'InsightVault Report',
    '',
    body,
    '',
    'Sent via InsightVault',
  ].join('\n');
}

export async function generateResponse(params: {
  message: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  classification: QueryClassification;
  processed: ProcessedContext;
  retrieval: RetrievalResult;
}) {
  const { message, history, classification, processed, retrieval } = params;
  const openai = getOpenAI();

  return openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: classification.intent === 'summary' ? 0.2 : classification.intent === 'action' ? 0.15 : 0.35,
    stream: true,
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt(classification, processed, retrieval, message),
      },
      ...(classification.intent === 'action' ? [] : history.slice(-6)),
      {
        role: 'user',
        content: buildUserPrompt(message, classification, processed, retrieval),
      },
    ],
  });
}

export async function sendToSlack(webhookUrl: string, message: string): Promise<{ ok: boolean; detail: string }> {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Slack webhook failed (${response.status}): ${detail || 'unknown error'}`);
  }

  return { ok: true, detail: 'Insight sent to Slack.' };
}

export async function sendEmail(params: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  text: string;
}): Promise<{ ok: boolean; detail: string }> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: params.from,
      to: [params.to],
      subject: params.subject,
      text: params.text,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Resend email failed (${response.status}): ${detail || 'unknown error'}`);
  }

  return { ok: true, detail: `Insight emailed to ${params.to}.` };
}

export async function runAgentWorkflow(request: QueryRequest): Promise<{
  classification: QueryClassification;
  retrieval: RetrievalResult;
  processed: ProcessedContext;
}> {
  const message = request.message.trim();
  if (!message) {
    throw new Error('Please enter a question before sending.');
  }

  const classification = await classifyQuery(message, request.history ?? []);
  const retrieval = await retrieveDocuments({
    fileId: request.fileId,
    query: message,
    classification,
    filters: request.filters,
  });
  const processed = processContext({ classification, retrieval });

  return { classification, retrieval, processed };
}

export async function maybeExecuteExternalAction(params: {
  classification: QueryClassification;
  message: string;
  responseText: string;
  delivery?: DeliveryOptions;
}): Promise<string | null> {
  const { classification, message, responseText, delivery } = params;

  if (classification.intent !== 'action' || !classification.requestedAction) {
    return null;
  }

  if (classification.requestedAction === 'slack') {
    const webhookUrl = delivery?.slackWebhookUrl || process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) {
      return 'Slack delivery was requested, but `SLACK_WEBHOOK_URL` is not configured.';
    }
    const result = await sendToSlack(webhookUrl, formatSlackMessage(message, responseText));
    return result.detail;
  }

  const to = delivery?.email || extractEmailTarget(message);
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;

  if (!to) {
    return 'Email delivery was requested, but no recipient address was provided.';
  }
  if (!apiKey || !from) {
    return 'Email delivery was requested, but `RESEND_API_KEY` or `RESEND_FROM_EMAIL` is missing.';
  }

  const result = await sendEmail({
    apiKey,
    from,
    to,
    subject: formatEmailSubject(message, responseText),
    text: formatEmailBody(responseText),
  });
  return result.detail;
}


