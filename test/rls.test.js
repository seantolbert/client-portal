// Runs the real migration on an in-process Postgres (PGlite) with a minimal
// stand-in for Supabase's auth schema and roles, then checks RLS as two users.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const USER_A = '00000000-0000-0000-0000-00000000000a';
const USER_B = '00000000-0000-0000-0000-00000000000b';
const ADMIN = '00000000-0000-0000-0000-0000000000ad';

const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth, public to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
`;

let db;
let clientA;
let clientB;

async function as(role, sub, fn) {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${sub ?? ''}', false);`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

before(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  const dir = new URL('../supabase/migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(new URL(f, dir), 'utf8'));
  }
  await db.exec(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'a@example.com'), ('${USER_B}', 'b@example.com'), ('${ADMIN}', 'admin@example.com');
    insert into public.admins (user_id) values ('${ADMIN}');
  `);

  // Create both clients through the handoff functions, as the service role.
  await as('service_role', null, async () => {
    const a = await db.query(`select * from public.handoff_create_client('p_a', 'A Co', null, 'a@example.com', null, null)`);
    const b = await db.query(`select * from public.handoff_create_client('p_b', 'B Co', null, 'b@example.com', null, null)`);
    clientA = a.rows[0].client_id;
    clientB = b.rows[0].client_id;
    await db.query(`select public.handoff_link_member($1, 'A@Example.com')`, [clientA]);
    await db.query(`select public.handoff_link_member($1, 'b@example.com')`, [clientB]);
    for (const [c, n] of [[clientA, 'A'], [clientB, 'B']]) {
      await db.query(
        `insert into public.invoices (client_id, stripe_invoice_id, currency, amount_due, amount_paid, stripe_created_at)
         values ($1, $2, 'usd', 100000, 0, now())`, [c, `in_${n}`]);
      await db.query(
        `insert into public.payments (client_id, stripe_source_id, source, amount, currency, status, paid_at)
         values ($1, $2, 'checkout', 100000, 'usd', 'succeeded', now())`, [c, `pi_${n}`]);
      await db.query(
        `insert into public.subscriptions (client_id, stripe_subscription_id, status, stripe_created_at)
         values ($1, $2, 'active', now())`, [c, `sub_${n}`]);
    }
  });
});

test('handoff_create_client is idempotent on prospect_id and keeps the original', async () => {
  await as('service_role', null, async () => {
    const r = await db.query(`select * from public.handoff_create_client('p_a', 'Changed', null, 'x@example.com', null, null)`);
    assert.equal(r.rows[0].client_id, clientA);
    assert.equal(r.rows[0].created, false);
    assert.equal(r.rows[0].business_name, 'A Co');
  });
});

for (const table of ['clients', 'invoices', 'payments', 'subscriptions']) {
  test(`user A sees only client A's ${table}; user B only B's`, async () => {
    const col = table === 'clients' ? 'id' : 'client_id';
    const a = await as('authenticated', USER_A, () => db.query(`select ${col} as c from public.${table}`));
    const b = await as('authenticated', USER_B, () => db.query(`select ${col} as c from public.${table}`));
    assert.deepEqual(a.rows.map((r) => r.c), [clientA]);
    assert.deepEqual(b.rows.map((r) => r.c), [clientB]);
  });
}

test('user B cannot read client A rows even when filtering by A explicitly', async () => {
  const r = await as('authenticated', USER_B, () =>
    db.query(`select * from public.invoices where client_id = $1`, [clientA]));
  assert.equal(r.rows.length, 0);
});

test('client_members: users see only their own membership', async () => {
  const r = await as('authenticated', USER_A, () => db.query(`select user_id, client_id from public.client_members`));
  assert.deepEqual(r.rows, [{ user_id: USER_A, client_id: clientA }]);
});

test('authenticated users cannot write billing mirrors or clients', async () => {
  const attempts = [
    `insert into public.payments (client_id, stripe_source_id, source, amount, currency, status, paid_at)
       values ('${clientA}', 'pi_forged', 'checkout', 1, 'usd', 'succeeded', now())`,
    `update public.invoices set status = 'paid'`,
    `update public.clients set stripe_customer_id = 'cus_evil'`,
    `insert into public.client_members (user_id, client_id) values ('${USER_B}', '${clientA}')`,
    `delete from public.subscriptions`,
  ];
  for (const sql of attempts) {
    await assert.rejects(as('authenticated', USER_B, () => db.query(sql)), /permission denied/, sql);
  }
});

test('authenticated users cannot call handoff functions or read admins/stripe_events', async () => {
  for (const sql of [
    `select * from public.handoff_create_client('p_x', 'X', null, 'x@example.com', null, null)`,
    `select public.handoff_link_member('${clientA}', 'b@example.com')`,
    `select * from public.admins`,
    `select * from public.stripe_events`,
  ]) {
    await assert.rejects(as('authenticated', USER_B, () => db.query(sql)), /permission denied/, sql);
  }
});

test('anon sees nothing', async () => {
  for (const t of ['clients', 'invoices', 'payments', 'subscriptions', 'client_members', 'engagements']) {
    await assert.rejects(as('anon', null, () => db.query(`select * from public.${t}`)), /permission denied/);
  }
});

test('admin reads all clients; is_admin is false for clients', async () => {
  const r = await as('authenticated', ADMIN, () => db.query(`select id from public.clients order by business_name`));
  assert.deepEqual(r.rows.map((x) => x.id), [clientA, clientB]);
  const notAdmin = await as('authenticated', USER_A, () => db.query(`select public.is_admin() as v`));
  assert.equal(notAdmin.rows[0].v, false);
});
