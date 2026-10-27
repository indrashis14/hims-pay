import { execSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

const status = JSON.parse(
  execSync('npx supabase status -o json', { stdio: ['ignore', 'pipe', 'ignore'] }).toString(),
);

export const LOCAL = {
  url: status.API_URL,
  anonKey: status.ANON_KEY,
  serviceKey: status.SERVICE_ROLE_KEY,
};

const noPersist = { auth: { persistSession: false, autoRefreshToken: false } };

export const anonClient = () => createClient(LOCAL.url, LOCAL.anonKey, noPersist);
export const serviceClient = () => createClient(LOCAL.url, LOCAL.serviceKey, noPersist);

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${process.pid}${seq++}`;
export const uniquePhone = () =>
  '9' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');

export async function newStudent(overrides = {}) {
  const email = overrides.email ?? `s-${uniq()}@test.invalid`;
  const phone = overrides.phone ?? uniquePhone();
  const password = overrides.password ?? 'Passw0rd!x';
  const fullName = overrides.fullName ?? 'Test Student';
  const client = anonClient();
  const { data, error } = await client.auth.signUp({
    email, password, options: { data: { full_name: fullName, phone } },
  });
  return { client, user: data?.user, error, email, phone, password };
}

export async function makeTerm({ amount = 1000, dueOffsetDays = 30, name } = {}) {
  const today = new Date(Date.now() + 5.5 * 3600e3); // IST calendar date
  today.setUTCDate(today.getUTCDate() + dueOffsetDays);
  const due = today.toISOString().slice(0, 10);
  const { data, error } = await serviceClient()
    .from('fee_terms')
    .insert({ name: name ?? `Term ${uniq()}`, amount_inr: amount, due_date: due })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export async function setDue(termId, dueOffsetDays) {
  const d = new Date(Date.now() + 5.5 * 3600e3);
  d.setUTCDate(d.getUTCDate() + dueOffsetDays);
  const { error } = await serviceClient()
    .from('fee_terms').update({ due_date: d.toISOString().slice(0, 10) }).eq('id', termId);
  if (error) throw error;
}

export async function makeAdmin() {
  const svc = serviceClient();
  const email = `admin-${uniq()}@test.invalid`;
  const password = 'Adm1nPassw0rd!';
  const { data, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const { error: e2 } = await svc.from('admins').insert({ user_id: data.user.id });
  if (e2) throw e2;
  const client = anonClient();
  const { error: e3 } = await client.auth.signInWithPassword({ email, password });
  if (e3) throw e3;
  return { client, email, password, id: data.user.id };
}

export async function rpc(client, fn, args) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw Object.assign(new Error(error.message), { code: error.code, raw: error });
  return data;
}
