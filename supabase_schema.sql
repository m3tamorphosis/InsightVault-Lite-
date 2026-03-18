-- 1. Enable pgvector extension
create extension if not exists vector;

-- 2. Create files table
create table if not exists public.files (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    type text not null default 'csv',
    storage_path text,
    source text,
    category text,
    created_at timestamp with time zone default now()
);
alter table public.files add column if not exists type text not null default 'csv';
alter table public.files add column if not exists storage_path text;
alter table public.files add column if not exists source text;
alter table public.files add column if not exists category text;

-- 3. Create chunks table
create table if not exists public.chunks (
    id uuid primary key default gen_random_uuid(),
    file_id uuid references public.files(id) on delete cascade,
    content text not null,
    embedding vector(1536),
    page_number int,
    file_type text,
    category text,
    source text,
    metadata jsonb default '{}'::jsonb
);
alter table public.chunks add column if not exists page_number int;
alter table public.chunks add column if not exists file_type text;
alter table public.chunks add column if not exists category text;
alter table public.chunks add column if not exists source text;
alter table public.chunks add column if not exists metadata jsonb default '{}'::jsonb;

-- 4. CSV rows table
create table if not exists public.csv_rows (
    id bigserial primary key,
    file_id uuid not null references public.files(id) on delete cascade,
    row_index int not null,
    data jsonb not null
);
create index if not exists csv_rows_file_row_idx on public.csv_rows(file_id, row_index);

-- 5. Create similarity search function with file_id filter and metadata filtering
create or replace function match_chunks (
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  filter_file_id uuid,
  filter_file_type text default null,
  filter_category text default null,
  filter_source text default null
)
returns table (
  id uuid,
  content text,
  similarity float,
  page_number int,
  file_type text,
  category text,
  source text,
  metadata jsonb
)
language plpgsql
as $$
begin
  return query
  select
    chunks.id,
    chunks.content,
    1 - (chunks.embedding <=> query_embedding) as similarity,
    chunks.page_number,
    chunks.file_type,
    chunks.category,
    chunks.source,
    chunks.metadata
  from chunks
  where 1 - (chunks.embedding <=> query_embedding) > match_threshold
    and chunks.file_id = filter_file_id
    and (filter_file_type is null or chunks.file_type = filter_file_type)
    and (filter_category is null or chunks.category = filter_category)
    and (filter_source is null or chunks.source = filter_source)
  order by chunks.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- 6. PDF preview storage bucket (Supabase Storage)
insert into storage.buckets (id, name, public)
values ('insightvault-files', 'insightvault-files', false)
on conflict (id) do nothing;
