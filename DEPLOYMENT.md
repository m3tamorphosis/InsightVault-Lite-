# Deployment Guide - InsightVault Lite

Deploying to Vercel is the recommended way for this Next.js project.

## 1. Environment Variables setup

In the Vercel Dashboard -> Project Settings -> Environment Variables, add the following keys:

| Key | Value Source |
|-----|--------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project Settings > API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase Project Settings > API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Project Settings > API (Secret) |
| `OPENAI_API_KEY` | OpenAI Dashboard > API Keys |

## 2. Automatic CI/CD

Vercel provides seamless integration with GitHub:
1. Push your code to a GitHub repository.
2. Connect the repository to Vercel.
3. Every time you push to the `main` branch, Vercel will trigger a production build.
4. Pull Requests will trigger preview deployments automatically.

## 3. Database Migrations

Before your first deployment, ensure you've run the SQL schema in `supabase_schema.sql` within the Supabase SQL Editor.
