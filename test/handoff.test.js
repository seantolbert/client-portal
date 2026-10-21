import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createHandoffHandler, sign } from '../lib/handoff.js';

const SECRET = 'test-handoff-secret';
const NOW = 1_800_000_000_000;
const fixture = readFileSync(new URL('./fixtures/handoff-payload.json', import.meta.url), 'utf8');

// In-memory store with the same semantics as the unique constraint on prospect_id.
function memoryStore() {
  const byProspect = new Map();
  const members = new Set();
  return {
    rows: byProspect,
    members,
    async createClient(f) {
      const existing = byProspect.get(f.prospect_id);
      if (existing) return { ...existing, client_id: existing.id, created: false };
      const row = { id: randomUUID(), ...f, stripe_customer_id: null };
      byProspect.set(f.prospect_id, row);
      return { ...row, client_id: row.id, created: true };
    },
    async setStripeCustomer(clientId, customerId) {
      for (const row of byProspect.values()) if (row.id === clientId) row.stripe_customer_id ??= customerId;
    },
    async linkMember(clientId, email) {
      members.add(`${clientId}:${email}`);
    },
  };
}

function fakeStripe() {
  const calls = [];
  return {
    calls,
    customers: {
      async create(params, opts) {
        calls.push({ params, opts });
        return { id: `cus_${calls.length}` };
      },
    },
  };
}

function setup() {
  const store = memoryStore();
  const stripe = fakeStripe();
  const logs = [];
  const handler = createHandoffHandler({ secret: SECRET, store, stripe, log: (l) => logs.push(l), now: () => NOW });
  return { store, stripe, logs, handler };
}

function signedRequest(body, { timestamp = String(Math.floor(NOW / 1000)), signature } = {}) {
  return new Request('https://portal.test/api/clients', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-handoff-timestamp': timestamp,
      'x-handoff-signature': signature ?? sign(SECRET, timestamp, body),
    },
    body,
  });
}

test('fixture: accepted 201, replay 200 with same client_id', async () => {
  const { handler, store, stripe, logs } = setup();

  const first = await handler(signedRequest(fixture));
  assert.equal(first.status, 201);
  const a = await first.json();
  assert.equal(a.created, true);
  assert.match(a.client_id, /^[0-9a-f-]{36}$/);

  const replay = await handler(signedRequest(fixture));
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { client_id: a.client_id, created: false });

  assert.equal(store.rows.size, 1);
  assert.equal(stripe.calls.length, 1, 'one Stripe customer');
  assert.equal(stripe.calls[0].params.metadata.client_id, a.client_id);
  assert.equal(store.members.size, 1);
  assert.deepEqual(logs.map((l) => l.outcome), ['created', 'existing']);
  assert.ok(!JSON.stringify(logs).includes(SECRET));
});

test('replay with different fields keeps the original record', async () => {
  const { handler, store } = setup();
  await handler(signedRequest(fixture));
  const changed = JSON.stringify({ ...JSON.parse(fixture), business_name: 'Renamed LLC' });
  const res = await handler(signedRequest(changed));
  assert.equal(res.status, 200);
  assert.equal(store.rows.get('p_01HZX3K9Q2').business_name, 'Example Plumbing LLC');
});

test('stale timestamp is 401', async () => {
  const { handler, store } = setup();
  for (const skew of [301, -301]) {
    const ts = String(Math.floor(NOW / 1000) - skew);
    const res = await handler(signedRequest(fixture, { timestamp: ts }));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  }
  assert.equal(store.rows.size, 0);
});

test('timestamp at exactly 300s is accepted', async () => {
  const { handler } = setup();
  const res = await handler(signedRequest(fixture, { timestamp: String(Math.floor(NOW / 1000) - 300) }));
  assert.equal(res.status, 201);
});

test('bad signature is 401', async () => {
  const { handler, store } = setup();
  const ts = String(Math.floor(NOW / 1000));
  const cases = [
    sign('wrong-secret', ts, fixture),
    sign(SECRET, ts, fixture).toUpperCase(),
    sign(SECRET, ts, fixture).slice(0, 63),
    'zz',
  ];
  for (const signature of cases) {
    const res = await handler(signedRequest(fixture, { signature }));
    assert.equal(res.status, 401);
  }
  // Signature over a re-serialized body does not match the raw bytes sent.
  const reserialized = JSON.stringify(JSON.parse(fixture), null, 2);
  const res = await handler(signedRequest(reserialized, { signature: sign(SECRET, ts, fixture) }));
  assert.equal(res.status, 401);
  assert.equal(store.rows.size, 0);
});

test('missing headers is 401', async () => {
  const { handler } = setup();
  const res = await handler(new Request('https://portal.test/api/clients', { method: 'POST', body: fixture }));
  assert.equal(res.status, 401);
});

test('validation: unknown field, missing required, bad email, lengths', async () => {
  const { handler, store } = setup();
  const body = JSON.stringify({
    prospect_id: '',
    business_name: 'x'.repeat(201),
    email: 'not-an-email',
    address: 'line1\nline2',
    phone: 12345,
    client_id: 'injected',
  });
  const res = await handler(signedRequest(body));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    error: 'validation_failed',
    fields: {
      client_id: 'unknown_field',
      prospect_id: 'required',
      business_name: 'max_length_200',
      email: 'invalid_email',
      address: 'must_be_single_line',
      phone: 'must_be_string',
    },
  });
  assert.equal(store.rows.size, 0);
});

test('invalid JSON and non-object bodies are 400', async () => {
  const { handler } = setup();
  for (const body of ['{nope', '[]', 'null']) {
    const res = await handler(signedRequest(body));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'validation_failed');
  }
});

test('Stripe failure is 500, and the retry finishes provisioning with 200', async () => {
  const { store, logs } = setup();
  let fail = true;
  const stripe = {
    customers: {
      async create() {
        if (fail) throw new Error('stripe down');
        return { id: 'cus_retry' };
      },
    },
  };
  const handler = createHandoffHandler({ secret: SECRET, store, stripe, log: (l) => logs.push(l), now: () => NOW });
  const first = await handler(signedRequest(fixture));
  assert.equal(first.status, 500);
  assert.deepEqual(await first.json(), { error: 'internal' });

  fail = false;
  const retry = await handler(signedRequest(fixture));
  assert.equal(retry.status, 200);
  assert.equal(store.rows.get('p_01HZX3K9Q2').stripe_customer_id, 'cus_retry');
});
