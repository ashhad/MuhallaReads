import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { baseSettings, fakeTransport, AYESHA, BILAL } from './helpers.js';

let server;
let base;
let store;
let bookInfoCalls = 0;
const transport = fakeTransport();

before(async () => {
  store = openDb(':memory:');
  const app = createApp({
    store,
    settings: { ...baseSettings, whatsapp: { displayNumber: '919900000000' } },
    deps: {
      transport,
      enrichAll: async (b) => b,
      identifyBooks: async () => ({ books: [{ title: 'Ikigai', author: '', isbn: null }], costUsd: 0.001 }),
      lookupIsbn: async () => ({ title: 'The Alchemist', author: 'Paulo Coelho', isbn: '9780062315007', cover: null }),
      searchBooks: async () => [],
      bookDetails: async () => (bookInfoCalls++, { description: 'A boy, a dream.', published: '1988', pages: 208, genres: [], source: 'Google Books' }),
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

test('book card details are looked up once, then cached', async () => {
  const t = await signIn('919833333333', 'Dev');
  const url = '/api/book-info?title=The%20Alchemist&author=Paulo%20Coelho';
  assert.equal((await call(url, { token: t })).data.info.description, 'A boy, a dream.');
  await call(url.replace('The%20Alchemist', 'the%20alchemist'), { token: t }); // same book
  assert.equal(bookInfoCalls, 1);
  assert.equal((await call('/api/book-info', { token: t })).status, 400);
  assert.equal((await call(url)).status, 401); // members only
});

test('photo results that were hard to read, or not found anywhere, come back unticked', async () => {
  const { createApp } = await import('../src/server.js');
  const s = openDb(':memory:');
  const app = createApp({
    store: s,
    settings: { ...baseSettings, whatsapp: {} },
    deps: {
      transport: null,
      identifyBooks: async () => ({
        costUsd: 0,
        books: [
          { title: 'Against the Gods', author: '', isbn: null, sure: true },
          { title: 'Temple of Gods', author: '', isbn: null, sure: false },
          { title: 'Why Things Aren’t', author: '', isbn: null, sure: true },
        ],
      }),
      enrichAll: async (books) => books.map((b) => ({ ...b, matched: b.title !== 'Why Things Aren’t' })),
    },
  });
  const srv = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
  const m = s.createMember({ name: 'Esha', phone: '919811111199' });
  s.setPlace(m.id, { building: 'B', locality: 'Saket' });
  const token = s.createSession(m.id);
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/scan-photo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ image: 'data:image/jpeg;base64,eA==' }),
  });
  srv.close();
  const { results } = await res.json();
  assert.deepEqual(results.map((b) => [b.title, b.checked]), [
    ['Against the Gods', true],
    ['Temple of Gods', false],
    ['Why Things Aren’t', false],
  ]);
});

test('the app files are always revalidated, so phones pick up updates', async () => {
  for (const file of ['/', '/app.js', '/style.css']) {
    const res = await fetch(base + file);
    assert.equal(res.headers.get('cache-control'), 'no-cache', file);
  }
});

test('newcomers waiting for approval can browse titles only; an admin approves them in the app', async () => {
  const owner = await signIn('919844444444', 'Owen');
  await call('/api/books', { method: 'POST', token: owner, body: { books: [{ title: 'Malgudi Days', author: 'R. K. Narayan' }] } });

  const newbie = store.createMember({ name: 'Riya', phone: '919855555555', status: 'pending', joinedVia: 'code' });
  store.setPlace(newbie.id, { building: '', locality: 'Bani Park' });
  const t = await signIn('919855555555', 'Riya', null);

  const me = (await call('/api/me', { token: t })).data.member;
  assert.equal(me.status, 'pending');
  assert.equal(me.invite, null);
  const hit = (await call('/api/books?q=malgudi', { token: t })).data.results[0];
  assert.equal(hit.title, 'Malgudi Days');
  assert.equal(hit.copies[0].owner, null); // no owner names yet
  for (const [path, body] of [
    ['/api/books', { books: [{ title: 'X' }] }],
    ['/api/requests', { bookId: hit.copies[0].bookId }],
    ['/api/wishes', { query: 'Dune' }],
  ]) {
    assert.equal((await call(path, { method: 'POST', token: t, body })).status, 403, path);
  }

  // Ayesha is an admin: she sees Riya waiting and approves her.
  const admin = await signIn(AYESHA, 'Ayesha');
  const pending = (await call('/api/me', { token: admin })).data.member.pending;
  assert.deepEqual(pending.find((p) => p.id === newbie.id), { id: newbie.id, name: 'Riya', place: 'Bani Park', invitedBy: null, since: newbie.created_at });
  assert.equal((await call(`/api/admin/members/${newbie.id}/approve`, { method: 'POST', token: owner })).status, 403); // not an admin
  assert.equal((await call(`/api/admin/members/${newbie.id}/approve`, { method: 'POST', token: admin })).status, 200);

  const after = (await call('/api/me', { token: t })).data.member;
  assert.equal(after.status, 'active');
  assert.match(after.invite, /^[a-z0-9]{7}$/);
  assert.equal((await call('/api/books?q=malgudi', { token: t })).data.results[0].copies[0].owner.name, 'Owen');
});

test('members can turn new-book alerts off in the app', async () => {
  const t = await signIn('919866666666', 'Neel');
  assert.equal((await call('/api/me', { token: t })).data.member.bookAlerts, true);
  const off = await call('/api/me', { method: 'PATCH', token: t, body: { bookAlerts: false } });
  assert.equal(off.data.member.bookAlerts, false);
});

// ---------- security ----------

test('security headers are sent on pages and the API', async () => {
  for (const path of ['/', '/api/config']) {
    const h = (await fetch(base + path)).headers;
    assert.match(h.get('content-security-policy'), /script-src 'self'; .*frame-ancestors 'none'/, path);
    assert.equal(h.get('x-content-type-options'), 'nosniff');
    assert.equal(h.get('x-frame-options'), 'DENY');
    assert.equal(h.get('referrer-policy'), 'no-referrer');
  }
});

test('big requests are refused except photo uploads', async () => {
  const big = 'x'.repeat(300 * 1024);
  assert.equal((await call('/api/login', { method: 'POST', body: { code: big } })).status, 413);
  const t = await signIn('919877777777', 'Ira');
  const photo = await call('/api/scan-photo', { method: 'POST', token: t, body: { image: `data:image/jpeg;base64,${big}` } });
  assert.equal(photo.status, 200); // a few hundred KB photo is fine
});

test('covers from unknown sites are dropped', async () => {
  const t = await signIn('919888888888', 'Jai');
  const { data } = await call('/api/books', {
    method: 'POST',
    token: t,
    body: { books: [
      { title: 'Tracker Book', cover: 'https://evil.example/pixel.gif' },
      { title: 'Real Cover', cover: 'https://covers.openlibrary.org/b/id/1-M.jpg' },
    ] },
  });
  assert.deepEqual(data.added.map((b) => b.cover_url), [null, 'https://covers.openlibrary.org/b/id/1-M.jpg']);
});

test('sessions end after 60 days unused, and "sign out everywhere" ends them all', async () => {
  const phone = '919899999999';
  const a = await signIn(phone, 'Kabir');
  const b = await signIn(phone, 'Kabir');
  assert.equal((await call('/api/me', { token: b })).status, 200);
  assert.equal((await call('/api/logout-everywhere', { method: 'POST', token: a })).status, 200);
  assert.equal((await call('/api/me', { token: b })).status, 401);

  const c = await signIn(phone, 'Kabir');
  store.db.prepare('UPDATE sessions SET last_used_at = ? WHERE token = ?').run(new Date(Date.now() - 61 * 86400_000).toISOString(), c);
  assert.equal((await call('/api/me', { token: c })).status, 401);
});

test('failed sign-ins are limited per address; successful ones and other members are not affected', async () => {
  const s = openDb(':memory:');
  const app = createApp({ store: s, settings: { ...baseSettings, whatsapp: {} }, deps: { transport: null } });
  const srv = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
  const port = srv.address().port;
  const login = async (code) =>
    (await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).status;
  const m = s.createMember({ name: 'Lata', phone: '919812345678' });
  try {
    for (let i = 0; i < 3; i++) assert.equal(await login(s.createLoginCode(m.id)), 200); // successes don't count
    const failures = [];
    for (let i = 0; i < 6; i++) failures.push(await login('nope'));
    assert.deepEqual(failures, [401, 401, 401, 401, 401, 429]);
    assert.equal(await login(s.createLoginCode(m.id)), 429); // blocked for a while, even with a good link

    // A signed-in member is limited to 60 requests a minute.
    const token = s.createSession(m.id);
    const statuses = [];
    for (let i = 0; i < 61; i++) {
      statuses.push((await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).status);
    }
    assert.equal(statuses.at(-2), 200);
    assert.equal(statuses.at(-1), 429);
  } finally {
    srv.close();
  }
});
