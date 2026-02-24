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

  const supabaseUrl = getSupabaseUrl();
  const supabaseAnonKey = requiredAnyEnv('SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
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
