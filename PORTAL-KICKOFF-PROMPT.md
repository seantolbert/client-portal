# Kickoff: Client Portal (multi-tenant)

You are building a new project from scratch: a multi-tenant client portal for web agency clients. Clients log in to pay invoices, manage the $100/mo maintenance subscription, and see their billing history. Stripe is the payment system.

## Read first

1. `HANDOFF-CONTRACT.md` in this repo. The `POST /api/clients` endpoint must match it exactly: signing, field allowlist, responses, and idempotency. Do not deviate from it.
2. `BUILD-SPEC.md` in this repo, if present. Treat it as the source for the schema and flows.

## Stack

- Vanilla JavaScript, single-file HTML pages where practical, no build step unless a dependency truly needs one.
- Supabase for auth (magic link for clients) and Postgres. Row Level Security on every table.
- Vercel for hosting and serverless functions.
- Stripe for payments: Checkout for the $1,000 website fee, Invoices for custom automation quotes, Subscriptions for the $100/mo maintenance plan, and the Customer Portal for billing history and payment methods.
- Resend for transactional email only, from a `billing@` address on `mail.bernersystems.com`.

## Data model

- `clients`: `id` (uuid), `prospect_id` (text, unique, not null), `business_name`, `contact_name`, `email`, `phone`, `address`, `stripe_customer_id` (unique, nullable), `status` (`prospect`, `active`, `churned`), `created_at`.
- `client_members`: `user_id` (references auth.users), `client_id`, `role`. Primary key on (`user_id`, `client_id`).
- `invoices`, `subscriptions`, `payments`: mirrors of Stripe objects, each with `client_id`. Written only from verified webhooks.
- `engagements` (optional for v1): project status for website and automation work.

## Security requirements (non-negotiable)

- RLS enabled on all tables. Clients read only rows linked to them through `client_members`. The admin role is separate and explicit.
- The browser never supplies `client_id` or any price. The server derives both.
- Service role key used only in the webhook handler and the handoff endpoint. Everywhere else, use the user's JWT so RLS applies.
- Stripe webhook: verify the signature on the raw body. Disable Vercel's JSON body parsing for that route.
- Payment state comes only from verified webhooks, never from the return URL after Checkout.
- Secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `HANDOFF_SECRET`, `RESEND_API_KEY`, Supabase keys) live only in Vercel env vars. Provide `.env.example` with placeholders.

## Endpoints

- `POST /api/clients`: the handoff endpoint from the contract. Implements the 300-second timestamp window, field allowlist (unknown fields are 400), HMAC verification in constant time, and idempotency via the unique constraint on `clients.prospect_id`. On create, also creates the Stripe Customer with `metadata.client_id`.
- `POST /api/create-checkout`: for the logged-in client, creates a Checkout session for a server-defined price ID.
- `POST /api/billing-portal`: creates a Customer Portal session for the logged-in client's Stripe customer.
- `POST /api/stripe-webhook`: handles `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, and `customer.subscription.deleted`. Idempotent on Stripe event ID.

## Stripe setup

- One Product and Price for the website fee ($1,000 one-time), one for maintenance ($100/mo recurring). Create them in test mode and read the price IDs from env.
- One Customer Portal configuration allowing invoice history, payment method updates, and subscription cancellation.
- Automation quotes are created as Stripe Invoices server-side from an admin action.

## Done when

- The handoff test passes: a fixture payload signed with the contract scheme is accepted (201), replayed (200 with the same `client_id`), and rejected with a stale timestamp or bad signature (401).
- A test client can log in by magic link, see only their own invoices, and open the Customer Portal.
- A test Checkout for $1,000 completes via the Stripe test card, and the webhook marks the payment in Supabase.
- A second client cannot read the first client's rows (RLS test with two users).
- A short list at the end: what was built, env vars needed, and what to set up in the Stripe dashboard.
