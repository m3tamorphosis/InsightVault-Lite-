import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let supabaseClient: SupabaseClient | null = null;
let supabaseAdminClient: SupabaseClient | null = null;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function getSupabaseUrl(): string {
  return requiredEnv('NEXT_PUBLIC_SUPABASE_URL');
}

export function getSupabase(): SupabaseClient {
  if (supabaseClient) return supabaseClient;

  const supabaseUrl = getSupabaseUrl();
  const supabaseAnonKey = requiredEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  supabaseClient = createClient(supabaseUrl, supabaseAnonKey);
  return supabaseClient;
}

export function getSupabaseAdmin(): SupabaseClient {
  if (supabaseAdminClient) return supabaseAdminClient;

  const supabaseUrl = getSupabaseUrl();
  const supabaseServiceKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  supabaseAdminClient = createClient(supabaseUrl, supabaseServiceKey);
  return supabaseAdminClient;
}
