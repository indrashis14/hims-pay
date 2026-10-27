-- Orders and the simulated UPI gateway (design §3.5, §6, §7.1).

-- The gateway boundary: the only code that moves an order to success/failed.
-- A real gateway's webhook would call this with the service role. A success
-- reported for an order that already expired is still recorded: the money
-- was taken. If the term is already paid that raises ALREADY_PAID, which a
-- real webhook must treat as "refund this".
create function private.finalize_payment(
  p_order_id uuid, p_success boolean, p_reason text, p_vpa text
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.orders;
begin
  select * into o from public.orders where id = p_order_id for update;
  if o.status in ('success', 'failed') or (o.status = 'expired' and not p_success) then
    return o;
  end if;
  if p_success then
    update public.orders
       set status = 'success',
           payer_vpa = p_vpa,
           paid_at = now(),
           utr = lpad(((('x' || encode(extensions.gen_random_bytes(6), 'hex'))::bit(48)::bigint)
                       % 1000000000000)::text, 12, '0'),
           bill_no = 'HIMS-' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY') || '-'
                     || lpad(nextval('private.bill_seq')::text, 6, '0')
     where id = o.id
     returning * into o;
  elsif o.status = 'pending' then
    update public.orders
       set status = 'failed', payer_vpa = p_vpa, failed_reason = p_reason
     where id = o.id
     returning * into o;
  end if;
  return o;
exception
  when unique_violation then
    raise exception 'ALREADY_PAID' using errcode = 'P0001';
end
$$;

create function public.create_order(p_term_id bigint)
returns table (
  order_id uuid, pay_token text, base_inr integer, fine_inr integer,
  days_late integer, total_inr integer, expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v public.students := private.require_student();
  t public.fee_terms;
  q record;
  o public.orders;
begin
  select * into t from public.fee_terms where id = p_term_id;
  if not found or t.id < v.first_term_id then
    raise exception 'TERM_NOT_OWED' using errcode = 'P0001';
  end if;

  -- Two tabs paying the same term queue here and end up sharing one order.
  perform pg_advisory_xact_lock(hashtextextended(v.id::text || ':' || t.id::text, 0));

  if exists (select 1 from public.orders
             where student_id = v.id and term_id = t.id and status = 'success') then
    raise exception 'ALREADY_PAID' using errcode = 'P0001';
  end if;

  update public.orders set status = 'expired'
   where student_id = v.id and term_id = t.id and status = 'pending' and expires_at <= now();

  -- A live pending order keeps its fixed amount, even across midnight or the day-20 block.
  select * into o from public.orders
   where student_id = v.id and term_id = t.id and status = 'pending';

  if not found then
    select * into q from private.fine_quote(
      t.due_date, private.ist_today(),
      exists (select 1 from public.term_unblocks u where u.student_id = v.id and u.term_id = t.id));
    if q.blocked then
      raise exception 'BLOCKED' using errcode = 'P0001';
    end if;
    insert into public.orders (student_id, term_id, base_inr, fine_inr, days_late, pay_token, expires_at)
    values (v.id, t.id, t.amount_inr, q.fine_inr, q.days_late,
            encode(extensions.gen_random_bytes(24), 'hex'), now() + interval '10 minutes')
    returning * into o;
  end if;

  return query select o.id, o.pay_token, o.base_inr, o.fine_inr, o.days_late, o.total_inr, o.expires_at;
end
$$;

-- Plays the payer's bank. Authorised by the order's pay token, so the QR can
-- be approved from a phone that is not logged in.
create function public.mock_upi_pay(
  p_order_id uuid, p_pay_token text, p_vpa text, p_approve boolean
)
returns table (status text, utr text, bill_no text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.orders;
  v_bank_fail boolean;
begin
  -- Same per-student-and-term lock as create_order, so a payment in flight
  -- and a new order for the same bill can never interleave.
  select * into o from public.orders where id = p_order_id;
  if found then
    perform pg_advisory_xact_lock(hashtextextended(o.student_id::text || ':' || o.term_id::text, 0));
  end if;
  select * into o from public.orders where id = p_order_id for update;
  if not found or o.pay_token is distinct from p_pay_token then
    raise exception 'BAD_TOKEN' using errcode = 'P0001';
  end if;
  if o.status in ('success', 'failed') then
    return query select o.status::text, o.utr, o.bill_no;
    return;
  end if;
  if o.status = 'expired' or o.expires_at <= now() then
    raise exception 'EXPIRED' using errcode = 'P0001';
  end if;
  p_vpa := btrim(coalesce(p_vpa, ''));
  if p_vpa !~ '^[a-zA-Z0-9._-]{2,99}@[a-zA-Z]{2,64}$' then
    raise exception 'BAD_VPA' using errcode = 'P0001';
  end if;
  v_bank_fail := lower(p_vpa) like '%@fail';
  o := private.finalize_payment(
    o.id,
    coalesce(p_approve, false) and not v_bank_fail,
    case when not coalesce(p_approve, false) then 'Declined in UPI app'
         when v_bank_fail then 'Declined by bank' end,
    p_vpa);
  return query select o.status::text, o.utr, o.bill_no;
end
$$;

-- What the simulated UPI app shows before the payer approves.
create function public.mock_upi_preview(p_order_id uuid, p_pay_token text)
returns table (total_inr integer, status text, expires_at timestamptz, term_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  select o.total_inr,
         case when o.status = 'pending' and o.expires_at <= now() then 'expired'
              else o.status::text end,
         o.expires_at, t.name
    from public.orders o
    join public.fee_terms t on t.id = o.term_id
   where o.id = p_order_id and o.pay_token = p_pay_token;
  if not found then
    raise exception 'BAD_TOKEN' using errcode = 'P0001';
  end if;
end
$$;

create function public.order_status(p_order_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when o.status = 'pending' and o.expires_at <= now() then 'expired'
              else o.status::text end
  from public.orders o
  where o.id = p_order_id and o.student_id = auth.uid()
$$;

create function public.get_bill(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r jsonb;
begin
  select jsonb_build_object(
           'bill_no', o.bill_no, 'utr', o.utr, 'order_id', o.id, 'paid_at', o.paid_at,
           'payer_vpa', o.payer_vpa, 'status', o.status,
           'base_inr', o.base_inr, 'fine_inr', o.fine_inr, 'days_late', o.days_late,
           'total_inr', o.total_inr,
           'student', jsonb_build_object('id', s.id, 'full_name', s.full_name,
                                         'phone', s.phone, 'email', s.email),
           'term', jsonb_build_object('id', t.id, 'name', t.name, 'due_date', t.due_date))
    into r
    from public.orders o
    join public.students s on s.id = o.student_id
    join public.fee_terms t on t.id = o.term_id
   where o.id = p_order_id
     and o.status = 'success'
     and (o.student_id = auth.uid() or private.is_admin());
  if r is null then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  return r;
end
$$;

revoke all on function private.finalize_payment(uuid, boolean, text, text) from public;
grant execute on function private.finalize_payment(uuid, boolean, text, text) to service_role;
revoke all on function public.create_order(bigint) from public, anon;
revoke all on function public.mock_upi_pay(uuid, text, text, boolean) from public;
revoke all on function public.mock_upi_preview(uuid, text) from public;
revoke all on function public.order_status(uuid) from public, anon;
revoke all on function public.get_bill(uuid) from public, anon;
grant execute on function public.create_order(bigint) to authenticated;
grant execute on function public.mock_upi_pay(uuid, text, text, boolean) to anon, authenticated;
grant execute on function public.mock_upi_preview(uuid, text) to anon, authenticated;
grant execute on function public.order_status(uuid) to authenticated;
grant execute on function public.get_bill(uuid) to authenticated;
