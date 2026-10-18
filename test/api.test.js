import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';

let server;
let base;

before(async () => {
  const app = createApp({
    store: openDb(':memory:'),
    settings: { communityName: 'Test', joinCode: 'abc', whatsapp: {}, twilio: {} },
    deps: {
      enrichAll: async (b) => b,
      identifyBooks: async () => [{ title: 'Ikigai', author: '', isbn: null }],
      lookupIsbn: async (isbn) => ({ title: 'The Alchemist', author: 'Paulo Coelho', isbn: '9780062315007', cover: null }),
      searchBooks: async () => [],
    },
  });
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (path, { token, method = 'GET', body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
};

test('join, add, search and manage books over the API', async () => {
  assert.equal((await call('/api/join', { method: 'POST', body: { name: 'A', phone: '9800000001', code: 'nope' } })).status, 403);
  const a = (await call('/api/join', { method: 'POST', body: { name: 'Ayesha', phone: '98000 00001', code: 'abc' } })).data;
  assert.equal(a.member.phone, '919800000001');
  const b = (await call('/api/join', { method: 'POST', body: { name: 'Bilal', phone: '+91 98000 00002', code: 'abc' } })).data;

  assert.equal((await call('/api/books')).status, 401);

  const lookup = await call('/api/lookup?isbn=0062315005', { token: a.token });
  assert.equal(lookup.data.results[0].title, 'The Alchemist');

  const added = await call('/api/books', {
    method: 'POST',
    token: a.token,
    body: { books: [lookup.data.results[0], { title: 'Dune', author: 'Frank Herbert' }, { title: '' }] },
  });
  assert.equal(added.data.added.length, 2);

  await call('/api/books', { method: 'POST', token: b.token, body: { books: [{ title: 'dune', author: 'Frank Herbert' }] } });
  const dune = (await call('/api/books?q=herbert', { token: b.token })).data.results;
  assert.equal(dune.length, 1);
  assert.deepEqual(dune[0].copies.map((c) => c.owner.name).sort(), ['Ayesha', 'Bilal']);

  const scan = await call('/api/scan-photo', { method: 'POST', token: a.token, body: { image: 'data:image/jpeg;base64,eA==' } });
  assert.equal(scan.data.results[0].title, 'Ikigai');

  const mine = (await call('/api/my-books', { token: a.token })).data.books;
  const id = mine.find((x) => x.title === 'Dune').id;
  assert.equal((await call(`/api/books/${id}`, { method: 'PATCH', token: b.token, body: { status: 'lent' } })).status, 404);
  assert.equal((await call(`/api/books/${id}`, { method: 'PATCH', token: a.token, body: { status: 'lent' } })).data.book.status, 'lent');
  assert.equal((await call(`/api/books/${id}`, { method: 'DELETE', token: a.token })).status, 200);
  assert.equal((await call('/api/my-books', { token: a.token })).data.books.length, 1);
});

test('WhatsApp webhook verification', async () => {
  const res = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
  assert.equal(res.status, 403);
});
