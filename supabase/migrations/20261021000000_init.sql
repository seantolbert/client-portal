-- Client portal v1 schema.
-- Every table has RLS enabled in this migration. Clients read only rows linked
-- to them through client_members. Admins are listed explicitly in public.admins.
-- Billing mirrors (invoices, subscriptions, payments) have no write policies:
-- only the service role (webhook handler) writes them.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  prospect_id text not null unique check (char_length(prospect_id) between 1 and 128),
  business_name text not null check (char_length(business_name) between 1 and 200),
  contact_name text check (char_length(contact_name) <= 200),
  email text not null check (char_length(email) <= 254),
  phone text check (char_length(phone) <= 32),
  address text check (char_length(address) <= 500),
  stripe_customer_id text unique,
  status text not null default 'prospect' check (status in ('prospect', 'active', 'churned')),
  created_at timestamptz not null default now()
);
alter table public.clients enable row level security;

create table public.client_members (
  user_id uuid not null references auth.users (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (user_id, client_id)
);
alter table public.client_members enable row level security;
create index client_members_client_id_idx on public.client_members (client_id);

create table public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  stripe_invoice_id text not null unique,
  stripe_subscription_id text,
  number text,
  description text,
  status text,
  currency text not null,
  amount_due bigint not null,
  amount_paid bigint not null,
  hosted_invoice_url text,
  invoice_pdf text,
  due_date timestamptz,
  stripe_created_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.invoices enable row level security;
create index invoices_client_id_idx on public.invoices (client_id);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  stripe_subscription_id text not null unique,
  status text not null,
  price_id text,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  stripe_created_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
create index subscriptions_client_id_idx on public.subscriptions (client_id);

-- One row per successful payment. stripe_source_id is the PaymentIntent ID for
-- Checkout payments and the Invoice ID for paid invoices.
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  stripe_source_id text not null unique,
  source text not null check (source in ('checkout', 'invoice')),
  product text,
  description text,
  amount bigint not null,
  currency text not null,
  status text not null,
  paid_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.payments enable row level security;
create index payments_client_id_idx on public.payments (client_id);

create table public.engagements (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  kind text not null check (kind in ('website', 'automation')),
  title text not null,
  status text not null default 'planned' check (status in ('planned', 'in_progress', 'review', 'done')),
  updated_at timestamptz not null default now()
);
alter table public.engagements enable row level security;
create index engagements_client_id_idx on public.engagements (client_id);

-- Processed Stripe event IDs, for webhook idempotency. Service role only.
create table public.stripe_events (
  id text primary key,
  type text not null,
  processed_at timestamptz not null default now()
);
alter table public.stripe_events enable row level security;

-- ---------------------------------------------------------------------------
-- Helper functions for policies (security definer avoids policy recursion)
-- ---------------------------------------------------------------------------

create function public.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.admins where user_id = (select auth.uid()));
$$;

create function public.is_member(p_client_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.client_members
    where client_id = p_client_id and user_id = (select auth.uid())
  );
$$;

revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.is_member(uuid) from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Grants: authenticated users may only read; anon gets nothing.
-- ---------------------------------------------------------------------------

revoke all on public.clients, public.client_members, public.admins, public.invoices,
  public.subscriptions, public.payments, public.engagements, public.stripe_events
  from anon, authenticated;

grant select on public.clients, public.client_members, public.invoices,
  public.subscriptions, public.payments, public.engagements
  to authenticated;

grant all on public.clients, public.client_members, public.admins, public.invoices,
  public.subscriptions, public.payments, public.engagements, public.stripe_events
  to service_role;

-- ---------------------------------------------------------------------------
-- Policies (read-only; no insert/update/delete policies for clients)
-- ---------------------------------------------------------------------------

create policy "members and admins read clients" on public.clients
  for select to authenticated
  using (public.is_member(id) or public.is_admin());

create policy "users read own memberships, admins read all" on public.client_members
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

create policy "members and admins read invoices" on public.invoices
  for select to authenticated
  using (public.is_member(client_id) or public.is_admin());

create policy "members and admins read subscriptions" on public.subscriptions
  for select to authenticated
  using (public.is_member(client_id) or public.is_admin());

create policy "members and admins read payments" on public.payments
  for select to authenticated
  using (public.is_member(client_id) or public.is_admin());

create policy "members and admins read engagements" on public.engagements
  for select to authenticated
  using (public.is_member(client_id) or public.is_admin());

-- admins and stripe_events: RLS on, no policies, no grants to anon/authenticated.

-- ---------------------------------------------------------------------------
-- Handoff functions (service role only)
-- ---------------------------------------------------------------------------

-- Insert a client keyed on prospect_id. On conflict the original row is kept
-- untouched and returned with created = false.
create function public.handoff_create_client(
  p_prospect_id text,
  p_business_name text,
  p_contact_name text,
  p_email text,
  p_phone text,
  p_address text
)
returns table (
  client_id uuid,
  created boolean,
  stripe_customer_id text,
  business_name text,
  contact_name text,
  email text,
  phone text
)
language plpgsql security invoker set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.clients (prospect_id, business_name, contact_name, email, phone, address)
  values (p_prospect_id, p_business_name, p_contact_name, p_email, p_phone, p_address)
  on conflict (prospect_id) do nothing
  returning public.clients.id into v_id;

  return query
    select c.id, v_id is not null, c.stripe_customer_id, c.business_name,
           c.contact_name, c.email, c.phone
    from public.clients c
    where c.prospect_id = p_prospect_id;
end;
$$;

-- Link the auth user with this email (created beforehand via the admin API)
-- to the client as owner. Idempotent.
create function public.handoff_link_member(p_client_id uuid, p_email text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  select id into v_user_id from auth.users where lower(email) = lower(p_email) limit 1;
  if v_user_id is null then
    raise exception 'no auth user for client email';
  end if;
  insert into public.client_members (user_id, client_id, role)
  values (v_user_id, p_client_id, 'owner')
  on conflict do nothing;
  return v_user_id;
end;
$$;

revoke execute on function public.handoff_create_client(text, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.handoff_link_member(uuid, text) from public, anon, authenticated;
grant execute on function public.handoff_create_client(text, text, text, text, text, text) to service_role;
grant execute on function public.handoff_link_member(uuid, text) to service_role;
