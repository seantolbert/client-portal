import { test } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { createWebhookHandler } from '../lib/webhook.js';

const WHSEC = 'whsec_test_secret';
const real = new Stripe('sk_test_dummy');

function memoryStore() {
  const s = {
    events: new Set(),
    clients: new Map([['cus_A', { id: 'client-a', email: 'a@example.com' }]]),
    invoices: new Map(),
    subscriptions: new Map(),
    payments: new Map(),
    activated: [],
    async hasEvent(id) { return s.events.has(id); },
    async recordEvent(id) { s.events.add(id); },
    async findClientByCustomer(c) { return s.clients.get(c) ?? null; },
    async upsertInvoice(r) { s.invoices.set(r.stripe_invoice_id, r); },
    async upsertSubscription(r) { s.subscriptions.set(r.stripe_subscription_id, r); },
    async upsertPayment(r) { if (!s.payments.has(r.stripe_source_id)) s.payments.set(r.stripe_source_id, r); },
    async activateClient(id) { s.activated.push(id); },
  };
  return s;
}

function setup(objects = {}) {
  const store = memoryStore();
  const notified = [];
  const stripe = {
    webhooks: real.webhooks,
    subscriptions: { retrieve: async (id) => objects[id] },
    invoices: { retrieve: async (id) => objects[id] },
  };
  const handler = createWebhookHandler({
    stripe, webhookSecret: WHSEC, store, log: () => {}, notify: async (m) => notified.push(m),
  });
  return { store, handler, notified };
}

function deliver(handler, event, secret = WHSEC) {
  const payload = JSON.stringify(event);
  const header = real.webhooks.generateTestHeaderString({ payload, secret });
  return handler(new Request('https://portal.test/api/stripe-webhook', {
    method: 'POST', headers: { 'stripe-signature': header }, body: payload,
  }));
}

const checkoutEvent = {
  id: 'evt_checkout_1',
  type: 'checkout.session.completed',
  created: 1_800_000_000,
  data: { object: {
    id: 'cs_1', object: 'checkout.session', mode: 'payment', payment_status: 'paid',
    customer: 'cus_A', payment_intent: 'pi_1', amount_total: 100000, currency: 'usd',
    metadata: { client_id: 'client-a', product: 'website_fee' },
  } },
};

test('bad signature is rejected with 400 and writes nothing', async () => {
  const { handler, store } = setup();
  const res = await deliver(handler, checkoutEvent, 'whsec_wrong');
  assert.equal(res.status, 400);
  assert.equal(store.payments.size, 0);

  const noHeader = await handler(new Request('https://x/api', { method: 'POST', body: JSON.stringify(checkoutEvent) }));
  assert.equal(noHeader.status, 400);
});

test('checkout.session.completed records the $1,000 payment once', async () => {
  const { handler, store } = setup();
  assert.equal((await deliver(handler, checkoutEvent)).status, 200);
  const replay = await deliver(handler, checkoutEvent);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).duplicate, true);

  assert.equal(store.payments.size, 1);
  const p = store.payments.get('pi_1');
  assert.equal(p.client_id, 'client-a');
  assert.equal(p.amount, 100000);
  assert.equal(p.product, 'website_fee');
  assert.deepEqual(store.activated, ['client-a']);
});

test('client is resolved from the Stripe customer, not from metadata', async () => {
  const { handler, store } = setup();
  const spoofed = structuredClone(checkoutEvent);
  spoofed.id = 'evt_spoof';
  spoofed.data.object.customer = 'cus_unknown';
  assert.equal((await deliver(handler, spoofed)).status, 200);
  assert.equal(store.payments.size, 0);
});

test('invoice.paid mirrors the invoice and records a payment from fresh Stripe state', async () => {
  const invoice = {
    id: 'in_1', customer: 'cus_A', status: 'paid', number: 'INV-0001', currency: 'usd',
    amount_due: 250000, amount_paid: 250000, created: 1_800_000_000, due_date: null,
    hosted_invoice_url: 'https://invoice.stripe.com/i/x', metadata: { kind: 'automation_quote' },
    status_transitions: { paid_at: 1_800_000_100 },
  };
  const { handler, store } = setup({ in_1: invoice });
  const res = await deliver(handler, {
    id: 'evt_inv_1', type: 'invoice.paid', created: 1, data: { object: { id: 'in_1', status: 'open' } },
  });
  assert.equal(res.status, 200);
  assert.equal(store.invoices.get('in_1').status, 'paid');
  assert.equal(store.payments.get('in_1').amount, 250000);
  assert.equal(store.payments.get('in_1').product, 'automation_quote');
});

test('invoice.payment_failed notifies the client', async () => {
  const invoice = {
    id: 'in_2', customer: 'cus_A', status: 'open', number: 'INV-0002', currency: 'usd',
    amount_due: 10000, amount_paid: 0, created: 1, hosted_invoice_url: 'https://invoice.stripe.com/i/y',
    parent: { subscription_details: { subscription: 'sub_1' } },
  };
  const { handler, store, notified } = setup({ in_2: invoice });
  await deliver(handler, { id: 'evt_f', type: 'invoice.payment_failed', created: 1, data: { object: { id: 'in_2' } } });
  assert.equal(store.invoices.get('in_2').stripe_subscription_id, 'sub_1');
  assert.equal(store.payments.size, 0);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].to, 'a@example.com');
});

test('subscription events upsert current state', async () => {
  const sub = {
    id: 'sub_1', customer: 'cus_A', status: 'canceled', cancel_at_period_end: false,
    canceled_at: 1_800_000_500, created: 1_800_000_000,
    items: { data: [{ price: { id: 'price_m' }, current_period_end: 1_802_000_000 }] },
  };
  const { handler, store } = setup({ sub_1: sub });
  await deliver(handler, { id: 'evt_s', type: 'customer.subscription.deleted', created: 1, data: { object: { id: 'sub_1' } } });
  const row = store.subscriptions.get('sub_1');
  assert.equal(row.status, 'canceled');
  assert.equal(row.price_id, 'price_m');
  assert.equal(row.client_id, 'client-a');
});

test('processing failure returns 500 and does not record the event', async () => {
  const { handler, store } = setup();
  store.upsertPayment = async () => { throw new Error('db down'); };
  const res = await deliver(handler, checkoutEvent);
  assert.equal(res.status, 500);
  assert.equal(store.events.size, 0);
});
