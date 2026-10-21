import { json, requireEnv } from '../lib/http.js';

// Public browser config. The anon key is designed to be public; RLS protects data.
export function GET() {
  return json(200, {
    supabaseUrl: requireEnv('SUPABASE_URL'),
    supabaseAnonKey: requireEnv('SUPABASE_ANON_KEY'),
  });
}
