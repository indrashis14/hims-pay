import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Students and the admin keep separate sessions in the same browser.
let student, admin;

export function studentClient() {
  student ??= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { storageKey: 'hims-student' } });
  return student;
}

export function adminClient() {
  admin ??= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { storageKey: 'hims-admin' } });
  return admin;
}

// Anonymous client for the simulated UPI app, which never logs in.
export function publicClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, storageKey: 'hims-public' },
  });
}

export async function call(client, fn, args) {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw error;
  return data;
}
