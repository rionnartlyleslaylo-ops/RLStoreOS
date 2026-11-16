create extension if not exists pgcrypto;

create table if not exists public.products (
  id text primary key,
  name text not null,
  unit text not null default 'PC',
  price numeric(14, 2) not null check (price >= 0),
  cost numeric(14, 4) not null check (cost >= 0),
  stock numeric(14, 3) check (stock is null or stock >= 0),
  minimum numeric(14, 3) check (minimum is null or minimum >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.customers (
  id text primary key,
  name text not null,
  balance numeric(14, 2) not null default 0 check (balance >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.sales (
  invoice text primary key,
  date date not null,
  created_at timestamptz not null default now(),
  customer_id text references public.customers(id) on delete restrict,
  customer text not null,
  payment text not null check (payment in ('Cash', 'GCash', 'Credit')),
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  total numeric(14, 2) not null check (total >= 0),
  gross_profit numeric(14, 2) not null,
  created_by uuid not null default auth.uid()
);

create index if not exists sales_date_created_at_idx on public.sales (date, created_at desc);
create index if not exists sales_customer_id_idx on public.sales (customer_id);

create table if not exists public.collections (
  id text primary key,
  date date not null,
  created_at timestamptz not null default now(),
  customer_id text not null references public.customers(id) on delete restrict,
  customer text not null,
  amount numeric(14, 2) not null check (amount > 0),
  payment_source text not null,
  receipt text,
  created_by uuid not null default auth.uid()
);

create index if not exists collections_date_idx on public.collections (date);
create index if not exists collections_customer_id_idx on public.collections (customer_id);

create table if not exists public.expenses (
  id text primary key,
  date date not null,
  created_at timestamptz not null default now(),
  category text not null,
  description text not null,
  amount numeric(14, 2) not null check (amount > 0),
  payment_source text not null,
  created_by uuid not null default auth.uid()
);

create index if not exists expenses_date_idx on public.expenses (date);

create table if not exists public.store_settings (
  id text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.products enable row level security;
alter table public.customers enable row level security;
alter table public.sales enable row level security;
alter table public.collections enable row level security;
alter table public.expenses enable row level security;
alter table public.store_settings enable row level security;

drop policy if exists products_authenticated_all on public.products;
create policy products_authenticated_all on public.products
  for all to authenticated using (true) with check (true);

drop policy if exists customers_authenticated_all on public.customers;
create policy customers_authenticated_all on public.customers
  for all to authenticated using (true) with check (true);

drop policy if exists sales_authenticated_all on public.sales;
create policy sales_authenticated_all on public.sales
  for all to authenticated using (true) with check (true);

drop policy if exists collections_authenticated_all on public.collections;
create policy collections_authenticated_all on public.collections
  for all to authenticated using (true) with check (true);

drop policy if exists expenses_authenticated_all on public.expenses;
create policy expenses_authenticated_all on public.expenses
  for all to authenticated using (true) with check (true);

drop policy if exists store_settings_authenticated_all on public.store_settings;
create policy store_settings_authenticated_all on public.store_settings
  for all to authenticated using (true) with check (true);

grant select, insert, update, delete on public.products to authenticated;
grant select, insert, update, delete on public.customers to authenticated;
grant select, insert, update, delete on public.sales to authenticated;
grant select, insert, update, delete on public.collections to authenticated;
grant select, insert, update, delete on public.expenses to authenticated;
grant select, insert, update, delete on public.store_settings to authenticated;

create sequence if not exists public.sales_invoice_seq;
create sequence if not exists public.customers_id_seq;
create sequence if not exists public.collections_id_seq;
grant usage, select on sequence public.sales_invoice_seq to authenticated;
grant usage, select on sequence public.customers_id_seq to authenticated;
grant usage, select on sequence public.collections_id_seq to authenticated;

create or replace function public.create_customer(p_name text)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_customer public.customers%rowtype;
  v_id text;
  v_sequence bigint;
begin
  if auth.uid() is null then
    raise exception 'Sign in before creating a customer.';
  end if;
  if nullif(trim(p_name), '') is null then
    raise exception 'Enter a customer name.';
  end if;

  loop
    v_sequence := nextval('public.customers_id_seq');
    v_id := 'C' || lpad(v_sequence::text, greatest(4, length(v_sequence::text)), '0');
    exit when not exists (select 1 from public.customers where id = v_id);
  end loop;

  insert into public.customers (id, name)
  values (v_id, trim(p_name))
  returning * into v_customer;
  return to_jsonb(v_customer);
end;
$$;

create or replace function public.record_sale(
  p_items jsonb,
  p_payment text,
  p_customer_id text,
  p_date date default current_date
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_product public.products%rowtype;
  v_sale public.sales%rowtype;
  v_items jsonb := '[]'::jsonb;
  v_quantity numeric(14, 3);
  v_line_total numeric(14, 2);
  v_total numeric(14, 2) := 0;
  v_cost numeric(18, 6) := 0;
  v_stock_deducted boolean;
  v_customer_name text := 'Walk-In';
  v_invoice text;
  v_sequence bigint;
begin
  if auth.uid() is null then
    raise exception 'Sign in before recording a sale.';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one product before completing a sale.';
  end if;
  if p_payment not in ('Cash', 'GCash', 'Credit') then
    raise exception 'Choose a valid payment method.';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_quantity := (v_item ->> 'quantity')::numeric;
    if v_quantity is null or v_quantity <= 0 then
      raise exception 'Sale quantities must be greater than zero.';
    end if;

    select * into v_product
      from public.products
      where id = v_item ->> 'productId'
      for update;
    if not found then
      raise exception 'Product % is no longer in Inventory.', v_item ->> 'productId';
    end if;
    if v_item ? 'price' and round((v_item ->> 'price')::numeric, 2) <> v_product.price then
      raise exception 'The price for % changed. Refresh the sale and try again.', v_product.name;
    end if;

    v_stock_deducted := v_product.stock is not null;
    if v_stock_deducted then
      if v_product.stock + 0.000000001 < v_quantity then
        raise exception 'Insufficient stock for %: % % available, % requested.',
          v_product.name, v_product.stock, v_product.unit, v_quantity;
      end if;
      update public.products
        set stock = greatest(0, round(v_product.stock - v_quantity, 3)),
            updated_at = now()
        where id = v_product.id;
    end if;

    v_line_total := round(v_product.price * v_quantity, 2);
    v_total := v_total + v_line_total;
    v_cost := v_cost + v_product.cost * v_quantity;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'productId', v_product.id,
      'name', v_product.name,
      'unit', v_product.unit,
      'quantity', v_quantity,
      'price', v_product.price,
      'cost', v_product.cost,
      'total', v_line_total,
      'stockDeducted', v_stock_deducted
    ));
  end loop;

  v_total := round(v_total, 2);
  if p_payment = 'Credit' then
    if p_customer_id is null or p_customer_id = '' then
      raise exception 'Select a customer before completing a credit sale.';
    end if;
    update public.customers
      set balance = balance + v_total
      where id = p_customer_id
      returning name into v_customer_name;
    if not found then
      raise exception 'The selected customer account is no longer available.';
    end if;
  elsif p_customer_id is not null and p_customer_id <> '' then
    raise exception 'Only credit sales may be assigned to a customer account.';
  end if;

  loop
    v_sequence := nextval('public.sales_invoice_seq');
    v_invoice := 'INV' || lpad(v_sequence::text, greatest(4, length(v_sequence::text)), '0');
    exit when not exists (select 1 from public.sales where invoice = v_invoice);
  end loop;

  insert into public.sales (
    invoice, date, customer_id, customer, payment, items, total, gross_profit
  )
  values (
    v_invoice,
    coalesce(p_date, current_date),
    case when p_payment = 'Credit' then p_customer_id else null end,
    v_customer_name,
    p_payment,
    v_items,
    v_total,
    round(v_total - v_cost, 2)
  )
  returning * into v_sale;

  return to_jsonb(v_sale);
end;
$$;

create or replace function public.record_collection(
  p_customer_id text,
  p_date date,
  p_amount numeric,
  p_payment_source text,
  p_receipt text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_customer public.customers%rowtype;
  v_collection public.collections%rowtype;
  v_id text;
  v_sequence bigint;
begin
  if auth.uid() is null then
    raise exception 'Sign in before recording a collection.';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter a valid collection amount.';
  end if;

  select * into v_customer
    from public.customers
    where id = p_customer_id
    for update;
  if not found then
    raise exception 'This customer is no longer available.';
  end if;
  if p_amount > v_customer.balance + 0.000000001 then
    raise exception 'Payment exceeds the customer outstanding balance.';
  end if;

  update public.customers
    set balance = greatest(0, round(balance - p_amount, 2))
    where id = v_customer.id;
  select * into v_customer from public.customers where id = v_customer.id;

  loop
    v_sequence := nextval('public.collections_id_seq');
    v_id := 'COL' || lpad(v_sequence::text, greatest(4, length(v_sequence::text)), '0');
    exit when not exists (select 1 from public.collections where id = v_id);
  end loop;

  insert into public.collections (
    id, date, customer_id, customer, amount, payment_source, receipt
  )
  values (
    v_id, coalesce(p_date, current_date), v_customer.id, v_customer.name,
    round(p_amount, 2), p_payment_source, nullif(p_receipt, '')
  )
  returning * into v_collection;

  return jsonb_build_object(
    'collection', to_jsonb(v_collection),
    'customer', to_jsonb(v_customer)
  );
end;
$$;

create or replace function public.import_device_data(
  p_products jsonb,
  p_customers jsonb,
  p_sales jsonb,
  p_collections jsonb,
  p_expenses jsonb,
  p_settings jsonb
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in before importing device data.';
  end if;
  if jsonb_typeof(p_products) <> 'array'
    or jsonb_typeof(p_customers) <> 'array'
    or jsonb_typeof(p_sales) <> 'array'
    or jsonb_typeof(p_collections) <> 'array'
    or jsonb_typeof(p_expenses) <> 'array' then
    raise exception 'Device data must contain product, customer, sale, collection, and expense lists.';
  end if;

  perform pg_advisory_xact_lock(726184029);
  if exists (select 1 from public.products limit 1)
    or exists (select 1 from public.customers limit 1)
    or exists (select 1 from public.sales limit 1)
    or exists (select 1 from public.collections limit 1)
    or exists (select 1 from public.expenses limit 1) then
    raise exception 'Import is allowed only while the shared store is empty.';
  end if;

  insert into public.products (id, name, unit, price, cost, stock, minimum, updated_at)
  select id, name, coalesce(unit, 'PC'), price, cost, stock, minimum, coalesce(updated_at, now())
  from jsonb_to_recordset(p_products) as item(
    id text, name text, unit text, price numeric, cost numeric,
    stock numeric, minimum numeric, updated_at timestamptz
  );

  insert into public.customers (id, name, balance, created_at)
  select id, name, balance, coalesce(created_at, now())
  from jsonb_to_recordset(p_customers) as item(
    id text, name text, balance numeric, created_at timestamptz
  );

  insert into public.sales (
    invoice, date, created_at, customer_id, customer, payment, items, total, gross_profit
  )
  select invoice, date, coalesce(created_at, now()), customer_id, coalesce(customer, 'Walk-In'),
    coalesce(payment, 'Cash'), coalesce(items, '[]'::jsonb), total, coalesce(gross_profit, 0)
  from jsonb_to_recordset(p_sales) as item(
    invoice text, date date, created_at timestamptz, customer_id text,
    customer text, payment text, items jsonb, total numeric, gross_profit numeric
  );

  insert into public.collections (
    id, date, created_at, customer_id, customer, amount, payment_source, receipt
  )
  select id, date, coalesce(created_at, now()), customer_id, customer, amount,
    coalesce(payment_source, 'Cash'), receipt
  from jsonb_to_recordset(p_collections) as item(
    id text, date date, created_at timestamptz, customer_id text,
    customer text, amount numeric, payment_source text, receipt text
  );

  insert into public.expenses (
    id, date, created_at, category, description, amount, payment_source
  )
  select id, date, coalesce(created_at, now()), category, coalesce(description, ''),
    amount, coalesce(payment_source, 'Cash')
  from jsonb_to_recordset(p_expenses) as item(
    id text, date date, created_at timestamptz, category text,
    description text, amount numeric, payment_source text
  );

  insert into public.store_settings (id, value)
  values ('store', coalesce(p_settings, '{}'::jsonb))
  on conflict (id) do update set value = excluded.value, updated_at = now();
end;
$$;

revoke all on function public.record_sale(jsonb, text, text, date) from public, anon;
revoke all on function public.create_customer(text) from public, anon;
revoke all on function public.record_collection(text, date, numeric, text, text) from public, anon;
revoke all on function public.import_device_data(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.record_sale(jsonb, text, text, date) to authenticated;
grant execute on function public.create_customer(text) to authenticated;
grant execute on function public.record_collection(text, date, numeric, text, text) to authenticated;
grant execute on function public.import_device_data(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) to authenticated;

-- Disable public sign-ups in Supabase Auth and invite only staff who should access this store.
-- The browser app must use the project's anon/public key, never the service_role key.
