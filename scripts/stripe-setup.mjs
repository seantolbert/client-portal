// Idempotently creates the portal's Stripe test-mode objects and prints the IDs
// to put in env vars. Refuses to run with a live key.
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY ?? '';
if (!/^(sk|rk)_test_/.test(key)) {
  console.error('Set STRIPE_SECRET_KEY to a TEST mode key.');
  process.exit(1);
}
const stripe = new Stripe(key);

const PRICES = [
  {
    env: 'STRIPE_PRICE_WEBSITE_FEE',
    lookup_key: 'portal_website_fee_v1',
    product: 'Website build fee',
    unit_amount: 100000,
  },
  {
    env: 'STRIPE_PRICE_MAINTENANCE',
    lookup_key: 'portal_maintenance_monthly_v1',
    product: 'Website maintenance plan',
    unit_amount: 10000,
    recurring: { interval: 'month' },
  },
];

const out = {};
for (const p of PRICES) {
  const existing = await stripe.prices.list({ lookup_keys: [p.lookup_key], limit: 1 });
  let price = existing.data[0];
  if (!price) {
    const product = await stripe.products.create({ name: p.product, metadata: { app: 'clientportal' } });
    price = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: p.unit_amount,
      lookup_key: p.lookup_key,
      ...(p.recurring ? { recurring: p.recurring } : {}),
    });
  }
  out[p.env] = price.id;
}

const configs = await stripe.billingPortal.configurations.list({ limit: 100 });
let portal = configs.data.find((c) => c.metadata?.app === 'clientportal' && c.active);
if (!portal) {
  portal = await stripe.billingPortal.configurations.create({
    metadata: { app: 'clientportal' },
    business_profile: { headline: 'Manage your billing' },
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
      customer_update: { enabled: true, allowed_updates: ['email', 'name', 'phone', 'address'] },
    },
  });
}
out.STRIPE_PORTAL_CONFIGURATION_ID = portal.id;

for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
