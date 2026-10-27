-- Outbox mode for password-reset codes (design §7.4). Supabase Auth calls this
-- instead of sending email while the Send Email hook is enabled. Only the
-- newest code per account is valid, so older outbox rows are replaced.

create function private.hook_send_email(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (event #>> '{user,id}')::uuid;
begin
  delete from private.reset_outbox where expires_at <= now();
  if event #>> '{email_data,email_action_type}' = 'recovery' then
    delete from private.reset_outbox where user_id = v_user;
    insert into private.reset_outbox (user_id, email, code, expires_at)
    values (v_user, lower(event #>> '{user,email}'), event #>> '{email_data,token}',
            now() + interval '600 seconds');
  end if;
  return '{}'::jsonb;
end
$$;

revoke all on function private.hook_send_email(jsonb) from public, anon, authenticated;
grant usage on schema private to supabase_auth_admin;
grant execute on function private.hook_send_email(jsonb) to supabase_auth_admin;
