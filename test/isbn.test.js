import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIsbn, looksLikeIsbn } from '../src/isbn.js';
import { normalizePhone } from '../src/phone.js';

test('normalizes ISBN-10 and ISBN-13 to the same ISBN-13', () => {
  assert.equal(normalizeIsbn('978-0-06-231500-7'), '9780062315007');
  assert.equal(normalizeIsbn('0062315005'), '9780062315007');
  assert.equal(normalizeIsbn('0-8044-2957-X'), '9780804429573');
  assert.equal(normalizeIsbn('9780062315008'), null); // bad check digit
  assert.equal(normalizeIsbn('hello'), null);
});

test('detects text that is just an ISBN', () => {
  assert.ok(looksLikeIsbn('ISBN 978-0062315007'));
  assert.ok(!looksLikeIsbn('1984'));
  assert.ok(!looksLikeIsbn('The Alchemist'));
});

test('normalizes phone numbers to WhatsApp format', () => {
  assert.equal(normalizePhone('98123 45678', '91'), '919812345678');
  assert.equal(normalizePhone('098123 45678', '91'), '919812345678');
  assert.equal(normalizePhone('+44 7700 900123', '91'), '447700900123');
  assert.equal(normalizePhone('whatsapp:+919812345678', '91'), '919812345678');
  assert.equal(normalizePhone('0091 98123 45678', '91'), '919812345678');
  assert.equal(normalizePhone('123', '91'), null);
});
