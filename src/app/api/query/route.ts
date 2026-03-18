import { NextResponse } from 'next/server';
import {
  generateResponse,
  maybeExecuteExternalAction,
  normalizeGeneratedResponse,
  runAgentWorkflow,
  sanitizeActionResponse,
} from '@/lib/ai/agent';
import type { QueryRequest } from '@/lib/ai/types';

export const runtime = 'nodejs';

function sseStream(
  run: (emit: (chunk: string) => void) => Promise<{
    context?: string;
    sources?: string[];
    actionStatus?: string | null;
    chartData?: unknown;
    finalContent?: string;
  }>
): Response {
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        const meta = await run(chunk => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk })}\n\n`));
        });
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, ...meta })}\n\n`));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown query error';
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as QueryRequest;
    const message = String(body.message ?? '').trim();
    const fileId = String(body.fileId ?? '').trim();

    if (!message) {
      return NextResponse.json({ error: 'Message is required.' }, { status: 400 });
    }
    if (!fileId) {
      return NextResponse.json({ error: 'fileId is required.' }, { status: 400 });
    }

    return sseStream(async emit => {
      const workflow = await runAgentWorkflow({
        ...body,
        message,
        fileId,
        history: body.history ?? [],
      });

      console.info(
        '[query] Classified intent:',
        workflow.classification.intent,
        'confidence:',
        workflow.classification.confidence
      );
      console.info('[query] Retrieval warnings:', workflow.retrieval.warnings.join(' | ') || 'none');

      const stream = await generateResponse({
        message,
        history: body.history ?? [],
        classification: workflow.classification,
        processed: workflow.processed,
        retrieval: workflow.retrieval,
      });

      let finalText = '';
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? '';
        if (!delta) continue;
        finalText += delta;
        if (workflow.classification.intent !== 'action') {
          emit(delta);
        }
      }

      if (workflow.classification.intent === 'action') {
        finalText = sanitizeActionResponse(finalText);
        if (finalText) emit(finalText);
      }

      finalText = normalizeGeneratedResponse(finalText);

      const actionStatus = await maybeExecuteExternalAction({
        classification: workflow.classification,
        message,
        responseText: finalText,
        delivery: body.delivery,
      });

      if (workflow.classification.intent === 'action' && actionStatus) {
        const deliveryNote = `\n\n**Delivery status:** ${actionStatus}`;
        finalText += deliveryNote;
        emit(deliveryNote);
      }

      return {
        context: workflow.processed.contextText,
        sources: workflow.processed.sources,
        actionStatus,
        chartData: workflow.processed.chartData,
        finalContent: finalText,
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown query error';
    console.error('[query] Route failure:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
