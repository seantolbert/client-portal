// Service role client. Bypasses RLS. Import ONLY from api/clients.js and
// api/stripe-webhook.js (and their store modules).
import { createClient } from '@supabase/supabase-js';
import { requireEnv } from './http.js';

let admin;

export function getServiceClient() {
  admin ??= createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return admin;
}
