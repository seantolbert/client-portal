// Per-request Supabase client acting as the signed-in user, so RLS applies.
import { createClient } from '@supabase/supabase-js';
import { json, requireEnv } from './http.js';

export class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function errorResponse(err, log) {
  if (err instanceof HttpError) return json(err.status, { error: err.code });
  log({ msg: 'request_failed', error: err.message });
  return json(500, { error: 'internal' });
}

export async function requireUser(request) {
  const match = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '');
  if (!match) throw new HttpError(401, 'unauthorized');
  const token = match[1];
  const db = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'unauthorized');
  return { user: data.user, db };
}

// The client the signed-in user belongs to, derived on the server from
// client_members. The browser never supplies client_id.
export async function requireClientMember(request) {
  const { user, db } = await requireUser(request);
  const { data, error } = await db
    .from('client_members')
    .select('client_id, clients (id, email, stripe_customer_id)')
    .eq('user_id', user.id);
  if (error) throw new Error(`load membership: ${error.message}`);
  if (data.length === 0) throw new HttpError(403, 'not_a_client');
  if (data.length > 1) throw new HttpError(409, 'multiple_clients');
  const client = data[0].clients;
  if (!client.stripe_customer_id) throw new HttpError(409, 'billing_not_ready');
  return { user, db, client };
}

export async function requireAdmin(request) {
  const { user, db } = await requireUser(request);
  const { data, error } = await db.rpc('is_admin');
  if (error) throw new Error(`is_admin: ${error.message}`);
  if (data !== true) throw new HttpError(403, 'forbidden');
  return { user, db };
}
