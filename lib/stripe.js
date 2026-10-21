import Stripe from 'stripe';
import { requireEnv } from './http.js';

let stripe;

export function getStripe() {
  stripe ??= new Stripe(requireEnv('STRIPE_SECRET_KEY'));
  return stripe;
}
