// Service-role persistence for the Stripe webhook.
import { getServiceClient } from './supabase-admin.js';

function check(label, { error }) {
  if (error) throw new Error(`${label}: ${error.message}`);
}

export function createWebhookStore(db = getServiceClient()) {
  return {
    async hasEvent(id) {
      const { data, error } = await db.from('stripe_events').select('id').eq('id', id).maybeSingle();
      if (error) throw new Error(`load stripe_event: ${error.message}`);
      return data !== null;
    },
    async recordEvent(id, type) {
      check('record stripe_event', await db.from('stripe_events').upsert({ id, type }, { onConflict: 'id', ignoreDuplicates: true }));
    },
    async findClientByCustomer(customerId) {
      const { data, error } = await db
        .from('clients')
        .select('id, email')
        .eq('stripe_customer_id', customerId)
        .maybeSingle();
      if (error) throw new Error(`load client: ${error.message}`);
      return data;
    },
    async upsertInvoice(row) {
      check('upsert invoice', await db.from('invoices').upsert(row, { onConflict: 'stripe_invoice_id' }));
    },
    async upsertSubscription(row) {
      check('upsert subscription', await db.from('subscriptions').upsert(row, { onConflict: 'stripe_subscription_id' }));
    },
    async upsertPayment(row) {
      check('upsert payment', await db.from('payments').upsert(row, { onConflict: 'stripe_source_id', ignoreDuplicates: true }));
    },
    async activateClient(id) {
      check('activate client', await db.from('clients').update({ status: 'active' }).eq('id', id).eq('status', 'prospect'));
    },
  };
}
