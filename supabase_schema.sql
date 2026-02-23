-- 1. Enable pgvector extension
create extension if not exists vector;

-- 2. Create files table
create table if not exists public.files (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    type text not null default 'csv',
    storage_path text,
    created_at timestamp with time zone default now()
);
alter table public.files add column if not exists type text not null default 'csv';
alter table public.files add column if not exists storage_path text;

-- 3. Create chunks table
create table if not exists public.chunks (
    id uuid primary key default gen_random_uuid(),
    file_id uuid references public.files(id) on delete cascade,
    content text not null,
    embedding vector(1536), -- 1536 is for OpenAI's text-embedding-3-small or text-embedding-ada-002
    page_number int
);
alter table public.chunks add column if not exists page_number int;

-- 4. CSV rows table
create table if not exists public.csv_rows (
    id bigserial primary key,
    file_id uuid not null references public.files(id) on delete cascade,
    row_index int not null,
    data jsonb not null
);
create index if not exists csv_rows_file_row_idx on public.csv_rows(file_id, row_index);

-- 5. Create similarity search function with file_id filter
create or replace function match_chunks (
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  filter_file_id uuid -- Add this parameter
)
returns table (
  id uuid,
  content text,
  similarity float,
  page_number int
)
language plpgsql
as $$
begin
  return query
  select
    chunks.id,
    chunks.content,
    1 - (chunks.embedding <=> query_embedding) as similarity,
    chunks.page_number
  from chunks
  where 1 - (chunks.embedding <=> query_embedding) > match_threshold
    and chunks.file_id = filter_file_id -- Add this filter
  order by chunks.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- 6. PDF preview storage bucket (Supabase Storage)
insert into storage.buckets (id, name, public)
values ('insightvault-files', 'insightvault-files', false)
on conflict (id) do nothing;
