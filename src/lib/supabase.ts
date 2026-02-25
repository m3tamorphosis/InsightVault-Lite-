import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let supabaseClient: SupabaseClient | null = null;
let supabaseAdminClient: SupabaseClient | null = null;

function requiredAnyEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`${names.join(' or ')} is required.`);
}

function getSupabaseUrl(): string {
  return requiredAnyEnv('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
}

export function getSupabase(): SupabaseClient {
  if (supabaseClient) return supabaseClient;

  // Client-side builds only expose NEXT_PUBLIC_* env vars reliably.
  // Avoid dynamic process.env indexing here.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is required.');
  }
  if (!supabaseAnonKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY is required.');
  }
  supabaseClient = createClient(supabaseUrl, supabaseAnonKey);
  return supabaseClient;
}

export function getSupabaseAdmin(): SupabaseClient {
  if (supabaseAdminClient) return supabaseAdminClient;

  const supabaseUrl = getSupabaseUrl();
  const supabaseServiceKey = requiredAnyEnv('SUPABASE_SERVICE_ROLE_KEY');
  supabaseAdminClient = createClient(supabaseUrl, supabaseServiceKey);
  return supabaseAdminClient;
}
