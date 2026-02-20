import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Use anon key for client-side operations
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Use service role key for admin/server-side operations (like upserting embeddings)
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
