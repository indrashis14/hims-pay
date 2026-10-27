import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newStudent, makeTerm, makeAdmin, rpc, anonClient } from './helpers.mjs';

const outboxFor = async (admin, email) =>
  (await rpc(admin.client, 'admin_outbox')).filter((r) => r.email === email);

test('reset for an unknown email looks the same and stores nothing', async () => {
  const admin = await makeAdmin();
  const email = `nobody-${Date.now()}@test.invalid`;
  const { error } = await anonClient().auth.resetPasswordForEmail(email);
  assert.equal(error, null);
  assert.deepEqual(await outboxFor(admin, email), []);
});

test('the outbox code resets the password and ends other sessions', async () => {
  await makeTerm();
  const admin = await makeAdmin();
  const s = await newStudent();
  const { error } = await anonClient().auth.resetPasswordForEmail(s.email);
  assert.equal(error, null);

  const rows = await outboxFor(admin, s.email);
  assert.equal(rows.length, 1);
  assert.match(rows[0].code, /^\d{6}$/);
  assert.equal(rows[0].full_name, 'Test Student');

  const c = anonClient();
  const { error: badErr } = await c.auth.verifyOtp({ email: s.email, token: '000000', type: 'recovery' });
  assert.ok(badErr, 'wrong code must fail');
  const { error: vErr } = await c.auth.verifyOtp({ email: s.email, token: rows[0].code, type: 'recovery' });
  assert.ifError(vErr);
  const newPassword = 'N3wPassw0rd!x';
  assert.ifError((await c.auth.updateUser({ password: newPassword })).error);
  assert.ifError((await c.auth.signOut({ scope: 'others' })).error);

  const { error: refreshErr } = await s.client.auth.refreshSession();
  assert.ok(refreshErr, 'the old session must not refresh');
  const { error: oldErr } = await anonClient().auth.signInWithPassword({ email: s.email, password: s.password });
  assert.ok(oldErr, 'old password must fail');
  const { error: newErr } = await anonClient().auth.signInWithPassword({ email: s.email, password: newPassword });
  assert.ifError(newErr);

  const { error: reuseErr } = await anonClient().auth.verifyOtp({ email: s.email, token: rows[0].code, type: 'recovery' });
  assert.ok(reuseErr, 'a code works once');
});
