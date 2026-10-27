import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { newStudent, makeTerm, setDue, makeAdmin, rpc, anonClient, serviceClient, LOCAL } from './helpers.mjs';

const order = async (s, termId) => (await rpc(s.client, 'create_order', { p_term_id: termId }))[0];
const pay = async (s, o) => (await rpc(s.client, 'mock_upi_pay', {
  p_order_id: o.order_id, p_pay_token: o.pay_token, p_vpa: 'ravi@okbank', p_approve: true,
}))[0];

const ADMIN_CALLS = [
  ['admin_terms', {}],
  ['admin_save_term', { p_id: null, p_name: 'x', p_amount_inr: 1, p_due_date: '2026-12-01' }],
  ['admin_stats', { p_term_id: null }],
  ['admin_students', {}],
  ['admin_payments', {}],
  ['admin_unblock', { p_student_id: '00000000-0000-4000-8000-000000000000', p_term_id: 1 }],
  ['admin_outbox', {}],
];

test('students get FORBIDDEN from every admin RPC', async () => {
  await makeTerm();
  const s = await newStudent();
  for (const [fn, args] of ADMIN_CALLS) {
    await assert.rejects(rpc(s.client, fn, args), /FORBIDDEN/, fn);
  }
});

test('the admin account is not a student', async () => {
  const termId = await makeTerm();
  const admin = await makeAdmin();
  assert.equal((await rpc(admin.client, 'whoami')).role, 'admin');
  await assert.rejects(order(admin, termId), /NOT_A_STUDENT/);
  await assert.rejects(rpc(admin.client, 'my_dues'), /NOT_A_STUDENT/);
});

test('stats count paid, paid late and unpaid students and split collections', async () => {
  const termId = await makeTerm({ amount: 3000, dueOffsetDays: 5 });
  const admin = await makeAdmin();
  const before = await rpc(admin.client, 'admin_stats', { p_term_id: termId });
  const [onTime, late, unpaid] = [await newStudent(), await newStudent(), await newStudent()];
  await pay(onTime, await order(onTime, termId));
  await setDue(termId, -5);
  await pay(late, await order(late, termId));

  const st = await rpc(admin.client, 'admin_stats', { p_term_id: termId });
  assert.equal(st.registered, before.registered + 3);
  assert.equal(st.paid, 2);
  assert.equal(st.paid_on_time, 1);
  assert.equal(st.paid_late, 1);
  assert.equal(st.unpaid, st.registered - 2);
  assert.equal(st.in_fine_window, st.unpaid);
  assert.equal(st.blocked, 0);
  assert.equal(st.collected_base, 6000);
  assert.equal(st.collected_fine, 25);
  assert.equal(st.collected_total, 6025);
  assert.equal(st.per_day.length, 1);
  assert.equal(st.per_day[0].count, 2);
  assert.equal(st.term.id, termId);

  const row = (await rpc(admin.client, 'admin_students', {
    p_term_id: termId, p_filter: 'all', p_search: unpaid.email,
  }))[0];
  assert.equal(row.status, 'fine_window');
  assert.equal(row.fine_inr, 25);
});

test('student filters and search', async () => {
  const termId = await makeTerm({ amount: 500, dueOffsetDays: 3 });
  const admin = await makeAdmin();
  const tag = `Zeta${Date.now()}`;
  const paid = await newStudent({ fullName: `${tag} Paid` });
  const owing = await newStudent({ fullName: `${tag} Owing` });
  await pay(paid, await order(paid, termId));
  const list = (filter) => rpc(admin.client, 'admin_students', {
    p_term_id: termId, p_filter: filter, p_search: tag,
  });
  assert.deepEqual((await list('all')).map((r) => r.full_name), [`${tag} Owing`, `${tag} Paid`]);
  assert.deepEqual((await list('paid')).map((r) => r.student_id), [paid.user.id]);
  assert.deepEqual((await list('unpaid')).map((r) => r.student_id), [owing.user.id]);
  assert.equal((await list('paid'))[0].total_count, 1);
  const byPhone = await rpc(admin.client, 'admin_students', { p_term_id: termId, p_search: owing.phone });
  assert.equal(byPhone[0].student_id, owing.user.id);

  const pays = await rpc(admin.client, 'admin_payments', { p_term_id: termId });
  assert.equal(pays.length, 1);
  assert.equal(pays[0].student_id, paid.user.id);
  const bill = await rpc(admin.client, 'get_bill', { p_order_id: pays[0].order_id });
  assert.equal(bill.total_inr, 500);
});

test('failed payments only show when asked for', async () => {
  const termId = await makeTerm();
  const admin = await makeAdmin();
  const s = await newStudent();
  const o = await order(s, termId);
  await rpc(s.client, 'mock_upi_pay', {
    p_order_id: o.order_id, p_pay_token: o.pay_token, p_vpa: 'ravi@okbank', p_approve: false,
  });
  assert.equal((await rpc(admin.client, 'admin_payments', { p_term_id: termId })).length, 0);
  const all = await rpc(admin.client, 'admin_payments', { p_term_id: termId, p_include_failed: true });
  assert.equal(all.length, 1);
  assert.equal(all[0].status, 'failed');
  assert.equal(all[0].failed_reason, 'Declined in UPI app');
});

test('unblock lets a blocked student pay with the ₹150 cap', async () => {
  const termId = await makeTerm({ amount: 1000, dueOffsetDays: -30 });
  const admin = await makeAdmin();
  const s = await newStudent();
  await assert.rejects(order(s, termId), /BLOCKED/);
  let row = (await rpc(admin.client, 'admin_students', { p_term_id: termId, p_search: s.email }))[0];
  assert.equal(row.status, 'blocked');
  await rpc(admin.client, 'admin_unblock', { p_student_id: s.user.id, p_term_id: termId });
  row = (await rpc(admin.client, 'admin_students', { p_term_id: termId, p_search: s.email }))[0];
  assert.equal(row.status, 'fine_window');
  const o = await order(s, termId);
  assert.equal(o.days_late, 30);
  assert.equal(o.fine_inr, 150);
  assert.equal((await pay(s, o)).status, 'success');
});

test('editing the active term keeps the amount on a pending order', async () => {
  const admin = await makeAdmin();
  const termId = await rpc(admin.client, 'admin_save_term', {
    p_id: null, p_name: 'Edit test', p_amount_inr: 1000, p_due_date: '2099-01-01',
  });
  const s = await newStudent();
  const o = await order(s, termId);
  await rpc(admin.client, 'admin_save_term', {
    p_id: termId, p_name: 'Edit test', p_amount_inr: 2000, p_due_date: '2099-01-01',
  });
  await pay(s, o);
  assert.equal((await rpc(s.client, 'get_bill', { p_order_id: o.order_id })).total_inr, 1000);
  const later = await newStudent();
  assert.equal((await order(later, termId)).total_inr, 2000);
});

test('only the active term can be edited, and bad values are refused', async () => {
  const admin = await makeAdmin();
  const older = await makeTerm();
  await makeTerm();
  await assert.rejects(rpc(admin.client, 'admin_save_term', {
    p_id: older, p_name: 'x', p_amount_inr: 10, p_due_date: '2099-01-01',
  }), /NOT_ACTIVE_TERM/);
  await assert.rejects(rpc(admin.client, 'admin_save_term', {
    p_id: null, p_name: 'x', p_amount_inr: 0, p_due_date: '2099-01-01',
  }), /BAD_AMOUNT/);
  await assert.rejects(rpc(admin.client, 'admin_save_term', {
    p_id: null, p_name: '  ', p_amount_inr: 10, p_due_date: '2099-01-01',
  }), /BAD_NAME/);
  const terms = await rpc(admin.client, 'admin_terms');
  assert.ok(terms[0].id > terms[1].id, 'newest first');
});

test('a login from before the account became admin does not get admin rights', async () => {
  await makeTerm();
  const s = await newStudent();
  await new Promise((r) => setTimeout(r, 1100)); // token iat is in whole seconds
  const { error } = await serviceClient().from('admins').insert({ user_id: s.user.id });
  assert.ifError(error);
  assert.equal((await rpc(s.client, 'whoami')).role, 'student');
  await assert.rejects(rpc(s.client, 'admin_stats', { p_term_id: null }), /FORBIDDEN/);
  const fresh = anonClient();
  assert.ifError((await fresh.auth.signInWithPassword({ email: s.email, password: s.password })).error);
  assert.equal((await rpc(fresh, 'whoami')).role, 'admin');
});

test('create-admin refuses an email that already has a non-admin account', async () => {
  const s = await newStudent();
  const run = (email, password) => spawnSync('node', ['scripts/create-admin.mjs', '--url', LOCAL.url,
    '--service-key', LOCAL.serviceKey, '--email', email, '--password', password], { encoding: 'utf8' });
  const refused = run(s.email, 'SomeAdminPass#1');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Refusing/);
  assert.equal((await rpc(s.client, 'whoami')).role, 'student');

  const email = `newadmin-${Date.now()}@test.invalid`;
  const created = run(email, 'SomeAdminPass#1');
  assert.equal(created.status, 0, created.stderr);
  const again = run(email, 'OtherAdminPass#2');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /password updated/);
  const c = anonClient();
  assert.ifError((await c.auth.signInWithPassword({ email, password: 'OtherAdminPass#2' })).error);
  assert.equal((await rpc(c, 'whoami')).role, 'admin');
});
