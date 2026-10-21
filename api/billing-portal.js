import { requireClientMember, errorResponse } from '../lib/auth.js';
import { getStripe } from '../lib/stripe.js';
import { json, log, requireEnv } from '../lib/http.js';

export async function POST(request) {
  try {
    const { client } = await requireClientMember(request);
    const session = await getStripe().billingPortal.sessions.create({
      customer: client.stripe_customer_id,
      return_url: `${requireEnv('APP_URL')}/dashboard`,
      ...(process.env.STRIPE_PORTAL_CONFIGURATION_ID
        ? { configuration: process.env.STRIPE_PORTAL_CONFIGURATION_ID }
        : {}),
    });
    return json(200, { url: session.url });
  } catch (err) {
    return errorResponse(err, log);
  }
}
