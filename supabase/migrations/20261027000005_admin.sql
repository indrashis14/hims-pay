-- Admin-only RPCs (design §3.7). Each one checks the caller in the database,
-- so the public admin page code grants nothing by itself.

create function private.require_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
end
$$;

-- One row per student who owes the term, with their status for it.
create function private.term_roster(p_term_id bigint)
returns table (
  student_id uuid, full_name text, phone text, email text, registered_at timestamptz,
  status text, days_late integer, fine_inr integer, total_inr integer,
  order_id uuid, paid_at timestamptz, utr text, bill_no text
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.full_name, s.phone, s.email, s.created_at,
         case
           when o.id is not null then case when o.fine_inr > 0 then 'paid_late' else 'paid' end
           when q.blocked then 'blocked'
           when q.days_late > 0 then 'fine_window'
           else 'unpaid'
         end,
         coalesce(o.days_late, q.days_late),
         coalesce(o.fine_inr, q.fine_inr),
         coalesce(o.total_inr, t.amount_inr + q.fine_inr),
         o.id, o.paid_at, o.utr, o.bill_no
  from public.fee_terms t
  join public.students s on s.first_term_id <= t.id
  left join public.orders o
    on o.student_id = s.id and o.term_id = t.id and o.status = 'success'
  cross join lateral private.fine_quote(
    t.due_date, private.ist_today(),
    exists (select 1 from public.term_unblocks u where u.student_id = s.id and u.term_id = t.id)
  ) q
  where t.id = p_term_id
$$;

create function private.active_term_id()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select max(id) from public.fee_terms
$$;

create function public.admin_terms()
returns setof public.fee_terms
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  return query select * from public.fee_terms order by id desc;
end
$$;

-- p_id null creates a new term, which becomes the active one. Only the active
-- term can be edited; pending orders keep the amount they were created with.
create function public.admin_save_term(
  p_id bigint, p_name text, p_amount_inr integer, p_due_date date
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  perform private.require_admin();
  if p_name is null or length(btrim(p_name)) not between 1 and 100 then
    raise exception 'BAD_NAME' using errcode = 'P0001';
  end if;
  if p_amount_inr is null or p_amount_inr <= 0 then
    raise exception 'BAD_AMOUNT' using errcode = 'P0001';
  end if;
  if p_due_date is null then
    raise exception 'BAD_DATE' using errcode = 'P0001';
  end if;
  if p_id is null then
    insert into public.fee_terms (name, amount_inr, due_date)
    values (btrim(p_name), p_amount_inr, p_due_date)
    returning id into v_id;
  else
    if p_id is distinct from private.active_term_id() then
      raise exception 'NOT_ACTIVE_TERM' using errcode = 'P0001';
    end if;
    update public.fee_terms
       set name = btrim(p_name), amount_inr = p_amount_inr, due_date = p_due_date
     where id = p_id
     returning id into v_id;
  end if;
  return v_id;
end
$$;

create function public.admin_stats(p_term_id bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_term bigint := coalesce(p_term_id, private.active_term_id());
  r jsonb;
begin
  perform private.require_admin();
  select jsonb_build_object(
           'term', (select to_jsonb(t) from public.fee_terms t where t.id = v_term),
           'registered', count(*),
           'paid', count(*) filter (where status in ('paid', 'paid_late')),
           'paid_on_time', count(*) filter (where status = 'paid'),
           'paid_late', count(*) filter (where status = 'paid_late'),
           'unpaid', count(*) filter (where status in ('unpaid', 'fine_window', 'blocked')),
           'in_fine_window', count(*) filter (where status = 'fine_window'),
           'blocked', count(*) filter (where status = 'blocked'),
           'collected_base', coalesce(sum(total_inr - fine_inr) filter (where order_id is not null), 0),
           'collected_fine', coalesce(sum(fine_inr) filter (where order_id is not null), 0),
           'collected_total', coalesce(sum(total_inr) filter (where order_id is not null), 0))
    into r
    from private.term_roster(v_term);
  return r || jsonb_build_object('per_day', coalesce((
    select jsonb_agg(jsonb_build_object('day', d, 'count', c, 'amount', a) order by d)
    from (select (o.paid_at at time zone 'Asia/Kolkata')::date as d, count(*) as c, sum(o.total_inr) as a
            from public.orders o
           where o.term_id = v_term and o.status = 'success'
           group by 1) x), '[]'::jsonb));
end
$$;

-- p_filter: all | paid | unpaid | paid_late | fine_window | blocked.
-- "unpaid" covers every not-yet-paid status.
create function public.admin_students(
  p_term_id bigint default null, p_filter text default 'all', p_search text default null,
  p_limit integer default 50, p_offset integer default 0
)
returns table (
  student_id uuid, full_name text, phone text, email text, registered_at timestamptz,
  status text, days_late integer, fine_inr integer, total_inr integer,
  order_id uuid, paid_at timestamptz, utr text, bill_no text, total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_term bigint := coalesce(p_term_id, private.active_term_id());
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
begin
  perform private.require_admin();
  return query
  select r.*, count(*) over ()
    from private.term_roster(v_term) r
   where (coalesce(p_filter, 'all') = 'all'
          or (p_filter = 'paid' and r.status in ('paid', 'paid_late'))
          or (p_filter = 'unpaid' and r.status in ('unpaid', 'fine_window', 'blocked'))
          or r.status = p_filter)
     and (v_q is null
          or r.full_name ilike '%' || v_q || '%'
          or r.email ilike '%' || v_q || '%'
          or r.phone like '%' || v_q || '%'
          or r.student_id::text ilike '%' || v_q || '%')
   order by r.full_name, r.student_id
   limit least(greatest(coalesce(p_limit, 50), 1), 5000)
  offset greatest(coalesce(p_offset, 0), 0);
end
$$;

create function public.admin_payments(
  p_term_id bigint default null, p_include_failed boolean default false,
  p_limit integer default 50, p_offset integer default 0
)
returns table (
  order_id uuid, student_id uuid, full_name text, phone text, email text,
  term_id bigint, term_name text, status text, base_inr integer, fine_inr integer,
  days_late integer, total_inr integer, payer_vpa text, utr text, bill_no text,
  failed_reason text, created_at timestamptz, paid_at timestamptz, total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.require_admin();
  return query
  select o.id, s.id, s.full_name, s.phone, s.email, t.id, t.name, o.status::text,
         o.base_inr, o.fine_inr, o.days_late, o.total_inr, o.payer_vpa, o.utr, o.bill_no,
         o.failed_reason, o.created_at, o.paid_at, count(*) over ()
    from public.orders o
    join public.students s on s.id = o.student_id
    join public.fee_terms t on t.id = o.term_id
   where (p_term_id is null or o.term_id = p_term_id)
     and (o.status = 'success' or (coalesce(p_include_failed, false) and o.status = 'failed'))
   order by coalesce(o.paid_at, o.created_at) desc
   limit least(greatest(coalesce(p_limit, 50), 1), 5000)
  offset greatest(coalesce(p_offset, 0), 0);
end
$$;

create function public.admin_unblock(p_student_id uuid, p_term_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  insert into public.term_unblocks (student_id, term_id)
  values (p_student_id, p_term_id)
  on conflict do nothing;
end
$$;

create function public.admin_outbox()
returns table (
  id bigint, email text, full_name text, code text,
  created_at timestamptz, expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.require_admin();
  delete from private.reset_outbox where expires_at <= now();
  return query
  select r.id, r.email, s.full_name, r.code, r.created_at, r.expires_at
    from private.reset_outbox r
    left join public.students s on s.id = r.user_id
   order by r.created_at desc;
end
$$;

revoke all on function private.require_admin() from public;
revoke all on function private.term_roster(bigint) from public;
revoke all on function private.active_term_id() from public;
revoke all on function public.admin_terms() from public, anon;
revoke all on function public.admin_save_term(bigint, text, integer, date) from public, anon;
revoke all on function public.admin_stats(bigint) from public, anon;
revoke all on function public.admin_students(bigint, text, text, integer, integer) from public, anon;
revoke all on function public.admin_payments(bigint, boolean, integer, integer) from public, anon;
revoke all on function public.admin_unblock(uuid, bigint) from public, anon;
revoke all on function public.admin_outbox() from public, anon;
grant execute on function public.admin_terms() to authenticated;
grant execute on function public.admin_save_term(bigint, text, integer, date) to authenticated;
grant execute on function public.admin_stats(bigint) to authenticated;
grant execute on function public.admin_students(bigint, text, text, integer, integer) to authenticated;
grant execute on function public.admin_payments(bigint, boolean, integer, integer) to authenticated;
grant execute on function public.admin_unblock(uuid, bigint) to authenticated;
grant execute on function public.admin_outbox() to authenticated;
