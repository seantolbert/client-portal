import { requireClientMember, errorResponse, HttpError } from '../lib/auth.js';
import { PRODUCTS, LIVE_SUBSCRIPTION_STATUSES } from '../lib/products.js';
import { getStripe } from '../lib/stripe.js';
import { json, log, requireEnv } from '../lib/http.js';

export async function POST(request) {
  try {
    const { db, client } = await requireClientMember(request);

    let body;
    try {
      body = await request.json();
    } catch {
      throw new HttpError(400, 'invalid_json');
    }
    const key = body?.product;
    const product = typeof key === 'string' && Object.hasOwn(PRODUCTS, key) ? PRODUCTS[key] : null;
    if (!product) throw new HttpError(400, 'unknown_product');

    // Guard against paying twice. Reads go through RLS as the user.
    if (product.mode === 'subscription') {
      const { data, error } = await db
        .from('subscriptions')
        .select('id')
        .eq('client_id', client.id)
        .in('status', LIVE_SUBSCRIPTION_STATUSES)
        .limit(1);
      if (error) throw new Error(`load subscriptions: ${error.message}`);
      if (data.length) throw new HttpError(409, 'already_subscribed');
    } else {
      const { data, error } = await db
        .from('payments')
        .select('id')
        .eq('client_id', client.id)
        .eq('product', key)
        .limit(1);
      if (error) throw new Error(`load payments: ${error.message}`);
      if (data.length) throw new HttpError(409, 'already_paid');
    }

    const appUrl = requireEnv('APP_URL');
    const metadata = { client_id: client.id, product: key };
    const session = await getStripe().checkout.sessions.create({
      mode: product.mode,
      customer: client.stripe_customer_id,
      client_reference_id: client.id,
      line_items: [{ price: requireEnv(product.priceEnv), quantity: 1 }],
      metadata,
      ...(product.mode === 'payment'
        ? { payment_intent_data: { metadata } }
        : { subscription_data: { metadata } }),
      success_url: `${appUrl}/dashboard?checkout=success&product=${key}`,
      cancel_url: `${appUrl}/dashboard?checkout=cancelled`,
    });
    return json(200, { url: session.url });
  } catch (err) {
    return errorResponse(err, log);
  }
}
