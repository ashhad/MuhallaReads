import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { baseSettings, fakeTransport, AYESHA, BILAL } from './helpers.js';

let server;
let base;
let store;
const transport = fakeTransport();

before(async () => {
  store = openDb(':memory:');
  const app = createApp({
    store,
    settings: { ...baseSettings, whatsapp: { displayNumber: '919900000000' } },
    deps: {
      transport,
      enrichAll: async (b) => b,
      identifyBooks: async () => [{ title: 'Ikigai', author: '', isbn: null }],
      lookupIsbn: async () => ({ title: 'The Alchemist', author: 'Paulo Coelho', isbn: '9780062315007', cover: null }),
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
  const text = await res.text();
  return { status: res.status, data: JSON.parse(text), raw: text };
};

async function signIn(phone, name, place = { building: 'Green Park Tower', locality: 'Saket' }) {
  const m = store.memberByPhone(phone) || store.createMember({ name, phone });
  if (place) store.setPlace(m.id, place);
  const { data } = await call('/api/login', { method: 'POST', body: { code: store.createLoginCode(m.id) } });
  return data.token;
}

test('sign-in links work once and the config exposes no personal data', async () => {
  const cfg = await call('/api/config');
  assert.equal(cfg.data.whatsappNumber, '919900000000');
  const m = store.createMember({ name: 'Temp', phone: '919811111111' });
  const code = store.createLoginCode(m.id);
  assert.equal((await call('/api/login', { method: 'POST', body: { code } })).status, 200);
  assert.equal((await call('/api/login', { method: 'POST', body: { code } })).status, 401);
  assert.equal((await call('/api/books')).status, 401);
});

test('borrowing over the API never leaks phone numbers until shared', async () => {
  const a = await signIn(AYESHA, 'Ayesha');
  const b = await signIn(BILAL, 'Bilal');

  const lookup = await call('/api/lookup?isbn=0062315005', { token: a });
  const added = await call('/api/books', { method: 'POST', token: a, body: { books: [lookup.data.results[0], { title: 'Dune' }] } });
  assert.equal(added.data.added.length, 2);
  const dune = added.data.added.find((x) => x.title === 'Dune');

  const search = await call('/api/books?q=dune', { token: b });
  assert.deepEqual(search.data.results[0].copies[0].owner, { id: store.memberByPhone(AYESHA).id, name: 'Ayesha', place: 'Green Park Tower, Saket' });
  assert.doesNotMatch(search.raw, /9198000/);

  const req = await call('/api/requests', { method: 'POST', token: b, body: { bookId: dune.id, note: 'Sunday?' } });
  assert.equal(req.data.request.status, 'pending');
  const id = req.data.request.id;
  assert.equal(transport.to(AYESHA).at(-1).name, 'book_request'); // Ayesha never messaged the bot

  assert.equal((await call(`/api/requests/${id}/accept`, { method: 'POST', token: b })).status, 400); // not the owner
  const acc = await call(`/api/requests/${id}/accept`, { method: 'POST', token: a });
  assert.equal(acc.data.request.status, 'accepted');

  await call(`/api/requests/${id}/messages`, { method: 'POST', token: b, body: { body: 'Hi! Block D here.' } });
  const thread = await call(`/api/requests/${id}/messages`, { token: a });
  assert.equal(thread.data.messages[0].body, 'Hi! Block D here.');
  assert.equal(thread.data.messages[0].mine, false);
  assert.equal(thread.data.request.otherPhone, null);
  assert.doesNotMatch((await call('/api/requests', { token: a })).raw, /9198000/);

  await call(`/api/requests/${id}/share`, { method: 'POST', token: b });
  assert.equal((await call(`/api/requests/${id}/messages`, { token: a })).data.request.otherPhone, BILAL);
  assert.equal((await call(`/api/requests/${id}/messages`, { token: b })).data.request.otherPhone, null); // Ayesha didn't share

  const ret = await call(`/api/requests/${id}/returned`, { method: 'POST', token: a });
  assert.equal(ret.data.request.status, 'returned');

  const scan = await call('/api/scan-photo', { method: 'POST', token: a, body: { image: 'data:image/jpeg;base64,eA==' } });
  assert.equal(scan.data.results[0].title, 'Ikigai');
});

test('wishes, rename and account deletion', async () => {
  const t = await signIn('919822222222', 'Chand');
  await call('/api/wishes', { method: 'POST', token: t, body: { query: 'Gitanjali' } });
  assert.equal((await call('/api/wishes', { token: t })).data.wishes[0].query, 'Gitanjali');
  assert.equal((await call('/api/me', { method: 'PATCH', token: t, body: { name: 'Chand (Block E)' } })).data.member.name, 'Chand (Block E)');
  assert.equal((await call('/api/me', { method: 'PATCH', token: t, body: { name: '' } })).status, 400);
  await call('/api/me', { method: 'DELETE', token: t });
  assert.equal((await call('/api/me', { token: t })).status, 401);
  assert.equal(store.memberByPhone('919822222222'), undefined);
});

test('a building or locality is required before adding or requesting books', async () => {
  const t = await signIn('919833333333', 'Dev', null);
  const me = (await call('/api/me', { token: t })).data.member;
  assert.equal(me.place, '');
  const blocked = await call('/api/books', { method: 'POST', token: t, body: { books: [{ title: 'Ikigai' }] } });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /building or locality/);

  assert.equal((await call('/api/me', { method: 'PATCH', token: t, body: { building: '', locality: ' ' } })).status, 400);
  const ok = await call('/api/me', { method: 'PATCH', token: t, body: { building: '', locality: 'Saket' } });
  assert.equal(ok.data.member.place, 'Saket');
  assert.equal((await call('/api/books', { method: 'POST', token: t, body: { books: [{ title: 'Ikigai' }] } })).status, 200);
});
