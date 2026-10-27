import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, isValidEmail, isValidVpa } from '../site/js/validate.js';

test('normalizePhone accepts common Indian formats', () => {
  assert.equal(normalizePhone('+91 98765 43210'), '9876543210');
  assert.equal(normalizePhone('098765-43210'), '9876543210');
  assert.equal(normalizePhone('919876543210'), '9876543210');
  assert.equal(normalizePhone('98765-43210'), '9876543210');
});

test('normalizePhone rejects invalid numbers', () => {
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('5876543210'), null);
  assert.equal(normalizePhone(''), null);
});

test('email and VPA checks', () => {
  assert.equal(isValidEmail('ravi@example.com'), true);
  assert.equal(isValidEmail('ravi@example'), false);
  assert.equal(isValidVpa('ravi.k@okbank'), true);
  assert.equal(isValidVpa('a@fail'), false);
  assert.equal(isValidVpa('no-at-sign'), false);
});
