# InsightVault Lite

InsightVault Lite is a production-style AI document and dataset analysis system built with Next.js, OpenAI, and Supabase. It supports CSV and PDF workflows through a modular pipeline that classifies user intent, retrieves grounded context, processes that context, generates a response, and can optionally trigger external actions like Slack delivery.

## Overview
This project started as a basic RAG-style file chat app and was upgraded into a more advanced AI system with:
- Multi-step AI workflows instead of a single prompt -> response call.
- Agent-style routing for `summary`, `analysis`, `comparison`, and `action` tasks.
- Retrieval-aware design for both structured CSV data and chunked PDF documents.
- External tool orchestration through Slack webhooks and Resend email support.
- A more production-minded architecture with modular AI layers and explicit error handling.

## Core Capabilities
- Multi-step workflow: classify -> retrieve -> process -> generate.
- Agent-style behavior that routes differently for summary, analysis, comparison, and action prompts.
- Metadata-aware retrieval with file type, source, and category filtering.
- Paragraph-first PDF chunking for more grounded document retrieval.
- CSV comparison retrieval that can pull highest-vs-lowest records for comparison prompts.
- Deterministic CSV charting based on structured grouping and metric rules instead of model-only phrasing.
- Automatic CSV chart type selection:
  - `bar` for grouped comparisons, rankings, and top/bottom results
  - `line` for time and trend questions
  - `pie` for distribution and composition questions, with fallback to `bar` when the group count is too large
- CSV chart generation only when a valid grouping field, valid metric field, and meaningful grouped result are present.
- CSV follow-up suggestions generated deterministically from the schema and current app capabilities.
- Follow-up delivery actions like `Send it to my Slack.` can reuse the latest assistant answer instead of generating a new unrelated summary.
- Streamed responses through `/api/query`.
- Credentials auth with Supabase email/password and display-name metadata.
- Chat import/export support for markdown conversation files.
- Optional external delivery through Slack and email.

## End-to-End Flow
```text
File upload
-> parsing / extraction
-> metadata capture
-> embeddings or structured row storage
-> intent classification
-> retrieval
-> context processing
-> response generation
-> optional external action
```

## Architecture
### Upload pipeline
1. Upload file metadata is registered in `files`.
2. CSV files are parsed and stored in `csv_rows`.
3. PDF files are chunked by section/paragraph, embedded, and stored in `chunks` with metadata.

### Query pipeline
1. `classifyQuery()` determines intent and routing.
2. `retrieveDocuments()` fetches matching rows or semantic chunks.
3. `processContext()` builds a grounded context packet, warnings, and CSV chart data when the request qualifies for deterministic visualization.
4. `generateResponse()` streams the final answer.
5. `maybeExecuteExternalAction()` optionally sends the result to Slack or email, including follow-up delivery actions based on the latest answer.

## AI Modules
```text
src/lib/ai/
  classifier.ts
  retrieval.ts
  processor.ts
  agent.ts
  types.ts
```

## Frontend Experience
- Sign in / sign up with Supabase credentials auth.
- Upload page with recent files, protected access, and account dropdown.
- Multi-file chat with CSV and PDF tabs.
- Import/export chat as markdown.
- CSV charts render in-chat when the query is better answered visually.
- Theme-aware UI for dark and light modes.

## Main API
- `POST /api/query`

Example request:
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

## Demo Prompts
### CSV
```text
Analyze this dataset, identify the most important sales trends, explain what matters most for the business, and show the most appropriate chart based on the actual data.
```

```text
Rank the regions by total sales and show the most appropriate chart.
```

```text
Show the sales trend over time and explain the main pattern.
```

```text
How does total sales break down by category? Explain the distribution and show the most appropriate chart.
```

```text
How does the total sales amount vary by region for the product Laptop? Explain the result briefly and show the most appropriate chart.
```

```text
Compare the highest and lowest sales records, summarize the result for a manager, and send it to Slack.
```

### PDF
```text
Summarize this CV, identify the strongest qualifications, and explain the most important takeaway.
```

```text
Analyze this resume for strengths, standout projects, and role fit for an AI/full-stack developer position.
```

```text
Answer using only information from this CV, and clearly say if a detail is missing or unsupported.
```

## Why This Project Is Different
This project demonstrates more than basic retrieval-augmented generation. It showcases:
- Multi-step AI workflows rather than a direct prompt -> answer pipeline.
- Agent-style decision making through intent-based routing.
- Orchestration across OpenAI, Supabase, Slack, and email delivery paths.
- More thoughtful retrieval design with chunking, metadata filters, and edge-case handling.
- Production-minded structure through modular architecture and repeatable workflows.

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

## Setup
1. Run the SQL in `supabase_schema.sql`.
2. Enable Supabase Email auth in your project.
3. Add your environment variables to `.env.local`.
4. Install dependencies with `npm install`.
5. Start the app with `npm run dev`.

## Notes
- The chat UI uses `/api/query` as the main orchestration route.
- Sign out clears InsightVault's local chat, dataset, and recent-file state to avoid cross-user leakage on shared browsers.
- The auth page supports browser-managed `Remember me` behavior through standard password-manager autofill. The app does not store raw passwords itself.
- CSV charting is deterministic and CSV-only. PDF workflows remain grounded text and document analysis without chart rendering.
- CSV follow-up suggestions are schema-aware and deterministic. PDF follow-up suggestions are document-analysis only and explicitly avoid chart-style prompts.
- When a user sends a follow-up action like `Send it to my Slack.`, the system can reuse the latest assistant result as the delivery content.
- Slack works as the primary external action flow when `SLACK_WEBHOOK_URL` is configured.
- Resend email sending requires a valid verified sender domain.
- PDF retrieval depends on the metadata columns and `match_chunks` RPC signature in `supabase_schema.sql`.
