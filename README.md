# InsightVault Lite

InsightVault Lite is now organized as a production-style AI workflow built on Next.js, OpenAI, and Supabase. It supports structured query classification, retrieval orchestration, context processing, streamed response generation, and optional Slack or Resend delivery actions.

## Features
- Multi-step AI workflow: classify -> retrieve -> process -> generate.
- Agent-style routing for `summary`, `analysis`, `comparison`, and `action` intents.
- Metadata-aware retrieval with source/category/file-type filters.
- Improved paragraph-first chunking for document ingestion.
- External action support for Slack webhooks and Resend email.
- Streamed responses for the chat UI through `/api/query`.

## Architecture
### Upload pipeline
1. Upload file metadata is registered in `files`.
2. CSV files are stored in `csv_rows`.
3. PDF files are chunked by section/paragraph, embedded, and stored in `chunks` with metadata.

### Query pipeline
1. `classifyQuery()` determines intent and routing.
2. `retrieveDocuments()` fetches matching rows or semantic chunks.
3. `processContext()` builds a grounded context packet and warnings.
4. `generateResponse()` streams the final answer.
5. `maybeExecuteExternalAction()` optionally sends the result to Slack or email.

## AI Modules
```text
src/lib/ai/
  classifier.ts
  retrieval.ts
  processor.ts
  agent.ts
  types.ts
```

## Environment Variables
```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
OPENAI_API_KEY=your_openai_api_key
SLACK_WEBHOOK_URL=your_slack_webhook_url
RESEND_API_KEY=your_resend_api_key
RESEND_FROM_EMAIL=reports@example.com
```

## Main API
- `POST /api/query`
- Request body:
```json
{
  "message": "Summarize the main findings and send them to Slack",
  "fileId": "your-file-id",
  "history": [],
  "filters": {
    "category": "document"
  },
  "delivery": {
    "slackWebhookUrl": "optional-override"
  }
}
```

## Setup
1. Run the SQL in `supabase_schema.sql`.
2. Add your environment variables to `.env.local`.
3. Install dependencies with `npm install`.
4. Start the app with `npm run dev`.

## Notes
- Existing upload routes remain available, but the chat UI now talks to `/api/query`.
- PDF retrieval quality depends on the new metadata columns and `match_chunks` RPC signature in the SQL schema.
