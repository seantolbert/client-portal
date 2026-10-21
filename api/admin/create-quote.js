// Admin action: create and finalize a Stripe Invoice for a custom automation quote.
// Runs as the admin user (RLS applies); the invoice mirror is written by the webhook.
import { requireAdmin, errorResponse, HttpError } from '../../lib/auth.js';
import { getStripe } from '../../lib/stripe.js';
import { json, log } from '../../lib/http.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request) {
  try {
    const { user, db } = await requireAdmin(request);

    let body;
    try {
      body = await request.json();
    } catch {
      throw new HttpError(400, 'invalid_json');
    }
    const { client_id, description, amount_cents, days_until_due = 14, request_id } = body ?? {};
    if (typeof client_id !== 'string' || !UUID_RE.test(client_id)) throw new HttpError(400, 'invalid_client_id');
    if (typeof description !== 'string' || !description.trim() || description.length > 500) {
      throw new HttpError(400, 'invalid_description');
    }
    if (!Number.isInteger(amount_cents) || amount_cents < 100 || amount_cents > 10_000_000) {
      throw new HttpError(400, 'invalid_amount');
    }
    if (!Number.isInteger(days_until_due) || days_until_due < 1 || days_until_due > 90) {
      throw new HttpError(400, 'invalid_days_until_due');
    }
    if (typeof request_id !== 'string' || !UUID_RE.test(request_id)) throw new HttpError(400, 'invalid_request_id');

    const { data: client, error } = await db
      .from('clients')
      .select('id, stripe_customer_id')
      .eq('id', client_id)
      .maybeSingle();
    if (error) throw new Error(`load client: ${error.message}`);
    if (!client) throw new HttpError(404, 'client_not_found');
    if (!client.stripe_customer_id) throw new HttpError(409, 'billing_not_ready');

    const stripe = getStripe();
    const metadata = { client_id: client.id, kind: 'automation_quote', created_by: user.id };
    const invoice = await stripe.invoices.create(
      {
        customer: client.stripe_customer_id,
        collection_method: 'send_invoice',
        days_until_due,
        description,
        metadata,
      },
      { idempotencyKey: `quote-${request_id}` },
    );
    await stripe.invoiceItems.create(
      { customer: client.stripe_customer_id, invoice: invoice.id, amount: amount_cents, currency: 'usd', description },
      { idempotencyKey: `quote-item-${request_id}` },
    );
    const finalized = await stripe.invoices.finalizeInvoice(invoice.id, {}, { idempotencyKey: `quote-finalize-${request_id}` });

    log({ msg: 'quote_created', client_id: client.id, invoice: finalized.id });
    return json(201, { invoice_id: finalized.id, hosted_invoice_url: finalized.hosted_invoice_url });
  } catch (err) {
    return errorResponse(err, log);
  }
}
