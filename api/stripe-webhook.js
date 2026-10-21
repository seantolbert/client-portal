import { createWebhookHandler } from '../lib/webhook.js';
import { createWebhookStore } from '../lib/webhook-store.js';
import { getStripe } from '../lib/stripe.js';
import { sendEmail } from '../lib/email.js';
import { json, log, requireEnv } from '../lib/http.js';

// Web-standard handler: Vercel does not parse the body, so the signature is
// verified against the exact raw bytes Stripe sent.
let handler;

export async function POST(request) {
  try {
    handler ??= createWebhookHandler({
      stripe: getStripe(),
      webhookSecret: requireEnv('STRIPE_WEBHOOK_SECRET'),
      store: createWebhookStore(),
      notify: sendEmail,
      log,
    });
  } catch (err) {
    log({ msg: 'webhook', outcome: 'failed', reason: 'config', error: err.message });
    return json(500, { error: 'internal' });
  }
  return handler(request);
}
