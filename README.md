# Client Portal

Multi-tenant billing portal for agency clients. Vanilla JS pages in `public/`, Vercel functions in `api/`, Supabase (auth + Postgres with RLS), Stripe, Resend. No build step.

The CRM creates clients via `POST /api/clients` (see `HANDOFF-CONTRACT.md`). Clients sign in by magic link; there is no self sign-up.

## Layout

| Path | What |
|---|---|
| `api/clients.js` | Handoff endpoint (HMAC, 300 s window, allowlist, idempotent on `prospect_id`). Creates the Stripe Customer and the client's auth user. Service role. |
| `api/stripe-webhook.js` | The only writer of billing state. Signature verified on raw bytes; idempotent on event ID. Service role. |
| `api/create-checkout.js` | Checkout for `website_fee` or `maintenance`. Client and price derived on the server. User JWT. |
| `api/billing-portal.js` | Stripe Customer Portal session. User JWT. |
| `api/admin/create-quote.js` | Admin-only: creates and finalizes a Stripe Invoice for an automation quote. User JWT + `is_admin()`. |
| `api/config.js` | Public browser config (Supabase URL + anon key). |
| `lib/` | Handler logic (`handoff.js`, `webhook.js`) and stores. `supabase-admin.js` is imported only by the two service-role stores. |
| `public/` | `index.html` (login), `dashboard.html`, `admin.html`. |
| `supabase/migrations/` | Schema, RLS, policies, handoff functions. |

## Develop

```sh
npm install
npx supabase start                      # local Supabase in Docker; applies migrations
# fill .env.local from .env.example (local keys: npx supabase status -o env)
npm run dev                             # http://localhost:3000 (or `vercel dev` once linked)
stripe listen --forward-to localhost:3000/api/stripe-webhook
```

Magic-link emails land in Mailpit at http://127.0.0.1:54324.

## Tests

```sh
npm test                                         # handoff contract, webhook, RLS (in-process Postgres)
HANDOFF_SECRET=... PORTAL_URL=... npm run smoke:handoff   # contract against a running portal
node --env-file=.env.local scripts/rls-live.mjs  # two real users against a Supabase project
STRIPE_SECRET_KEY=sk_test_... npm run stripe:setup        # idempotent Stripe test objects
```

## Making someone an admin

```sql
insert into public.admins (user_id) select id from auth.users where email = 'you@bernersystems.com';
```
