// Server-defined catalog. The browser sends only a product key; price IDs and
// amounts never come from the client.
export const PRODUCTS = {
  website_fee: { priceEnv: 'STRIPE_PRICE_WEBSITE_FEE', mode: 'payment', label: 'Website build fee' },
  maintenance: { priceEnv: 'STRIPE_PRICE_MAINTENANCE', mode: 'subscription', label: 'Maintenance plan' },
};

export const LIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due', 'incomplete', 'unpaid'];
