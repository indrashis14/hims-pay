import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newStudent, makeTerm, setDue, rpc, anonClient, serviceClient } from './helpers.mjs';

const order = async (s, termId) => (await rpc(s.client, 'create_order', { p_term_id: termId }))[0];
const pay = async (client, o, vpa = 'ravi.k@okbank', approve = true) =>
  (await rpc(client, 'mock_upi_pay', {
    p_order_id: o.order_id, p_pay_token: o.pay_token, p_vpa: vpa, p_approve: approve,
  }))[0];
const successCount = async (studentId, termId) => {
  const { count, error } = await serviceClient().from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('student_id', studentId).eq('term_id', termId).eq('status', 'success');
  if (error) throw error;
  return count;
};

test('successful payment produces a bill matching the order', async () => {
  const termId = await makeTerm({ amount: 25000, dueOffsetDays: -12 });
  const s = await newStudent();
  const o = await order(s, termId);
  assert.equal(o.base_inr, 25000);
  assert.equal(o.days_late, 12);
  assert.equal(o.fine_inr, 70);
  assert.equal(o.total_inr, 25070);
  const r = await pay(s.client, o);
  assert.equal(r.status, 'success');
  assert.match(r.utr, /^\d{12}$/);
  assert.match(r.bill_no, /^HIMS-\d{4}-\d{6}$/);
  const bill = await rpc(s.client, 'get_bill', { p_order_id: o.order_id });
  assert.equal(bill.total_inr, 25070);
  assert.equal(bill.fine_inr, 70);
  assert.equal(bill.utr, r.utr);
  assert.equal(bill.student.id, s.user.id);
  assert.equal(bill.payer_vpa, 'ravi.k@okbank');
  assert.equal(await rpc(s.client, 'order_status', { p_order_id: o.order_id }), 'success');
});

test('decline and @fail UPI IDs fail; a fresh order can then succeed', async () => {
  const termId = await makeTerm();
  const s = await newStudent();
  const o1 = await order(s, termId);
  assert.equal((await pay(s.client, o1, 'ravi@okbank', false)).status, 'failed');
  const o2 = await order(s, termId);
  assert.notEqual(o2.order_id, o1.order_id);
  assert.equal((await pay(s.client, o2, 'x.y@FAIL')).status, 'failed');
  const o3 = await order(s, termId);
  assert.equal((await pay(s.client, o3)).status, 'success');
});

test('approving the same order twice at once records one payment', async () => {
  const termId = await makeTerm();
  const s = await newStudent();
  const o = await order(s, termId);
  const [a, b] = await Promise.all([pay(s.client, o), pay(anonClient(), o)]);
  assert.equal(a.status, 'success');
  assert.equal(a.utr, b.utr);
  assert.equal(await successCount(s.user.id, termId), 1);
});

test('two tabs share one order and the term cannot be paid twice', async () => {
  const termId = await makeTerm();
  const s = await newStudent();
  const [o1, o2] = await Promise.all([order(s, termId), order(s, termId)]);
  assert.equal(o1.order_id, o2.order_id);
  assert.equal(o1.pay_token, o2.pay_token);
  await pay(s.client, o1);
  assert.equal((await pay(s.client, o2)).status, 'success');
  await assert.rejects(order(s, termId), /ALREADY_PAID/);
  assert.equal(await successCount(s.user.id, termId), 1);
});

test('wrong pay token, bad UPI ID and expired orders are rejected', async () => {
  const termId = await makeTerm();
  const s = await newStudent();
  const o = await order(s, termId);
  await assert.rejects(pay(anonClient(), { ...o, pay_token: 'nope' }), /BAD_TOKEN/);
  await assert.rejects(pay(s.client, o, 'not-a-vpa'), /BAD_VPA/);
  const { error } = await serviceClient().from('orders')
    .update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', o.order_id);
  assert.ifError(error);
  await assert.rejects(pay(s.client, o), /EXPIRED/);
  assert.equal(await rpc(s.client, 'order_status', { p_order_id: o.order_id }), 'expired');
  const fresh = await order(s, termId);
  assert.notEqual(fresh.order_id, o.order_id);
});

test('blocked after day 20, payable with the full fine on day 20', async () => {
  const termId = await makeTerm({ amount: 1000, dueOffsetDays: -21 });
  const s = await newStudent();
  await assert.rejects(order(s, termId), /BLOCKED/);
  const dues = await rpc(s.client, 'my_dues');
  assert.equal(dues.find((d) => d.term_id === termId).blocked, true);
  await setDue(termId, -20);
  const o = await order(s, termId);
  assert.equal(o.fine_inr, 150);
  assert.equal(o.total_inr, 1150);
});

test('an order created on day 20 can still be paid after the block starts', async () => {
  const termId = await makeTerm({ amount: 1000, dueOffsetDays: -20 });
  const s = await newStudent();
  const o = await order(s, termId);
  await setDue(termId, -21); // midnight passes
  const again = await order(s, termId);
  assert.equal(again.order_id, o.order_id);
  const r = await pay(s.client, o);
  assert.equal(r.status, 'success');
  const bill = await rpc(s.client, 'get_bill', { p_order_id: o.order_id });
  assert.equal(bill.total_inr, 1150);
});

test('arrears are listed and paid separately from the current term', async () => {
  const oldTerm = await makeTerm({ amount: 1000, dueOffsetDays: -5 });
  const s = await newStudent();
  const newTerm = await makeTerm({ amount: 2000, dueOffsetDays: 10 });
  let dues = await rpc(s.client, 'my_dues');
  const old = dues.find((d) => d.term_id === oldTerm);
  const cur = dues.find((d) => d.term_id === newTerm);
  assert.equal(old.fine_inr, 25);
  assert.equal(cur.fine_inr, 0);
  await pay(s.client, await order(s, oldTerm));
  dues = await rpc(s.client, 'my_dues');
  assert.equal(dues.find((d) => d.term_id === oldTerm).paid, true);
  assert.equal(dues.find((d) => d.term_id === newTerm).paid, false);
});

test('a term created before signup cannot be paid', async () => {
  const older = await makeTerm({ dueOffsetDays: -40 });
  await makeTerm({ dueOffsetDays: 5 });
  const s = await newStudent();
  await assert.rejects(order(s, older), /TERM_NOT_OWED/);
});

test("another student cannot see someone's bill or order status", async () => {
  const termId = await makeTerm();
  const a = await newStudent();
  const b = await newStudent();
  const o = await order(a, termId);
  await pay(a.client, o);
  await assert.rejects(rpc(b.client, 'get_bill', { p_order_id: o.order_id }), /NOT_FOUND/);
  assert.equal(await rpc(b.client, 'order_status', { p_order_id: o.order_id }), null);
  const { data } = await b.client.from('orders').select('id');
  assert.deepEqual(data, []);
});

test('the UPI app preview needs the pay token and shows the amount', async () => {
  const termId = await makeTerm({ amount: 4321, dueOffsetDays: 10 });
  const s = await newStudent();
  const o = await order(s, termId);
  const [p] = await rpc(anonClient(), 'mock_upi_preview', { p_order_id: o.order_id, p_pay_token: o.pay_token });
  assert.equal(p.total_inr, 4321);
  assert.equal(p.status, 'pending');
  await assert.rejects(
    rpc(anonClient(), 'mock_upi_preview', { p_order_id: o.order_id, p_pay_token: 'x' }), /BAD_TOKEN/);
});
