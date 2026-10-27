-- Late-fine rules (design §6). Dates are IST from the database clock.

create function private.ist_today()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'Asia/Kolkata')::date
$$;

-- days_late is the real count; the fine caps at ₹150 and only an unblock
-- lifts the block after day 20.
create function private.fine_quote(p_due date, p_on date, p_unblocked boolean)
returns table (days_late integer, fine_inr integer, blocked boolean)
language sql
immutable
set search_path = ''
as $$
  select n,
         case
           when n = 0 then 0
           when n <= 10 then 5 * n
           when n <= 20 then 50 + 10 * (n - 10)
           else 150
         end,
         n > 20 and not coalesce(p_unblocked, false)
  from (select greatest(0, p_on - p_due) as n) d
$$;

revoke all on function private.ist_today() from public;
revoke all on function private.fine_quote(date, date, boolean) from public;
