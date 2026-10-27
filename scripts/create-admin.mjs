#!/usr/bin/env node
// Create (or promote) the admin account. Needs the service-role key, which
// must never be committed or put in the website.
//
//   node scripts/create-admin.mjs --url https://xyz.supabase.co \
//     --service-key <SERVICE_ROLE_KEY> --email admin@example.com --password '...'
import { parseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';

const { values: a } = parseArgs({
  options: {
    url: { type: 'string' }, 'service-key': { type: 'string' },
    email: { type: 'string' }, password: { type: 'string' },
  },
});
if (!a.url || !a['service-key'] || !a.email || !a.password) {
  console.error('usage: create-admin.mjs --url URL --service-key KEY --email EMAIL --password PASSWORD');
  process.exit(2);
}
if (a.password.length < 12) {
  console.error('Use an admin password of at least 12 characters.');
  process.exit(2);
}

const svc = createClient(a.url, a['service-key'], {
  auth: { persistSession: false, autoRefreshToken: false },
});
const email = a.email.toLowerCase();

let user;
for (let page = 1; !user; page++) {
  const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) throw error;
  user = data.users.find((u) => u.email === email);
  if (data.users.length < 1000) break;
}
if (user) {
  const { error } = await svc.auth.admin.updateUserById(user.id, { password: a.password });
  if (error) throw error;
} else {
  const { data, error } = await svc.auth.admin.createUser({
    email, password: a.password, email_confirm: true,
  });
  if (error) throw error;
  user = data.user;
}

// An admin is never also a student.
let { error } = await svc.from('students').delete().eq('id', user.id);
if (error) throw error;
({ error } = await svc.from('admins').upsert({ user_id: user.id }));
if (error) throw error;
console.log(`Admin ready: ${email} (${user.id})`);
