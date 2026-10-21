// POST /api/stripe-webhook. The only writer of billing state.
// Objects are re-fetched from Stripe so out-of-order deliveries can't regress state.
import { json, readRawBody } from './http.js';

const ts = (seconds) => (seconds ? new Date(seconds * 1000).toISOString() : null);
const idOf = (v) => (typeof v === 'string' ? v : v?.id ?? null);

export function invoiceRow(clientId, inv) {
  return {
    client_id: clientId,
    stripe_invoice_id: inv.id,
    stripe_subscription_id: idOf(inv.parent?.subscription_details?.subscription),
    number: inv.number,
    description: inv.description ?? inv.lines?.data?.[0]?.description ?? null,
    status: inv.status,
    currency: inv.currency,
    amount_due: inv.amount_due,
    amount_paid: inv.amount_paid,
    hosted_invoice_url: inv.hosted_invoice_url ?? null,
    invoice_pdf: inv.invoice_pdf ?? null,
    due_date: ts(inv.due_date),
    stripe_created_at: ts(inv.created),
    updated_at: new Date().toISOString(),
  };
}

export function subscriptionRow(clientId, sub) {
  const item = sub.items?.data?.[0];
  return {
    client_id: clientId,
    stripe_subscription_id: sub.id,
    status: sub.status,
    price_id: item?.price?.id ?? null,
    current_period_end: ts(item?.current_period_end),
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
    canceled_at: ts(sub.canceled_at),
    stripe_created_at: ts(sub.created),
    updated_at: new Date().toISOString(),
  };
}

/**
 * deps:
 *   stripe         Stripe instance
 *   webhookSecret  STRIPE_WEBHOOK_SECRET
 *   store          see lib/webhook-store.js
 *   notify         optional async ({ to, subject, text }) => void
 *   log            (fields) => void
 */
export function createWebhookHandler({ stripe, webhookSecret, store, notify, log }) {
  async function clientFor(customer, metadata) {
    const customerId = idOf(customer);
    const client = customerId ? await store.findClientByCustomer(customerId) : null;
    if (client) return client;
    if (metadata?.client_id) log({ msg: 'webhook_customer_mismatch', customer: customerId });
    return null;
  }

  async function syncSubscription(subscriptionId) {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const client = await clientFor(sub.customer, sub.metadata);
    if (!client) return;
    await store.upsertSubscription(subscriptionRow(client.id, sub));
  }

  async function syncInvoice(invoiceId, eventType) {
    const inv = await stripe.invoices.retrieve(invoiceId);
    const client = await clientFor(inv.customer, inv.metadata);
    if (!client) return;
    await store.upsertInvoice(invoiceRow(client.id, inv));

    if (inv.status === 'paid') {
      await store.upsertPayment({
        client_id: client.id,
        stripe_source_id: inv.id,
        source: 'invoice',
        product: inv.metadata?.kind ?? (inv.parent?.subscription_details ? 'maintenance' : null),
        description: inv.number ? `Invoice ${inv.number}` : 'Invoice',
        amount: inv.amount_paid,
        currency: inv.currency,
        status: 'succeeded',
        paid_at: ts(inv.status_transitions?.paid_at) ?? new Date().toISOString(),
      });
      await store.activateClient(client.id);
    }

    if (eventType === 'invoice.payment_failed' && notify) {
      await notify({
        to: client.email,
        subject: 'A payment for your account failed',
        text:
          `We couldn't collect payment for invoice ${inv.number ?? ''}.\n\n` +
          (inv.hosted_invoice_url ? `Pay or update your card here: ${inv.hosted_invoice_url}\n` : '') +
          'You can also update your payment method from your client portal.\n',
      });
    }
  }

  async function handleCheckoutCompleted(session, eventCreated) {
    if (session.mode === 'subscription' && session.subscription) {
      await syncSubscription(idOf(session.subscription));
      return;
    }
    if (session.mode !== 'payment' || session.payment_status !== 'paid') return;
    const client = await clientFor(session.customer, session.metadata);
    if (!client) return;
    await store.upsertPayment({
      client_id: client.id,
      stripe_source_id: idOf(session.payment_intent) ?? session.id,
      source: 'checkout',
      product: session.metadata?.product ?? null,
      description: session.metadata?.product === 'website_fee' ? 'Website build fee' : 'Checkout payment',
      amount: session.amount_total,
      currency: session.currency,
      status: 'succeeded',
      paid_at: ts(eventCreated),
    });
    await store.activateClient(client.id);
  }

  return async function handle(request) {
    const rawBody = await readRawBody(request);
    const signature = request.headers.get('stripe-signature');
    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature ?? '', webhookSecret);
    } catch (err) {
      log({ msg: 'webhook_rejected', reason: 'bad_signature' });
      return json(400, { error: 'invalid_signature' });
    }

    if (await store.hasEvent(event.id)) {
      log({ msg: 'webhook', event: event.id, type: event.type, outcome: 'duplicate' });
      return json(200, { received: true, duplicate: true });
    }

    const obj = event.data.object;
    try {
      switch (event.type) {
        // Delayed-settlement methods complete unpaid, then send async_payment_succeeded.
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded':
          await handleCheckoutCompleted(obj, event.created);
          break;
        case 'invoice.finalized':
        case 'invoice.paid':
        case 'invoice.payment_failed':
          await syncInvoice(obj.id, event.type);
          break;
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
          await syncSubscription(obj.id);
          break;
        default:
          log({ msg: 'webhook', event: event.id, type: event.type, outcome: 'ignored' });
          return json(200, { received: true, ignored: true });
      }
      // Recorded only after success so Stripe retries anything that failed.
      await store.recordEvent(event.id, event.type);
      log({ msg: 'webhook', event: event.id, type: event.type, outcome: 'processed' });
      return json(200, { received: true });
    } catch (err) {
      log({ msg: 'webhook', event: event.id, type: event.type, outcome: 'failed', error: err.message });
      return json(500, { error: 'internal' });
    }
  };
}
