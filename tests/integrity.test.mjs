import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newStudent, makeTerm, rpc, serviceClient } from './helpers.mjs';

test('an account with a payment cannot be deleted; one without can', async () => {
  const termId = await makeTerm();
  const paid = await newStudent();
  const [o] = await rpc(paid.client, 'create_order', { p_term_id: termId });
  await rpc(paid.client, 'mock_upi_pay', {
    p_order_id: o.order_id, p_pay_token: o.pay_token, p_vpa: 'ravi@okbank', p_approve: true,
  });
  const svc = serviceClient();
  const { error: blocked } = await svc.auth.admin.deleteUser(paid.user.id);
  assert.ok(blocked, 'deleting an account with a bill must fail');
  const bill = await rpc(paid.client, 'get_bill', { p_order_id: o.order_id });
  assert.equal(bill.status, 'success');

  const unpaid = await newStudent();
  const { error } = await svc.auth.admin.deleteUser(unpaid.user.id);
  assert.ifError(error);
});

test('changing the login email updates the student record', async () => {
  await makeTerm();
  const s = await newStudent();
  const newEmail = `moved-${Date.now()}@test.invalid`;
  const { error } = await serviceClient().auth.admin.updateUserById(s.user.id, { email: newEmail, email_confirm: true });
  assert.ifError(error);
  assert.equal((await rpc(s.client, 'whoami')).student.email, newEmail);
  const reuse = await newStudent({ email: s.email });
  assert.ifError(reuse.error, 'the old address is free for a new signup');
});
