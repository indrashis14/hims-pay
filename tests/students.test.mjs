import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newStudent, makeTerm, rpc, anonClient, uniquePhone } from './helpers.mjs';

test('signup creates a student whose id is the auth uuid', async () => {
  const s = await newStudent();
  assert.ifError(s.error);
  assert.match(s.user.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const me = await rpc(s.client, 'whoami');
  assert.equal(me.role, 'student');
  assert.equal(me.student.id, s.user.id);
  assert.equal(me.student.phone, s.phone);
});

test('signup rejects a duplicate phone', async () => {
  const a = await newStudent();
  assert.ifError(a.error);
  const b = await newStudent({ phone: a.phone });
  assert.ok(b.error, 'second signup with same phone must fail');
});

test('signup rejects a duplicate email', async () => {
  const a = await newStudent();
  assert.ifError(a.error);
  const b = await newStudent({ email: a.email });
  assert.ok(b.error, 'second signup with same email must fail');
});

test('signup rejects a phone that is not 10 digits starting 6-9', async () => {
  for (const phone of ['+919876543210', '5876543210', '98765']) {
    const s = await newStudent({ phone });
    assert.ok(s.error, `phone ${phone} must be rejected`);
  }
});

test('a student can only read their own student row', async () => {
  const a = await newStudent();
  await newStudent();
  const { data, error } = await a.client.from('students').select('id');
  assert.ifError(error);
  assert.deepEqual(data.map((r) => r.id), [a.user.id]);
});

test('anon cannot call student RPCs', async () => {
  const { error } = await anonClient().rpc('my_dues');
  assert.ok(error);
});

test('my_dues lists the owed term with the late fine', async () => {
  const termId = await makeTerm({ amount: 1000, dueOffsetDays: -3 });
  const s = await newStudent();
  const dues = await rpc(s.client, 'my_dues');
  const row = dues.find((d) => d.term_id === termId);
  assert.ok(row, 'term must be listed');
  assert.equal(row.days_late, 3);
  assert.equal(row.fine_inr, 15);
  assert.equal(row.total_inr, 1015);
  assert.equal(row.paid, false);
  assert.equal(row.blocked, false);
});

test('terms that closed before signup are not owed', async () => {
  const older = await makeTerm({ dueOffsetDays: -60 });
  const active = await makeTerm({ dueOffsetDays: 10 });
  const s = await newStudent();
  const ids = (await rpc(s.client, 'my_dues')).map((d) => d.term_id);
  assert.ok(ids.includes(active));
  assert.ok(!ids.includes(older));
});
