// Two-user RLS check against a real Supabase project (local or a test project).
// Creates two throwaway clients + users, signs each in with a real JWT, checks
// isolation through the REST API, then deletes what it created.
//   node --env-file=.env.local scripts/rls-live.mjs
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const run = Date.now();
const created = { clients: [], users: [] };
let failed = false;
const check = (name, ok, detail = '') => {
  failed ||= !ok;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};

async function makeClient(tag) {
  const email = `rls-${tag}-${run}@example.com`;
  const { data: rows, error } = await admin.rpc('handoff_create_client', {
    p_prospect_id: `rls_${tag}_${run}`, p_business_name: `RLS ${tag}`, p_contact_name: null,
    p_email: email, p_phone: null, p_address: null,
  });
  if (error) throw error;
  const clientId = rows[0].client_id;
  created.clients.push(clientId);
  const { data: u, error: ue } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (ue) throw ue;
  created.users.push(u.user.id);
  await admin.rpc('handoff_link_member', { p_client_id: clientId, p_email: email });
  await admin.from('invoices').insert({
    client_id: clientId, stripe_invoice_id: `in_rls_${tag}_${run}`, currency: 'usd',
    amount_due: 1000, amount_paid: 0, stripe_created_at: new Date().toISOString(),
  });

  // Real sign-in: a magic link token verified through the public auth API.
  const { data: link, error: le } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (le) throw le;
  const db = createClient(url, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { error: ve } = await db.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
  if (ve) throw ve;
  return { clientId, db };
}

try {
  const a = await makeClient('a');
  const b = await makeClient('b');

  for (const [who, me, other] of [['A', a, b], ['B', b, a]]) {
    const clients = await me.db.from('clients').select('id');
    check(`${who} sees only own client`, clients.data?.length === 1 && clients.data[0].id === me.clientId);
    const inv = await me.db.from('invoices').select('client_id');
    check(`${who} sees only own invoices`, inv.data?.every((r) => r.client_id === me.clientId) && inv.data.length === 1);
    const theirs = await me.db.from('invoices').select('*').eq('client_id', other.clientId);
    check(`${who} cannot read other client's invoices by id`, theirs.data?.length === 0);
    const forged = await me.db.from('payments').insert({
      client_id: me.clientId, stripe_source_id: `pi_forged_${run}`, source: 'checkout',
      amount: 1, currency: 'usd', status: 'succeeded', paid_at: new Date().toISOString(),
    });
    check(`${who} cannot insert payments`, Boolean(forged.error), forged.error?.code);
    const join = await me.db.from('client_members').insert({ user_id: (await me.db.auth.getUser()).data.user.id, client_id: other.clientId });
    check(`${who} cannot join other client`, Boolean(join.error), join.error?.code);
  }

  const anon = createClient(url, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const anonRead = await anon.from('invoices').select('*');
  check('anon cannot read invoices', Boolean(anonRead.error) || anonRead.data.length === 0, anonRead.error?.code);
} finally {
  for (const id of created.clients) await admin.from('clients').delete().eq('id', id);
  for (const id of created.users) await admin.auth.admin.deleteUser(id);
}
process.exit(failed ? 1 : 0);
