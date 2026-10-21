// POST /api/clients, per HANDOFF-CONTRACT.md v1.0.
// Pure logic plus a handler factory so tests can inject the store and Stripe.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { json, readRawBody } from './http.js';

export const MAX_SKEW_SECONDS = 300;

const FIELDS = {
  prospect_id: { required: true, max: 128 },
  business_name: { required: true, max: 200 },
  contact_name: { required: false, max: 200 },
  email: { required: true, max: 254 },
  phone: { required: false, max: 32 },
  address: { required: false, max: 500 },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function sign(secret, timestamp, rawBody) {
  return createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(rawBody)]))
    .digest('hex');
}

export function verifyRequest({ secret, timestamp, signature, rawBody, nowSeconds }) {
  if (!timestamp || !signature) return 'missing_headers';
  if (!/^\d{1,12}$/.test(timestamp)) return 'bad_timestamp';
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) return 'stale_timestamp';
  if (!/^[0-9a-f]{64}$/.test(signature)) return 'bad_signature';
  const expected = Buffer.from(sign(secret, timestamp, rawBody), 'hex');
  const given = Buffer.from(signature, 'hex');
  if (!timingSafeEqual(expected, given)) return 'bad_signature';
  return null;
}

export function validateBody(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { fields: { body: 'invalid_json' } };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { fields: { body: 'must_be_object' } };
  }

  const fields = {};
  const value = {};
  for (const key of Object.keys(body)) {
    if (!Object.hasOwn(FIELDS, key)) fields[key] = 'unknown_field';
  }
  for (const [key, rule] of Object.entries(FIELDS)) {
    const v = body[key];
    if (v === undefined || v === null) {
      if (rule.required) fields[key] = 'required';
      else value[key] = null;
      continue;
    }
    if (typeof v !== 'string') fields[key] = 'must_be_string';
    else if (rule.required && v.trim() === '') fields[key] = 'required';
    else if (v.length > rule.max) fields[key] = `max_length_${rule.max}`;
    else if (key === 'email' && !EMAIL_RE.test(v)) fields[key] = 'invalid_email';
    else if (key === 'address' && /[\r\n]/.test(v)) fields[key] = 'must_be_single_line';
    else value[key] = v;
  }
  return Object.keys(fields).length ? { fields } : { value };
}

/**
 * deps:
 *   secret      HANDOFF_SECRET
 *   store       { createClient(fields), setStripeCustomer(clientId, customerId), linkMember(clientId, email) }
 *   stripe      Stripe instance (customers.create is used)
 *   onProvisioned optional async (client) => void, called once the Stripe customer
 *               exists and the member is linked (e.g. welcome email)
 *   log         (fields) => void
 *   now         () => ms since epoch
 */
export function createHandoffHandler({ secret, store, stripe, onProvisioned, log, now = Date.now }) {
  return async function handle(request) {
    const rawBody = await readRawBody(request);
    const reason = verifyRequest({
      secret,
      timestamp: request.headers.get('x-handoff-timestamp'),
      signature: request.headers.get('x-handoff-signature'),
      rawBody,
      nowSeconds: Math.floor(now() / 1000),
    });
    if (reason) {
      log({ msg: 'handoff', outcome: 'rejected', reason, prospect_id: null });
      return json(401, { error: 'unauthorized' });
    }

    const { value, fields } = validateBody(rawBody);
    if (fields) {
      log({ msg: 'handoff', outcome: 'rejected', reason: 'validation_failed', fields: Object.keys(fields) });
      return json(400, { error: 'validation_failed', fields });
    }

    const prospectId = value.prospect_id;
    try {
      const client = await store.createClient(value);

      // Runs on replays too, so a retry finishes a handoff that failed partway.
      // The original record's fields are used; a replay never overwrites them.
      const needsCustomer = !client.stripe_customer_id;
      if (needsCustomer) {
        const customer = await stripe.customers.create(
          {
            email: client.email,
            name: client.business_name,
            phone: client.phone ?? undefined,
            metadata: { client_id: client.client_id, prospect_id: prospectId },
          },
          { idempotencyKey: `handoff-customer-${client.client_id}` },
        );
        await store.setStripeCustomer(client.client_id, customer.id);
      }
      await store.linkMember(client.client_id, client.email);

      if (needsCustomer && onProvisioned) await onProvisioned(client);

      log({ msg: 'handoff', outcome: client.created ? 'created' : 'existing', prospect_id: prospectId });
      return json(client.created ? 201 : 200, { client_id: client.client_id, created: client.created });
    } catch (err) {
      log({ msg: 'handoff', outcome: 'rejected', reason: 'internal', error: err.message, prospect_id: prospectId });
      return json(500, { error: 'internal' });
    }
  };
}
