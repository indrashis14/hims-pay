-- Local dev only: one active term due in 30 days.
insert into public.fee_terms (name, amount_inr, due_date)
values ('Semester 1 (2026-27)', 50000, (now() at time zone 'Asia/Kolkata')::date + 30);
