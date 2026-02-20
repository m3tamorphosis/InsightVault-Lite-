-- 1. Enable pgvector extension
create extension if not exists vector;

-- 2. Create files table
create table if not exists public.files (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    created_at timestamp with time zone default now()
);

-- 3. Create chunks table
create table if not exists public.chunks (
    id uuid primary key default gen_random_uuid(),
    file_id uuid references public.files(id) on delete cascade,
    content text not null,
    embedding vector(1536) -- 1536 is for OpenAI's text-embedding-3-small or text-embedding-ada-002
);

-- 4. Create similarity search function with file_id filter
create or replace function match_chunks (
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  filter_file_id uuid -- Add this parameter
)
returns table (
  id uuid,
  content text,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    chunks.id,
    chunks.content,
    1 - (chunks.embedding <=> query_embedding) as similarity
  from chunks
  where 1 - (chunks.embedding <=> query_embedding) > match_threshold
    and chunks.file_id = filter_file_id -- Add this filter
  order by chunks.embedding <=> query_embedding
  limit match_count;
end;
$$;
