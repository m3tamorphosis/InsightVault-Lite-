# InsightVault Lite 🚀

A high-performance RAG (Retrieval-Augmented Generation) application built with Next.js, OpenAI, and Supabase. InsightVault Lite allows you to upload CSV datasets and chat with your data using AI that strictly follows your own context.

## 🌟 Features
- **CSV Data Ingestion**: Bulk upload and parse CSV files using PapaParse.
- **RAG Pipeline**: Automated text embedding generation via OpenAI `text-embedding-3-small`.
- **Vector Search**: Efficient similarity searches using Supabase `pgvector`.
- **Clean UI**: A ChatGPT-style interface with Lucide icons and dark mode support.
- **Context Awareness**: The AI acts as a data analyst, answering only from provided context.

## 🛠 Tech Stack
- **Frontend**: Next.js 14, Tailwind CSS, Lucide React
- **Backend**: Next.js API Routes (Route Handlers)
- **Database**: Supabase (PostgreSQL + pgvector)
- **AI**: OpenAI API (GPT-4o & Embeddings)
- **Parsing**: PapaParse

## 🏗 Architecture
1. **Upload**: User uploads CSV -> API parses rows -> OpenAI generates vectors -> Stored in Supabase.
2. **Query**: User asks question -> API embeds question -> Similarity search in Supabase -> Context sent to GPT-4o -> Response with sources returned.

## 🚀 Getting Started

### 1. Clone the repo
```bash
git clone <your-repo-url>
cd InsightVault
```

### 2. Setup Environment Variables
Create a `.env.local` file:
```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
OPENAI_API_KEY=your_openai_api_key
```

### 3. Setup Database
Run the SQL found in `supabase_schema.sql` in your Supabase SQL Editor.

### 4. Install & Run
```bash
npm install
npm run dev
```

## 📸 Demo
[Placeholder for screenshot: Upload Page]
[Placeholder for screenshot: Chat Interface with Sources]

---
Built by [Your Name] for modern data analysis workflows.
