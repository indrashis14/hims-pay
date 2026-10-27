begin;
select plan(12);

create function pg_temp.q(n integer, unblocked boolean)
returns text language sql as $$
  select format('%s,%s,%s', days_late, fine_inr, blocked)
  from private.fine_quote(date '2026-01-31', date '2026-01-31' + n, unblocked)
$$;

select is(pg_temp.q(-5, false), '0,0,f',   'paid early: no fine');
select is(pg_temp.q(0,  false), '0,0,f',   'paid on due date: no fine');
select is(pg_temp.q(1,  false), '1,5,f',   'day 1: 5');
select is(pg_temp.q(10, false), '10,50,f', 'day 10: 50');
select is(pg_temp.q(11, false), '11,60,f', 'day 11: 60');
select is(pg_temp.q(15, false), '15,100,f','day 15: 100');
select is(pg_temp.q(20, false), '20,150,f','day 20: 150, still payable');
select is(pg_temp.q(21, false), '21,150,t', 'day 21: blocked');
select is(pg_temp.q(40, false), '40,150,t', 'day 40: blocked');
select is(pg_temp.q(21, true),  '21,150,f','day 21 unblocked: capped 150');
select is(pg_temp.q(40, true),  '40,150,f','day 40 unblocked: capped 150');
select is(private.ist_today(), (now() at time zone 'Asia/Kolkata')::date, 'ist_today uses IST');

select * from finish();
rollback;
