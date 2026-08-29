-- Buttercup ordering database
-- Run this in the Supabase SQL editor.

create extension if not exists pgcrypto;

do $$ begin
  create type public.order_payment_method as enum ('cafe', 'online');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.order_payment_status as enum ('pending', 'paid', 'failed', 'refunded');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.order_status as enum ('pending', 'confirmed', 'ready', 'collected', 'cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  description text,
  price_pence integer not null check (price_pence >= 0),
  image_url text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.collection_slots (
  id uuid primary key default gen_random_uuid(),
  collection_date date not null,
  start_time time not null,
  end_time time not null,
  capacity integer not null default 10 check (capacity > 0),
  reserved integer not null default 0 check (reserved >= 0),
  active boolean not null default true,
  unique (collection_date, start_time)
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text unique not null,
  customer_name text not null,
  customer_email text not null,
  customer_phone text not null,
  collection_slot_id uuid references public.collection_slots(id),
  collection_date date not null,
  collection_slot text not null,
  payment_method public.order_payment_method not null,
  payment_status public.order_payment_status not null default 'pending',
  order_status public.order_status not null default 'pending',
  currency text not null default 'gbp',
  total_pence integer not null check (total_pence >= 0),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_name text not null,
  quantity integer not null check (quantity > 0),
  unit_price_pence integer not null check (unit_price_pence >= 0),
  line_total_pence integer generated always as (quantity * unit_price_pence) stored
);

create index if not exists idx_orders_created_at on public.orders(created_at desc);
create index if not exists idx_orders_collection_date on public.orders(collection_date);
create index if not exists idx_order_items_order_id on public.order_items(order_id);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists orders_updated_at on public.orders;
create trigger orders_updated_at before update on public.orders
for each row execute function public.set_updated_at();

-- Seed the current demo menu. Prices are stored in pence.
insert into public.products (name, slug, description, price_pence, image_url)
values
  ('Classic Banana', 'classic-banana', 'Vanilla custard, whipped cream, sponge and fresh banana.', 550, 'https://offloadmedia.feverup.com/secretmanchester.com/wp-content/uploads/2026/08/25174518/37e4875d-980f-441c-a36f-fe5e9ba3bad4-768x1024.jpg'),
  ('Sticky Cornflake & Raspberry', 'sticky-cornflake-raspberry', 'Sweet crunch, creamy layers and raspberry.', 600, 'https://offloadmedia.feverup.com/secretmanchester.com/wp-content/uploads/2026/08/25174513/20251031_1245152-768x1024.jpeg'),
  ('Biscoff Tiramisu', 'biscoff-tiramisu', 'Creamy layers and a rich biscuit finish.', 600, 'https://offloadmedia.feverup.com/secretmanchester.com/wp-content/uploads/2026/08/25174508/20251031_1246012-768x1024.jpeg')
on conflict (slug) do update set name=excluded.name, description=excluded.description, price_pence=excluded.price_pence, image_url=excluded.image_url, active=true;

-- Public visitors should not directly read/write orders or customers.
-- The server-side Vercel API uses the Supabase service-role key and performs validation.
alter table public.products enable row level security;
alter table public.collection_slots enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

create policy "public can read active products"
on public.products for select to anon, authenticated
using (active = true);

create policy "public can read active collection slots"
on public.collection_slots for select to anon, authenticated
using (active = true);

-- No anon/authenticated insert/select/update/delete policies are intentionally added for orders.
-- Keep the service-role key exclusively in Vercel server environment variables.
