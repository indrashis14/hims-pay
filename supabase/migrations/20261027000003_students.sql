-- Student signup, identity and dues.

-- Signup form sends full_name + phone as user metadata; accounts created any
-- other way (e.g. the admin account) get no student row.
create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text := new.raw_user_meta_data ->> 'phone';
  v_name  text := btrim(coalesce(new.raw_user_meta_data ->> 'full_name', ''));
begin
  if v_phone is null then
    return new;
  end if;
  if v_phone !~ '^[6-9][0-9]{9}$' then
    raise exception 'BAD_PHONE' using errcode = 'P0001';
  end if;
  if v_name = '' then
    raise exception 'BAD_NAME' using errcode = 'P0001';
  end if;
  insert into public.students (id, full_name, phone, email, first_term_id)
  values (new.id, v_name, v_phone, lower(new.email),
          coalesce((select max(id) from public.fee_terms), 0));
  return new;
end
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- A token issued before the account became admin does not count: if someone
-- else registered the email first, their old session gains nothing.
create function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admins a
    where a.user_id = auth.uid()
      and coalesce((auth.jwt() ->> 'iat')::bigint, 0) >= floor(extract(epoch from a.created_at))
  )
$$;

-- Keep the student record's email in step with the login email.
create function private.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.students set email = lower(new.email) where id = new.id;
  return new;
end
$$;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row
  when (new.email is distinct from old.email)
  execute function private.handle_user_email_change();

create function public.whoami()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.is_admin()
      then jsonb_build_object('role', 'admin')
    when exists (select 1 from public.students s where s.id = auth.uid())
      then jsonb_build_object('role', 'student', 'student',
             (select to_jsonb(s) - 'first_term_id' from public.students s where s.id = auth.uid()))
    else jsonb_build_object('role', 'none')
  end
$$;

create function private.require_student()
returns public.students
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.students;
begin
  select * into v from public.students where id = auth.uid();
  if not found then
    raise exception 'NOT_A_STUDENT' using errcode = 'P0001';
  end if;
  return v;
end
$$;

-- Every term the caller owes, with today's quote or the successful payment.
create function public.my_dues()
returns table (
  term_id bigint, term_name text, due_date date, base_inr integer,
  days_late integer, fine_inr integer, total_inr integer,
  blocked boolean, paid boolean, order_id uuid, bill_no text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v public.students := private.require_student();
begin
  return query
  select t.id, t.name, t.due_date,
         coalesce(o.base_inr, t.amount_inr),
         coalesce(o.days_late, q.days_late),
         coalesce(o.fine_inr, q.fine_inr),
         coalesce(o.total_inr, t.amount_inr + q.fine_inr),
         o.id is null and q.blocked,
         o.id is not null,
         o.id,
         o.bill_no
  from public.fee_terms t
  left join public.orders o
    on o.term_id = t.id and o.student_id = v.id and o.status = 'success'
  cross join lateral private.fine_quote(
    t.due_date, private.ist_today(),
    exists (select 1 from public.term_unblocks u where u.student_id = v.id and u.term_id = t.id)
  ) q
  where t.id >= v.first_term_id
  order by t.due_date, t.id;
end
$$;

revoke all on function private.handle_new_user() from public;
revoke all on function private.handle_user_email_change() from public;
revoke all on function private.is_admin() from public;
revoke all on function private.require_student() from public;
revoke all on function public.whoami() from public, anon;
revoke all on function public.my_dues() from public, anon;
grant execute on function public.whoami() to authenticated;
grant execute on function public.my_dues() to authenticated;
