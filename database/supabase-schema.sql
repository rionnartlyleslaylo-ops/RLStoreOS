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

create table if not exists public.sale_voids (
  id text primary key,
  invoice text not null references public.sales(invoice) on delete restrict,
  date date not null default current_date,
  created_at timestamptz not null default now(),
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  reason text not null,
  amount numeric(14, 2) not null check (amount >= 0),
  receivable_reduction numeric(14, 2) not null default 0 check (receivable_reduction >= 0),
  refund_amount numeric(14, 2) not null default 0 check (refund_amount >= 0),
  refund_method text check (refund_method in ('Cash', 'GCash', 'Bank transfer', 'Other')),
  created_by uuid not null default auth.uid()
);

create index if not exists sale_voids_invoice_created_at_idx on public.sale_voids (invoice, created_at);
create index if not exists sale_voids_date_idx on public.sale_voids (date);

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
alter table public.sale_voids enable row level security;
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

drop policy if exists sale_voids_authenticated_select on public.sale_voids;
create policy sale_voids_authenticated_select on public.sale_voids
  for select to authenticated using (true);

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
revoke all on public.sale_voids from public, anon, authenticated;
grant select on public.sale_voids to authenticated;
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
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
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

create or replace function public.record_sale_void(
  p_id text,
  p_invoice text,
  p_items jsonb,
  p_reason text,
  p_refund_amount numeric,
  p_refund_method text,
  p_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale public.sales%rowtype;
  v_customer public.customers%rowtype;
  v_void public.sale_voids%rowtype;
  v_request jsonb;
  v_sale_item jsonb;
  v_void_items jsonb := '[]'::jsonb;
  v_seen_indices integer[] := '{}';
  v_line_index integer;
  v_quantity numeric(14, 3);
  v_price numeric(14, 2);
  v_line_total numeric(14, 2);
  v_existing_voided_quantity numeric(14, 3);
  v_total numeric(14, 2) := 0;
  v_expected_refund numeric(14, 2);
  v_receivable_reduction numeric(14, 2) := 0;
  v_product public.products%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in before recording a sale void.';
  end if;
  if nullif(trim(p_id), '') is null or nullif(trim(p_invoice), '') is null then
    raise exception 'A void record needs an ID and invoice.';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Select at least one item quantity to void.';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'Enter a reason for the void.';
  end if;
  if char_length(trim(p_reason)) > 300 then
    raise exception 'The void reason must be 300 characters or fewer.';
  end if;
  if p_refund_amount is null or p_refund_amount < 0 then
    raise exception 'Enter a valid refund amount.';
  end if;

  select * into v_sale
    from public.sales
    where invoice = p_invoice
    for update;
  if not found then
    raise exception 'This sale could not be found.';
  end if;

  for v_request in select value from jsonb_array_elements(p_items)
  loop
    if coalesce(v_request ->> 'lineIndex', '') !~ '^[0-9]+$' then
      raise exception 'A sale item reference is invalid.';
    end if;
    v_line_index := (v_request ->> 'lineIndex')::integer;
    if v_line_index < 0 or v_line_index >= jsonb_array_length(v_sale.items) then
      raise exception 'A selected sale item no longer exists.';
    end if;
    if v_line_index = any(v_seen_indices) then
      raise exception 'A sale item may appear only once in a void request.';
    end if;
    v_seen_indices := array_append(v_seen_indices, v_line_index);

    v_sale_item := v_sale.items -> v_line_index;
    if (v_request ->> 'productId') is distinct from (v_sale_item ->> 'productId') then
      raise exception 'A selected sale item no longer matches the original invoice.';
    end if;
    v_quantity := (v_request ->> 'quantity')::numeric;
    if v_quantity is null or v_quantity <= 0 then
      raise exception 'Void quantities must be greater than zero.';
    end if;
    v_existing_voided_quantity := coalesce((
      select sum((void_item ->> 'quantity')::numeric)
        from public.sale_voids existing_void
        cross join lateral jsonb_array_elements(existing_void.items) as void_item
        where existing_void.invoice = p_invoice
          and (void_item ->> 'lineIndex')::integer = v_line_index
    ), 0);
    if v_existing_voided_quantity + v_quantity >
      (v_sale_item ->> 'quantity')::numeric + 0.000000001 then
      raise exception 'The selected quantity exceeds the amount remaining on the invoice.';
    end if;

    v_price := coalesce(
      nullif(v_sale_item ->> 'price', '')::numeric,
      nullif(v_sale_item ->> 'sellingPrice', '')::numeric
    );
    if v_price is null or v_price < 0 then
      raise exception 'The original sale item has an invalid price.';
    end if;
    v_line_total := round(v_price * v_quantity, 2);
    v_total := v_total + v_line_total;
    v_void_items := v_void_items || jsonb_build_array(jsonb_build_object(
      'lineIndex', v_line_index,
      'productId', v_sale_item ->> 'productId',
      'name', v_sale_item ->> 'name',
      'unit', v_sale_item ->> 'unit',
      'quantity', v_quantity,
      'price', v_price,
      'cost', coalesce(nullif(v_sale_item ->> 'cost', '')::numeric, 0),
      'total', v_line_total,
      'stockRestored', coalesce((v_sale_item ->> 'stockDeducted')::boolean, false)
    ));

    if coalesce((v_sale_item ->> 'stockDeducted')::boolean, false) then
      select * into v_product
        from public.products
        where id = v_sale_item ->> 'productId'
        for update;
      if not found or v_product.stock is null then
        raise exception 'Inventory stock for % must be entered before this return can be recorded.',
          coalesce(v_sale_item ->> 'name', v_sale_item ->> 'productId');
      end if;
      update public.products
        set stock = round(v_product.stock + v_quantity, 3),
            updated_at = now()
        where id = v_product.id;
    end if;
  end loop;

  v_total := round(v_total, 2);
  if v_sale.payment = 'Credit' then
    if v_sale.customer_id is null then
      raise exception 'This credit sale has no linked customer account.';
    end if;
    select * into v_customer
      from public.customers
      where id = v_sale.customer_id
      for update;
    if not found then
      raise exception 'The customer account for this credit sale is unavailable.';
    end if;
    v_receivable_reduction := least(v_customer.balance, v_total);
    v_expected_refund := round(v_total - v_receivable_reduction, 2);
    update public.customers
      set balance = greatest(0, round(balance - v_receivable_reduction, 2))
      where id = v_customer.id;
  else
    v_expected_refund := v_total;
  end if;

  if round(p_refund_amount, 2) <> v_expected_refund then
    raise exception 'The required refund changed. Refresh shared data and review the void again.';
  end if;
  if v_expected_refund > 0 then
    if p_refund_method is null or p_refund_method not in ('Cash', 'GCash', 'Bank transfer', 'Other') then
      raise exception 'Choose how the customer was refunded.';
    end if;
  elsif nullif(trim(coalesce(p_refund_method, '')), '') is not null then
    raise exception 'A refund method is not needed when no money is refunded.';
  end if;

  insert into public.sale_voids (
    id, invoice, date, items, reason, amount,
    receivable_reduction, refund_amount, refund_method
  )
  values (
    trim(p_id), trim(p_invoice), coalesce(p_date, current_date), v_void_items, trim(p_reason), v_total,
    v_receivable_reduction, v_expected_refund,
    case when v_expected_refund > 0 then p_refund_method else null end
  )
  returning * into v_void;

  return to_jsonb(v_void);
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
  p_settings jsonb,
  p_sale_voids jsonb
)
returns void
language plpgsql
security definer
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
    or jsonb_typeof(p_expenses) <> 'array'
    or jsonb_typeof(p_sale_voids) <> 'array' then
    raise exception 'Device data must contain product, customer, sale, void, collection, and expense lists.';
  end if;

  perform pg_advisory_xact_lock(726184029);
  if exists (select 1 from public.products limit 1)
    or exists (select 1 from public.customers limit 1)
    or exists (select 1 from public.sales limit 1)
    or exists (select 1 from public.sale_voids limit 1)
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

  insert into public.sale_voids (
    id, invoice, date, created_at, items, reason, amount,
    receivable_reduction, refund_amount, refund_method
  )
  select id, invoice, date, coalesce(created_at, now()), items, reason, amount,
    coalesce(receivable_reduction, 0), coalesce(refund_amount, 0), refund_method
  from jsonb_to_recordset(p_sale_voids) as item(
    id text, invoice text, date date, created_at timestamptz, items jsonb,
    reason text, amount numeric, receivable_reduction numeric, refund_amount numeric,
    refund_method text
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
revoke all on function public.record_sale_void(text, text, jsonb, text, numeric, text, date) from public, anon;
revoke all on function public.create_customer(text) from public, anon;
revoke all on function public.record_collection(text, date, numeric, text, text) from public, anon;
revoke all on function public.import_device_data(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.record_sale(jsonb, text, text, date) to authenticated;
grant execute on function public.record_sale_void(text, text, jsonb, text, numeric, text, date) to authenticated;
grant execute on function public.create_customer(text) to authenticated;
grant execute on function public.record_collection(text, date, numeric, text, text) to authenticated;
grant execute on function public.import_device_data(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) to authenticated;

-- Disable public sign-ups in Supabase Auth and invite only staff who should access this store.
-- The browser app must use the project's anon/public key, never the service_role key.

-- Finance management schema; keep this section aligned with finance-management-migration.sql.
-- Run once in Supabase SQL Editor to enable cash, fund, purchase, and closing records.

create table if not exists public.fund_openings (
  id integer primary key default 1 check (id = 1),
  effective_date date not null,
  cash_balance numeric(14, 2) not null default 0 check (cash_balance >= 0),
  gcash_balance numeric(14, 2) not null default 0 check (gcash_balance >= 0),
  revolving_balance numeric(14, 2) not null default 0 check (revolving_balance >= 0),
  savings_balance numeric(14, 2) not null default 0 check (savings_balance >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid not null default auth.uid()
);

create table if not exists public.fund_opening_history (
  id uuid primary key default gen_random_uuid(),
  effective_date date not null,
  previous_balances jsonb,
  new_balances jsonb not null,
  reason text not null,
  changed_at timestamptz not null default now(),
  changed_by uuid not null default auth.uid()
);

create table if not exists public.fund_transactions (
  id text primary key,
  reference text not null unique,
  transaction_date date not null,
  transaction_type text not null check (transaction_type in (
    'other_in', 'other_out', 'cash_drop', 'transfer',
    'gcash_in', 'gcash_out', 'stock_purchase'
  )),
  from_account text check (from_account in ('cash', 'gcash', 'revolving', 'savings')),
  to_account text check (to_account in ('cash', 'gcash', 'revolving', 'savings')),
  amount numeric(14, 2) not null check (amount > 0),
  description text not null,
  related_reference text,
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid(),
  check (from_account is distinct from to_account)
);

create index if not exists fund_transactions_date_created_idx
  on public.fund_transactions (transaction_date desc, created_at desc);
create index if not exists fund_transactions_from_account_date_idx
  on public.fund_transactions (from_account, transaction_date);
create index if not exists fund_transactions_to_account_date_idx
  on public.fund_transactions (to_account, transaction_date);

create table if not exists public.stock_purchases (
  id text primary key,
  reference text not null unique,
  transaction_date date not null,
  supplier text not null default '',
  description text not null,
  payment_account text not null check (payment_account in ('cash', 'gcash', 'revolving', 'savings')),
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0),
  total numeric(14, 2) not null check (total > 0),
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid()
);

create index if not exists stock_purchases_date_idx
  on public.stock_purchases (transaction_date desc, created_at desc);

create table if not exists public.daily_cash_closings (
  closing_date date primary key,
  expected_cash numeric(14, 2) not null check (expected_cash >= 0),
  actual_cash numeric(14, 2) not null check (actual_cash >= 0),
  difference numeric(14, 2) not null,
  breakdown jsonb not null default '{}'::jsonb,
  notes text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid not null default auth.uid()
);

create table if not exists public.daily_cash_closing_history (
  id uuid primary key default gen_random_uuid(),
  closing_date date not null references public.daily_cash_closings(closing_date) on delete restrict,
  previous_record jsonb,
  new_record jsonb not null,
  changed_at timestamptz not null default now(),
  changed_by uuid not null default auth.uid()
);

create table if not exists public.daily_gcash_closings (
  closing_date date primary key,
  expected_balance numeric(14, 2) not null check (expected_balance >= 0),
  actual_balance numeric(14, 2) not null check (actual_balance >= 0),
  difference numeric(14, 2) not null,
  notes text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid not null default auth.uid()
);

create table if not exists public.daily_gcash_closing_history (
  id uuid primary key default gen_random_uuid(),
  closing_date date not null references public.daily_gcash_closings(closing_date) on delete restrict,
  previous_record jsonb,
  new_record jsonb not null,
  changed_at timestamptz not null default now(),
  changed_by uuid not null default auth.uid()
);

alter table public.fund_openings enable row level security;
alter table public.fund_opening_history enable row level security;
alter table public.fund_transactions enable row level security;
alter table public.stock_purchases enable row level security;
alter table public.daily_cash_closings enable row level security;
alter table public.daily_cash_closing_history enable row level security;
alter table public.daily_gcash_closings enable row level security;
alter table public.daily_gcash_closing_history enable row level security;

drop policy if exists fund_openings_authenticated_select on public.fund_openings;
create policy fund_openings_authenticated_select on public.fund_openings
  for select to authenticated using (true);
drop policy if exists fund_opening_history_authenticated_select on public.fund_opening_history;
create policy fund_opening_history_authenticated_select on public.fund_opening_history
  for select to authenticated using (true);
drop policy if exists fund_transactions_authenticated_select on public.fund_transactions;
create policy fund_transactions_authenticated_select on public.fund_transactions
  for select to authenticated using (true);
drop policy if exists stock_purchases_authenticated_select on public.stock_purchases;
create policy stock_purchases_authenticated_select on public.stock_purchases
  for select to authenticated using (true);
drop policy if exists daily_cash_closings_authenticated_select on public.daily_cash_closings;
create policy daily_cash_closings_authenticated_select on public.daily_cash_closings
  for select to authenticated using (true);
drop policy if exists daily_cash_closing_history_authenticated_select on public.daily_cash_closing_history;
create policy daily_cash_closing_history_authenticated_select on public.daily_cash_closing_history
  for select to authenticated using (true);
drop policy if exists daily_gcash_closings_authenticated_select on public.daily_gcash_closings;
create policy daily_gcash_closings_authenticated_select on public.daily_gcash_closings
  for select to authenticated using (true);
drop policy if exists daily_gcash_closing_history_authenticated_select on public.daily_gcash_closing_history;
create policy daily_gcash_closing_history_authenticated_select on public.daily_gcash_closing_history
  for select to authenticated using (true);

revoke all on public.fund_openings, public.fund_opening_history,
  public.fund_transactions, public.stock_purchases,
  public.daily_cash_closings, public.daily_cash_closing_history,
  public.daily_gcash_closings, public.daily_gcash_closing_history
  from public, anon, authenticated;
grant select on public.fund_openings, public.fund_opening_history,
  public.fund_transactions, public.stock_purchases,
  public.daily_cash_closings, public.daily_cash_closing_history,
  public.daily_gcash_closings, public.daily_gcash_closing_history
  to authenticated;
drop policy if exists expenses_authenticated_all on public.expenses;
drop policy if exists expenses_authenticated_select on public.expenses;
create policy expenses_authenticated_select on public.expenses
  for select to authenticated using (true);
revoke insert, update, delete on public.expenses from public, anon, authenticated;
grant select on public.expenses to authenticated;

create or replace function public.set_fund_opening(
  p_effective_date date,
  p_cash_balance numeric,
  p_gcash_balance numeric,
  p_revolving_balance numeric,
  p_savings_balance numeric,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_previous public.fund_openings%rowtype;
  v_saved public.fund_openings%rowtype;
  v_check_from date;
begin
  if auth.uid() is null then
    raise exception 'Sign in before changing fund opening balances.';
  end if;
  if p_effective_date is null or p_effective_date > current_date then
    raise exception 'Choose an effective date that is not in the future.';
  end if;
  if p_cash_balance is null or p_cash_balance < 0
    or p_gcash_balance is null or p_gcash_balance < 0
    or p_revolving_balance is null or p_revolving_balance < 0
    or p_savings_balance is null or p_savings_balance < 0 then
    raise exception 'Opening balances must be zero or greater.';
  end if;
  if nullif(trim(p_reason), '') is null or char_length(trim(p_reason)) > 300 then
    raise exception 'Enter a reason of 1 to 300 characters for the opening balance change.';
  end if;

  perform pg_advisory_xact_lock(726184030);
  perform pg_advisory_xact_lock(726184033);
  select * into v_previous from public.fund_openings where id = 1 for update;
  v_check_from := least(p_effective_date, coalesce(v_previous.effective_date, p_effective_date));
  insert into public.fund_opening_history (
    effective_date, previous_balances, new_balances, reason, changed_by
  )
  values (
    p_effective_date,
    case when found then to_jsonb(v_previous) - 'updated_at' - 'updated_by' else null end,
    jsonb_build_object(
      'cash', round(p_cash_balance, 2),
      'gcash', round(p_gcash_balance, 2),
      'revolving', round(p_revolving_balance, 2),
      'savings', round(p_savings_balance, 2)
    ),
    trim(p_reason),
    auth.uid()
  );

  insert into public.fund_openings (
    id, effective_date, cash_balance, gcash_balance,
    revolving_balance, savings_balance, updated_at, updated_by
  )
  values (
    1, p_effective_date, round(p_cash_balance, 2), round(p_gcash_balance, 2),
    round(p_revolving_balance, 2), round(p_savings_balance, 2), now(), auth.uid()
  )
  on conflict (id) do update set
    effective_date = excluded.effective_date,
    cash_balance = excluded.cash_balance,
    gcash_balance = excluded.gcash_balance,
    revolving_balance = excluded.revolving_balance,
    savings_balance = excluded.savings_balance,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by
  returning * into v_saved;

  perform public.assert_fund_balances_nonnegative(
    v_check_from, array['cash', 'gcash', 'revolving', 'savings']::text[]
  );
  return to_jsonb(v_saved);
end;
$$;

create or replace function public.record_fund_transaction(
  p_id text,
  p_reference text,
  p_date date,
  p_type text,
  p_from_account text,
  p_to_account text,
  p_amount numeric,
  p_description text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_saved public.fund_transactions%rowtype;
  v_balance numeric(14, 2);
begin
  if auth.uid() is null then
    raise exception 'Sign in before recording a fund transaction.';
  end if;
  if nullif(trim(p_id), '') is null or nullif(trim(p_reference), '') is null then
    raise exception 'A fund transaction needs a unique ID and reference.';
  end if;
  if p_date is null or p_date > current_date then
    raise exception 'Choose a transaction date that is not in the future.';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter an amount greater than zero.';
  end if;
  if nullif(trim(p_description), '') is null or char_length(trim(p_description)) > 300 then
    raise exception 'Enter a description of 1 to 300 characters.';
  end if;
  if p_type is null or p_type not in ('other_in', 'other_out', 'cash_drop', 'transfer', 'gcash_in', 'gcash_out') then
    raise exception 'Choose a valid fund transaction type.';
  end if;

  if p_type = 'other_in' and (p_from_account is not null or p_to_account is distinct from 'cash')
    or p_type = 'other_out' and (p_from_account is distinct from 'cash' or p_to_account is not null)
    or p_type = 'gcash_in' and (p_from_account is not null or p_to_account is distinct from 'gcash')
    or p_type = 'gcash_out' and (p_from_account is distinct from 'gcash' or p_to_account is not null)
    or p_type = 'cash_drop' and (p_from_account is distinct from 'cash' or p_to_account is distinct from 'revolving')
    or p_type = 'transfer' and (p_from_account is null or p_to_account is null or p_from_account = p_to_account) then
    raise exception 'The transaction type does not match the selected fund accounts.';
  end if;

  if p_from_account is not null then
    perform pg_advisory_xact_lock(726184033);
    select public.get_fund_balance(p_from_account, p_date) into v_balance;
    if p_amount > v_balance + 0.000000001 then
      raise exception 'This transaction exceeds the available % balance of %.',
        p_from_account, v_balance;
    end if;
  end if;

  insert into public.fund_transactions (
    id, reference, transaction_date, transaction_type,
    from_account, to_account, amount, description, created_by
  )
  values (
    trim(p_id), trim(p_reference), p_date, p_type,
    p_from_account, p_to_account, round(p_amount, 2), trim(p_description), auth.uid()
  )
  returning * into v_saved;

  perform public.assert_fund_balances_nonnegative(
    p_date, array_remove(array[p_from_account, p_to_account], null)::text[]
  );
  return to_jsonb(v_saved);
end;
$$;

create or replace function public.record_stock_purchase(
  p_id text,
  p_reference text,
  p_date date,
  p_supplier text,
  p_description text,
  p_payment_account text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product public.products%rowtype;
  v_request jsonb;
  v_item jsonb;
  v_items jsonb := '[]'::jsonb;
  v_seen_ids text[] := '{}';
  v_product_id text;
  v_quantity numeric(14, 3);
  v_unit_cost numeric(14, 4);
  v_line_total numeric(14, 2);
  v_total numeric(14, 2) := 0;
  v_balance numeric(14, 2);
  v_purchase public.stock_purchases%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in before recording a stock purchase.';
  end if;
  if nullif(trim(p_id), '') is null or nullif(trim(p_reference), '') is null then
    raise exception 'A stock purchase needs a unique ID and reference.';
  end if;
  if p_date is null or p_date > current_date then
    raise exception 'Choose a purchase date that is not in the future.';
  end if;
  if p_payment_account not in ('cash', 'gcash', 'revolving', 'savings') then
    raise exception 'Choose a valid payment account.';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one product to the stock purchase.';
  end if;
  if char_length(coalesce(p_supplier, '')) > 120
    or nullif(trim(p_description), '') is null or char_length(trim(p_description)) > 300 then
    raise exception 'Enter a supplier (up to 120 characters) and description (up to 300 characters).';
  end if;

  perform pg_advisory_xact_lock(726184031);
  for v_request in select value from jsonb_array_elements(p_items)
  loop
    v_product_id := nullif(trim(v_request ->> 'productId'), '');
    if v_product_id is null or v_product_id = any(v_seen_ids) then
      raise exception 'Each purchased product must be selected once.';
    end if;
    v_seen_ids := array_append(v_seen_ids, v_product_id);
    v_quantity := (v_request ->> 'quantity')::numeric;
    v_unit_cost := (v_request ->> 'unitCost')::numeric;
    if v_quantity is null or v_quantity <= 0 or v_unit_cost is null or v_unit_cost < 0 then
      raise exception 'Purchase quantities must be positive and unit costs cannot be negative.';
    end if;

    select * into v_product from public.products where id = v_product_id for update;
    if not found then
      raise exception 'Product % was not found.', v_product_id;
    end if;

    v_line_total := round(v_quantity * v_unit_cost, 2);
    v_total := v_total + v_line_total;
    v_item := jsonb_build_object(
      'productId', v_product.id,
      'name', v_product.name,
      'unit', v_product.unit,
      'quantity', round(v_quantity, 3),
      'unitCost', round(v_unit_cost, 4),
      'total', v_line_total
    );
    v_items := v_items || jsonb_build_array(v_item);

    update public.products
      set cost = case
        when v_product.stock is null or v_product.stock + v_quantity = 0 then round(v_unit_cost, 4)
        else round(((v_product.stock * v_product.cost) + (v_quantity * v_unit_cost)) /
          (v_product.stock + v_quantity), 4)
        end,
        stock = round(coalesce(v_product.stock, 0) + v_quantity, 3),
        updated_at = now()
      where id = v_product.id;
  end loop;

  v_total := round(v_total, 2);
  if v_total <= 0 then
    raise exception 'The stock purchase total must be greater than zero.';
  end if;
  perform pg_advisory_xact_lock(726184033);
  select public.get_fund_balance(p_payment_account, p_date) into v_balance;
  if v_total > v_balance + 0.000000001 then
    raise exception 'This purchase exceeds the available % balance of %.',
      p_payment_account, v_balance;
  end if;

  insert into public.stock_purchases (
    id, reference, transaction_date, supplier, description,
    payment_account, items, total, created_by
  )
  values (
    trim(p_id), trim(p_reference), p_date, trim(coalesce(p_supplier, '')),
    trim(p_description), p_payment_account, v_items, v_total, auth.uid()
  )
  returning * into v_purchase;

  insert into public.fund_transactions (
    id, reference, transaction_date, transaction_type,
    from_account, to_account, amount, description, related_reference, created_by
  )
  values (
    trim(p_id), trim(p_reference), p_date, 'stock_purchase',
    p_payment_account, null, v_total, trim(p_description), trim(p_reference), auth.uid()
  );

  perform public.assert_fund_balances_nonnegative(p_date, array[p_payment_account]::text[]);
  return to_jsonb(v_purchase);
end;
$$;

create or replace function public.get_fund_balance(p_account text, p_as_of date default current_date)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_opening public.fund_openings%rowtype;
  v_opening_balance numeric(14, 2) := 0;
  v_total numeric(18, 2) := 0;
begin
  if auth.uid() is null then
    raise exception 'Sign in to view fund balances.';
  end if;
  if p_account is null or p_account not in ('cash', 'gcash', 'revolving', 'savings') or p_as_of is null then
    raise exception 'Choose a valid account and date.';
  end if;

  select * into v_opening from public.fund_openings where id = 1;
  if found and p_as_of >= v_opening.effective_date then
    v_opening_balance := case p_account
      when 'cash' then v_opening.cash_balance
      when 'gcash' then v_opening.gcash_balance
      when 'revolving' then v_opening.revolving_balance
      when 'savings' then v_opening.savings_balance
    end;
  elsif not found and p_account = 'cash' then
    select coalesce(nullif(value ->> 'openingCash', '')::numeric, 0)
      into v_opening_balance
      from public.store_settings
      where id = 'store';
    v_opening_balance := coalesce(v_opening_balance, 0);
  end if;

  if p_account = 'cash' then
    select v_opening_balance
      + coalesce((select sum(total) from public.sales
          where payment = 'Cash' and date >= coalesce(v_opening.effective_date, '-infinity'::date) and date <= p_as_of), 0)
      + coalesce((select sum(amount) from public.collections
          where payment_source = 'Cash' and date >= coalesce(v_opening.effective_date, '-infinity'::date) and date <= p_as_of), 0)
      - coalesce((select sum(amount) from public.expenses
          where payment_source = 'Cash' and date >= coalesce(v_opening.effective_date, '-infinity'::date) and date <= p_as_of), 0)
      - coalesce((select sum(refund_amount) from public.sale_voids
          where refund_method = 'Cash' and date >= coalesce(v_opening.effective_date, '-infinity'::date) and date <= p_as_of), 0)
      into v_total;
  elsif p_account = 'gcash' then
    select v_opening_balance
      + coalesce((select sum(total) from public.sales
          where payment = 'GCash' and date >= coalesce(v_opening.effective_date, '-infinity'::date) and date <= p_as_of), 0)
      + coalesce((select sum(amount) from public.collections
          where payment_source = 'GCash' and date >= coalesce(v_opening.effective_date, '-infinity'::date) and date <= p_as_of), 0)
      - coalesce((select sum(amount) from public.expenses
          where payment_source = 'GCash' and date >= coalesce(v_opening.effective_date, '-infinity'::date) and date <= p_as_of), 0)
      - coalesce((select sum(refund_amount) from public.sale_voids
          where refund_method = 'GCash' and date >= coalesce(v_opening.effective_date, '-infinity'::date) and date <= p_as_of), 0)
      into v_total;
  else
    v_total := v_opening_balance;
  end if;

  select v_total
    + coalesce(sum(case when to_account = p_account then amount else 0 end), 0)
    - coalesce(sum(case when from_account = p_account then amount else 0 end), 0)
    into v_total
    from public.fund_transactions
    where transaction_date >= coalesce(v_opening.effective_date, '-infinity'::date)
      and transaction_date <= p_as_of
      and (from_account = p_account or to_account = p_account);

  return round(v_total, 2);
end;
$$;

create or replace function public.assert_fund_balances_nonnegative(p_start date, p_accounts text[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account text;
  v_date date;
  v_balance numeric(14, 2);
begin
  if auth.uid() is null then
    raise exception 'Sign in to validate fund balances.';
  end if;
  if p_start is null or p_accounts is null then
    raise exception 'A date and fund accounts are required to validate balances.';
  end if;

  foreach v_account in array p_accounts
  loop
    for v_date in
      select event_dates.balance_date
      from (
        select p_start as balance_date
        union select current_date
        union select date from public.sales where
          (v_account = 'cash' and payment = 'Cash' or v_account = 'gcash' and payment = 'GCash')
        union select date from public.collections where
          (v_account = 'cash' and payment_source = 'Cash' or v_account = 'gcash' and payment_source = 'GCash')
        union select date from public.expenses where
          (v_account = 'cash' and payment_source = 'Cash' or v_account = 'gcash' and payment_source = 'GCash')
        union select date from public.sale_voids where
          (v_account = 'cash' and refund_method = 'Cash' or v_account = 'gcash' and refund_method = 'GCash')
        union select transaction_date from public.fund_transactions
          where from_account = v_account or to_account = v_account
      ) as event_dates
      where event_dates.balance_date >= p_start and event_dates.balance_date <= current_date
      order by event_dates.balance_date
    loop
      v_balance := public.get_fund_balance(v_account, v_date);
      if v_balance < -0.005 then
        raise exception 'This change would make the % balance negative on % (%).',
          v_account, v_date, v_balance;
      end if;
    end loop;
  end loop;
end;
$$;

create or replace function public.record_expense(
  p_id text,
  p_date date,
  p_category text,
  p_description text,
  p_amount numeric,
  p_payment_source text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account text;
  v_balance numeric(14, 2);
  v_expense public.expenses%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in before recording an expense.';
  end if;
  if nullif(trim(p_id), '') is null then
    raise exception 'An expense needs a unique ID.';
  end if;
  if p_date is null or p_date > current_date then
    raise exception 'Choose an expense date that is not in the future.';
  end if;
  if p_category is null or p_category not in ('Rent', 'Internet', 'Gasoline', 'Utilities', 'Salary', 'Supplies', 'Others') then
    raise exception 'Choose a valid expense category.';
  end if;
  if nullif(trim(p_description), '') is null or char_length(trim(p_description)) > 300 then
    raise exception 'Enter a description of 1 to 300 characters.';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter an amount greater than zero.';
  end if;
  if p_payment_source is null or p_payment_source not in ('Cash', 'GCash', 'Bank transfer', 'Other') then
    raise exception 'Choose a valid expense payment source.';
  end if;

  if p_payment_source in ('Cash', 'GCash') then
    perform pg_advisory_xact_lock(726184033);
    v_account := case p_payment_source when 'Cash' then 'cash' else 'gcash' end;
    select public.get_fund_balance(v_account, p_date) into v_balance;
    if round(p_amount, 2) > v_balance + 0.000000001 then
      raise exception 'This expense exceeds the available % balance of %.',
        v_account, v_balance;
    end if;
  end if;

  insert into public.expenses (
    id, date, category, description, amount, payment_source, created_by
  )
  values (
    trim(p_id), p_date, p_category, trim(p_description), round(p_amount, 2),
    p_payment_source, auth.uid()
  )
  returning * into v_expense;

  if v_account is not null then
    perform public.assert_fund_balances_nonnegative(p_date, array[v_account]::text[]);
  end if;
  return to_jsonb(v_expense);
end;
$$;

create or replace function public.enforce_sale_void_fund_balance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account text;
begin
  if new.refund_amount > 0 and new.refund_method in ('Cash', 'GCash') then
    perform pg_advisory_xact_lock(726184033);
    v_account := case new.refund_method when 'Cash' then 'cash' else 'gcash' end;
    perform public.assert_fund_balances_nonnegative(new.date, array[v_account]::text[]);
  end if;
  return new;
end;
$$;

drop trigger if exists sale_void_fund_balance_guard on public.sale_voids;
create trigger sale_void_fund_balance_guard
  after insert on public.sale_voids
  for each row execute function public.enforce_sale_void_fund_balance();

create or replace function public.save_daily_cash_closing(
  p_date date,
  p_actual_cash numeric,
  p_notes text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_opening public.fund_openings%rowtype;
  v_previous public.daily_cash_closings%rowtype;
  v_saved public.daily_cash_closings%rowtype;
  v_had_previous boolean;
  v_expected numeric(14, 2);
  v_breakdown jsonb;
  v_cash_sales numeric(14, 2);
  v_cash_collections numeric(14, 2);
  v_cash_expenses numeric(14, 2);
  v_cash_refunds numeric(14, 2);
  v_stock_purchases numeric(14, 2);
  v_other_in numeric(14, 2);
  v_other_out numeric(14, 2);
  v_cash_drops numeric(14, 2);
begin
  if auth.uid() is null then
    raise exception 'Sign in before saving a cash closing.';
  end if;
  if p_date is null or p_date > current_date then
    raise exception 'Choose a closing date that is not in the future.';
  end if;
  if p_actual_cash is null or p_actual_cash < 0 then
    raise exception 'Enter an actual cash count of zero or greater.';
  end if;
  if char_length(coalesce(p_notes, '')) > 500 then
    raise exception 'Closing notes must be 500 characters or fewer.';
  end if;
  select * into v_opening from public.fund_openings where id = 1;
  if not found or p_date < v_opening.effective_date then
    raise exception 'Set an opening balance effective on or before this closing date first.';
  end if;

  v_cash_sales := coalesce((select sum(total) from public.sales where payment = 'Cash' and date = p_date), 0);
  v_cash_collections := coalesce((select sum(amount) from public.collections where payment_source = 'Cash' and date = p_date), 0);
  v_cash_expenses := coalesce((select sum(amount) from public.expenses where payment_source = 'Cash' and date = p_date), 0);
  v_cash_refunds := coalesce((select sum(refund_amount) from public.sale_voids where refund_method = 'Cash' and date = p_date), 0);
  v_stock_purchases := coalesce((select sum(amount) from public.fund_transactions where transaction_type = 'stock_purchase' and from_account = 'cash' and transaction_date = p_date), 0);
  v_other_in := coalesce((select sum(amount) from public.fund_transactions where to_account = 'cash' and transaction_type = 'other_in' and transaction_date = p_date), 0);
  v_other_out := coalesce((select sum(amount) from public.fund_transactions where from_account = 'cash' and transaction_type = 'other_out' and transaction_date = p_date), 0);
  v_cash_drops := coalesce((select sum(amount) from public.fund_transactions where from_account = 'cash' and transaction_type = 'cash_drop' and transaction_date = p_date), 0);
  v_expected := public.get_fund_balance('cash', p_date);
  v_breakdown := jsonb_build_object(
    'openingCash', case
      when p_date = v_opening.effective_date then v_opening.cash_balance
      else public.get_fund_balance('cash', p_date - 1)
    end,
    'cashSales', v_cash_sales,
    'cashCollections', v_cash_collections,
    'cashStockPurchases', v_stock_purchases,
    'cashExpenses', v_cash_expenses,
    'otherCashIn', v_other_in,
    'otherCashOut', v_other_out,
    'cashDrops', v_cash_drops,
    'cashRefunds', v_cash_refunds,
    'expectedCash', v_expected
  );

  perform pg_advisory_xact_lock(726184032);
  select * into v_previous from public.daily_cash_closings where closing_date = p_date for update;
  v_had_previous := found;

  insert into public.daily_cash_closings (
    closing_date, expected_cash, actual_cash, difference, breakdown, notes,
    created_by, updated_at, updated_by
  )
  values (
    p_date, v_expected, round(p_actual_cash, 2), round(p_actual_cash - v_expected, 2),
    v_breakdown, trim(coalesce(p_notes, '')), auth.uid(), now(), auth.uid()
  )
  on conflict (closing_date) do update set
    expected_cash = excluded.expected_cash,
    actual_cash = excluded.actual_cash,
    difference = excluded.difference,
    breakdown = excluded.breakdown,
    notes = excluded.notes,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by
  returning * into v_saved;

  insert into public.daily_cash_closing_history (
    closing_date, previous_record, new_record, changed_by
  )
  values (
    p_date, case when v_had_previous then to_jsonb(v_previous) else null end,
    jsonb_build_object('actualCash', round(p_actual_cash, 2), 'notes', trim(coalesce(p_notes, ''))),
    auth.uid()
  );

  return to_jsonb(v_saved);
end;
$$;

create or replace function public.save_daily_gcash_closing(
  p_date date,
  p_actual_balance numeric,
  p_notes text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_opening public.fund_openings%rowtype;
  v_previous public.daily_gcash_closings%rowtype;
  v_saved public.daily_gcash_closings%rowtype;
  v_expected numeric(14, 2);
  v_had_previous boolean;
begin
  if auth.uid() is null then
    raise exception 'Sign in before saving a GCash reconciliation.';
  end if;
  if p_date is null or p_date > current_date then
    raise exception 'Choose a reconciliation date that is not in the future.';
  end if;
  if p_actual_balance is null or p_actual_balance < 0 then
    raise exception 'Enter an actual GCash balance of zero or greater.';
  end if;
  if char_length(coalesce(p_notes, '')) > 500 then
    raise exception 'Reconciliation notes must be 500 characters or fewer.';
  end if;
  select * into v_opening from public.fund_openings where id = 1;
  if not found or p_date < v_opening.effective_date then
    raise exception 'Set an opening balance effective on or before this reconciliation date first.';
  end if;

  v_expected := public.get_fund_balance('gcash', p_date);
  perform pg_advisory_xact_lock(726184034);
  select * into v_previous from public.daily_gcash_closings where closing_date = p_date for update;
  v_had_previous := found;

  insert into public.daily_gcash_closings (
    closing_date, expected_balance, actual_balance, difference, notes,
    created_by, updated_at, updated_by
  )
  values (
    p_date, v_expected, round(p_actual_balance, 2),
    round(p_actual_balance - v_expected, 2), trim(coalesce(p_notes, '')),
    auth.uid(), now(), auth.uid()
  )
  on conflict (closing_date) do update set
    expected_balance = excluded.expected_balance,
    actual_balance = excluded.actual_balance,
    difference = excluded.difference,
    notes = excluded.notes,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by
  returning * into v_saved;

  insert into public.daily_gcash_closing_history (
    closing_date, previous_record, new_record, changed_by
  )
  values (
    p_date,
    case when v_had_previous then to_jsonb(v_previous) else null end,
    jsonb_build_object(
      'expectedBalance', v_expected,
      'actualBalance', round(p_actual_balance, 2),
      'difference', round(p_actual_balance - v_expected, 2),
      'notes', trim(coalesce(p_notes, ''))
    ),
    auth.uid()
  );

  return to_jsonb(v_saved);
end;
$$;

revoke all on function public.set_fund_opening(date, numeric, numeric, numeric, numeric, text) from public, anon;
revoke all on function public.record_fund_transaction(text, text, date, text, text, text, numeric, text) from public, anon;
revoke all on function public.record_stock_purchase(text, text, date, text, text, text, jsonb) from public, anon;
revoke all on function public.get_fund_balance(text, date) from public, anon;
revoke all on function public.assert_fund_balances_nonnegative(date, text[]) from public, anon;
revoke all on function public.record_expense(text, date, text, text, numeric, text) from public, anon;
revoke all on function public.enforce_sale_void_fund_balance() from public, anon, authenticated;
revoke all on function public.save_daily_cash_closing(date, numeric, text) from public, anon;
revoke all on function public.save_daily_gcash_closing(date, numeric, text) from public, anon;
grant execute on function public.set_fund_opening(date, numeric, numeric, numeric, numeric, text) to authenticated;
grant execute on function public.record_fund_transaction(text, text, date, text, text, text, numeric, text) to authenticated;
grant execute on function public.record_stock_purchase(text, text, date, text, text, text, jsonb) to authenticated;
grant execute on function public.get_fund_balance(text, date) to authenticated;
grant execute on function public.assert_fund_balances_nonnegative(date, text[]) to authenticated;
grant execute on function public.record_expense(text, date, text, text, numeric, text) to authenticated;
grant execute on function public.save_daily_cash_closing(date, numeric, text) to authenticated;
grant execute on function public.save_daily_gcash_closing(date, numeric, text) to authenticated;

create or replace function public.import_device_data(
  p_products jsonb,
  p_customers jsonb,
  p_sales jsonb,
  p_collections jsonb,
  p_expenses jsonb,
  p_settings jsonb,
  p_sale_voids jsonb,
  p_fund_opening jsonb,
  p_fund_opening_history jsonb,
  p_fund_transactions jsonb,
  p_stock_purchases jsonb,
  p_cash_closings jsonb,
  p_cash_closing_history jsonb,
  p_gcash_closings jsonb,
  p_gcash_closing_history jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_check_from date;
begin
  if auth.uid() is null then
    raise exception 'Sign in before importing device data.';
  end if;
  if p_fund_opening is not null and jsonb_typeof(p_fund_opening) <> 'object'
    or jsonb_typeof(p_fund_opening_history) <> 'array'
    or jsonb_typeof(p_fund_transactions) <> 'array'
    or jsonb_typeof(p_stock_purchases) <> 'array'
    or jsonb_typeof(p_cash_closings) <> 'array'
    or jsonb_typeof(p_cash_closing_history) <> 'array'
    or jsonb_typeof(p_gcash_closings) <> 'array'
    or jsonb_typeof(p_gcash_closing_history) <> 'array' then
    raise exception 'Device finance data must contain an opening object and finance record lists.';
  end if;

  perform pg_advisory_xact_lock(726184029);
  if exists (select 1 from public.products limit 1)
    or exists (select 1 from public.customers limit 1)
    or exists (select 1 from public.sales limit 1)
    or exists (select 1 from public.sale_voids limit 1)
    or exists (select 1 from public.collections limit 1)
    or exists (select 1 from public.expenses limit 1)
    or exists (select 1 from public.fund_openings limit 1)
    or exists (select 1 from public.fund_opening_history limit 1)
    or exists (select 1 from public.fund_transactions limit 1)
    or exists (select 1 from public.stock_purchases limit 1)
    or exists (select 1 from public.daily_cash_closings limit 1)
    or exists (select 1 from public.daily_cash_closing_history limit 1)
    or exists (select 1 from public.daily_gcash_closings limit 1)
    or exists (select 1 from public.daily_gcash_closing_history limit 1) then
    raise exception 'Import is allowed only while the shared store is empty.';
  end if;

  perform public.import_device_data(
    p_products, p_customers, p_sales, p_collections, p_expenses, p_settings, p_sale_voids
  );

  if p_fund_opening is not null then
    insert into public.fund_openings (
      id, effective_date, cash_balance, gcash_balance, revolving_balance,
      savings_balance, updated_at, updated_by
    )
    select 1, effective_date, cash_balance, gcash_balance, revolving_balance,
      savings_balance, coalesce(updated_at, now()), auth.uid()
    from jsonb_to_record(p_fund_opening) as item(
      effective_date date, cash_balance numeric, gcash_balance numeric,
      revolving_balance numeric, savings_balance numeric, updated_at timestamptz
    );
  end if;

  insert into public.fund_opening_history (
    effective_date, previous_balances, new_balances, reason, changed_at, changed_by
  )
  select effective_date, previous_balances, new_balances, reason,
    coalesce(changed_at, now()), auth.uid()
  from jsonb_to_recordset(p_fund_opening_history) as item(
    effective_date date, previous_balances jsonb, new_balances jsonb,
    reason text, changed_at timestamptz
  );

  insert into public.fund_transactions (
    id, reference, transaction_date, transaction_type, from_account, to_account,
    amount, description, related_reference, created_at, created_by
  )
  select id, reference, transaction_date, transaction_type, from_account, to_account,
    amount, description, related_reference, coalesce(created_at, now()), auth.uid()
  from jsonb_to_recordset(p_fund_transactions) as item(
    id text, reference text, transaction_date date, transaction_type text,
    from_account text, to_account text, amount numeric, description text,
    related_reference text, created_at timestamptz
  );

  insert into public.stock_purchases (
    id, reference, transaction_date, supplier, description, payment_account,
    items, total, created_at, created_by
  )
  select id, reference, transaction_date, coalesce(supplier, ''), description,
    payment_account, items, total, coalesce(created_at, now()), auth.uid()
  from jsonb_to_recordset(p_stock_purchases) as item(
    id text, reference text, transaction_date date, supplier text, description text,
    payment_account text, items jsonb, total numeric, created_at timestamptz
  );

  insert into public.daily_cash_closings (
    closing_date, expected_cash, actual_cash, difference, breakdown, notes,
    created_at, created_by, updated_at, updated_by
  )
  select closing_date, expected_cash, actual_cash, difference, coalesce(breakdown, '{}'::jsonb),
    coalesce(notes, ''), coalesce(created_at, now()), auth.uid(),
    coalesce(updated_at, now()), auth.uid()
  from jsonb_to_recordset(p_cash_closings) as item(
    closing_date date, expected_cash numeric, actual_cash numeric, difference numeric,
    breakdown jsonb, notes text, created_at timestamptz, updated_at timestamptz
  );

  insert into public.daily_cash_closing_history (
    closing_date, previous_record, new_record, changed_at, changed_by
  )
  select closing_date, previous_record, new_record, coalesce(changed_at, now()), auth.uid()
  from jsonb_to_recordset(p_cash_closing_history) as item(
    closing_date date, previous_record jsonb, new_record jsonb, changed_at timestamptz
  );

  insert into public.daily_gcash_closings (
    closing_date, expected_balance, actual_balance, difference, notes,
    created_at, created_by, updated_at, updated_by
  )
  select closing_date, expected_balance, actual_balance, difference, coalesce(notes, ''),
    coalesce(created_at, now()), auth.uid(), coalesce(updated_at, now()), auth.uid()
  from jsonb_to_recordset(p_gcash_closings) as item(
    closing_date date, expected_balance numeric, actual_balance numeric,
    difference numeric, notes text, created_at timestamptz, updated_at timestamptz
  );

  insert into public.daily_gcash_closing_history (
    closing_date, previous_record, new_record, changed_at, changed_by
  )
  select closing_date, previous_record, new_record, coalesce(changed_at, now()), auth.uid()
  from jsonb_to_recordset(p_gcash_closing_history) as item(
    closing_date date, previous_record jsonb, new_record jsonb, changed_at timestamptz
  );

  if p_fund_opening is not null then
    v_check_from := (p_fund_opening ->> 'effective_date')::date;
  else
    select min(event_dates.balance_date) into v_check_from
    from (
      select date as balance_date from public.sales
      union select date from public.collections
      union select date from public.expenses
      union select date from public.sale_voids
      union select transaction_date from public.fund_transactions
    ) as event_dates
    where event_dates.balance_date <= current_date;
    v_check_from := coalesce(v_check_from, current_date);
  end if;
  perform public.assert_fund_balances_nonnegative(
    v_check_from, array['cash', 'gcash', 'revolving', 'savings']::text[]
  );
end;
$$;

revoke all on function public.import_device_data(
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb
) from public, anon;
grant execute on function public.import_device_data(
  jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb
) to authenticated;
