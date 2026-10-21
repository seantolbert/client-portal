import { createHandoffHandler } from '../lib/handoff.js';
import { createHandoffStore } from '../lib/handoff-store.js';
import { getStripe } from '../lib/stripe.js';
import { sendEmail } from '../lib/email.js';
import { json, log, requireEnv } from '../lib/http.js';

let handler;

export async function POST(request) {
  try {
    handler ??= createHandoffHandler({
      secret: requireEnv('HANDOFF_SECRET'),
      store: createHandoffStore(),
      stripe: getStripe(),
      log,
      onProvisioned: (client) =>
        sendEmail({
          to: client.email,
          subject: 'Your client portal is ready',
          text:
            `Hi${client.contact_name ? ` ${client.contact_name}` : ''},\n\n` +
            `Your billing portal for ${client.business_name} is ready. Sign in with this email address at ` +
            `${requireEnv('APP_URL')}/ to pay invoices, manage your maintenance plan, and see billing history.\n`,
        }),
    });
  } catch (err) {
    log({ msg: 'handoff', outcome: 'rejected', reason: 'config', error: err.message });
    return json(500, { error: 'internal' });
  }
  return handler(request);
}
