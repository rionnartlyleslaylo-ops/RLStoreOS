-- Run this once in Supabase SQL Editor to enable audited voids on an existing store.
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

alter table public.sale_voids enable row level security;
drop policy if exists sale_voids_authenticated_select on public.sale_voids;
create policy sale_voids_authenticated_select on public.sale_voids
  for select to authenticated using (true);
revoke all on public.sale_voids from public, anon, authenticated;
grant select on public.sale_voids to authenticated;

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

revoke all on function public.record_sale_void(text, text, jsonb, text, numeric, text, date) from public, anon;
revoke all on function public.import_device_data(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.record_sale_void(text, text, jsonb, text, numeric, text, date) to authenticated;
grant execute on function public.import_device_data(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) to authenticated;
