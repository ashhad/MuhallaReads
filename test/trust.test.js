// Trust: badges, books lent only to "Never overdue" readers, member cards, and hand-overs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { makeWorld, baseSettings, AYESHA, BILAL, CHAND } from './helpers.js';

const DEV = '919800000006';
const RIYA = '919800000004';
const DAY = 86400_000;
const understood = { understood: true };

async function world() {
  const w = makeWorld();
  await w.join(AYESHA, 'Ayesha'); // the admin, Green Park Tower
  await w.join(BILAL, 'Bilal');
  await w.join(CHAND, 'Chand');
  await w.join(RIYA, 'Riya');
  await w.join(DEV, 'Dev', 'Lotus Heights');
  return w;
}

async function loan(w, owner, borrower, title) {
  const { added } = await w.library.addBooks(w.member(owner), [{ title }]);
  const r = await w.library.want(w.member(borrower), added[0].id);
  return w.library.decide(w.member(owner), r.id, true, understood);
}

async function lendAndReturn(w, owner, borrower, title, { late = false } = {}) {
  const r = await loan(w, owner, borrower, title);
  await w.library.handOver(w.member(borrower), r.id);
  if (late) w.time.now += 25 * DAY;
  await w.library.markReturned(w.member(owner), r.id);
}

const badges = (w, phone) => w.library.badgesFor(w.member(phone));

test('badges are earned: Fresh off the press, Never overdue, Bestseller, Classic', async () => {
  const w = await world();
  assert.deepEqual(badges(w, BILAL), ['fresh']);

  for (let i = 0; i < 3; i++) await lendAndReturn(w, AYESHA, BILAL, `Borrowed ${i}`);
  assert.deepEqual(badges(w, BILAL), ['neverOverdue', 'fresh']);
  for (let i = 0; i < 5; i++) await lendAndReturn(w, BILAL, CHAND, `Lent ${i}`);
  assert.deepEqual(badges(w, BILAL), ['neverOverdue', 'bestseller', 'fresh']);

  w.time.now += 91 * DAY;
  assert.deepEqual(badges(w, BILAL), ['classic', 'neverOverdue', 'bestseller']);

  // One late return, and "Never overdue" (and so Classic) is gone.
  await lendAndReturn(w, AYESHA, BILAL, 'Late one', { late: true });
  assert.deepEqual(badges(w, BILAL), ['bestseller']);
});

test('an owner can lend a book only to Never overdue readers', async () => {
  const w = await world();
  const { added } = await w.library.addBooks(w.member(AYESHA), [{ title: 'First Edition' }]);
  w.store.setNeverOverdueOnly(w.member(AYESHA).id, added[0].id, true);
  assert.equal(w.store.search('first edition')[0].copies[0].neverOverdueOnly, true);
  await assert.rejects(
    w.library.want(w.member(BILAL), added[0].id),
    /Ayesha lends \*First Edition\* only to 📗 Never overdue readers: people who've returned 3 or more books, all on time/,
  );
  for (let i = 0; i < 3; i++) await lendAndReturn(w, CHAND, BILAL, `Borrowed ${i}`);
  assert.equal((await w.library.want(w.member(BILAL), added[0].id)).status, 'pending');
});

test('the loan period starts at the hand-over; calling off before it never counts', async () => {
  const w = await world();
  const t0 = w.time.now;
  const r = await loan(w, AYESHA, BILAL, 'Dune');
  assert.equal(r.handed_over_at, null);
  assert.equal(Date.parse(r.due_at), t0 + 24 * DAY); // 21 days plus 3 to pick it up, if nobody confirms

  w.time.now += 2 * DAY;
  w.store.touchInbound(w.member(AYESHA).id, new Date(w.time.now).toISOString()); // she messaged the bot just now
  w.transport.clear();
  const got = await w.library.handOver(w.member(BILAL), r.id);
  assert.equal(Date.parse(got.due_at), t0 + 23 * DAY); // 21 days from the hand-over
  assert.match(w.transport.to(AYESHA)[0].text, /Bilal has \*Dune\* now/);
  await assert.rejects(w.library.cancel(w.member(AYESHA), r.id), /Only the person who asked/); // too late to call off

  // Another loan, called off before the book changes hands: not a return, not a lend.
  const r2 = await loan(w, AYESHA, CHAND, 'Sapiens');
  assert.equal((await w.library.cancel(w.member(CHAND), r2.id)).status, 'cancelled');
  assert.equal(w.store.bookById(r2.book_id).status, 'available');
  const r3 = await w.library.want(w.member(CHAND), r2.book_id);
  await w.library.decide(w.member(AYESHA), r3.id, true, understood);
  assert.equal((await w.library.markReturned(w.member(AYESHA), r3.id)).status, 'cancelled'); // it never left
  const rec = w.store.memberRecord(w.member(CHAND).id);
  assert.equal(rec.returned, 0);
  assert.equal(w.store.memberRecord(w.member(AYESHA).id).lent, 1); // only Dune changed hands

  // If nobody confirms, the loan counts as handed over 3 days after it was accepted.
  const r4 = await w.library.want(w.member(CHAND), r2.book_id);
  const accepted = await w.library.decide(w.member(AYESHA), r4.id, true, understood);
  w.time.now += 4 * DAY;
  await w.library.runReminders();
  assert.equal(w.store.requestById(r4.id).handed_over_at, new Date(Date.parse(accepted.decided_at) + 3 * DAY).toISOString());
  assert.equal((await w.library.markReturned(w.member(AYESHA), r4.id)).status, 'returned');
});

test('loans from before hand-overs existed count as handed over (once, when upgrading)', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mr-')), 'old.db');
  let s = openDb(file);
  const a = s.createMember({ name: 'A', phone: '919811100001' });
  const b = s.createMember({ name: 'B', phone: '919811100002' });
  const book = s.addBooks(a.id, [{ title: 'Old loan' }]).added[0];
  const id = s.createRequest({ bookId: book.id, borrowerId: b.id, ownerId: a.id });
  s.updateRequest(id, { status: 'accepted', decided_at: '2026-10-01T10:00:00.000Z', due_at: '2026-10-22T10:00:00.000Z' });
  s.db.exec('ALTER TABLE requests DROP COLUMN handed_over_at'); // as an older database
  s.db.close();

  s = openDb(file);
  assert.equal(s.requestById(id).handed_over_at, '2026-10-01T10:00:00.000Z');
  const book2 = s.addBooks(a.id, [{ title: 'New loan' }]).added[0];
  const id2 = s.createRequest({ bookId: book2.id, borrowerId: b.id, ownerId: a.id });
  s.updateRequest(id2, { status: 'accepted', decided_at: new Date().toISOString() });
  s.db.close();
  s = openDb(file);
  assert.equal(s.requestById(id2).handed_over_at, null); // later restarts leave new loans alone
  s.db.close();
});

test('member cards show badges and counts, never a phone number', async () => {
  const s = openDb(':memory:');
  const app = createApp({ store: s, settings: { ...baseSettings, whatsapp: {} }, deps: { transport: null } });
  const srv = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const make = (name, phone) => {
    const m = s.createMember({ name, phone });
    s.setPlace(m.id, { building: 'Green Park Tower', locality: 'Saket' });
    s.acceptTerms(m.id);
    return { id: m.id, token: s.createSession(m.id) };
  };
  const call = async (p, token, opts = {}) => {
    const res = await fetch(base + p, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: opts.body && JSON.stringify(opts.body),
    });
    const raw = await res.text();
    return { status: res.status, data: JSON.parse(raw), raw };
  };
  try {
    const admin = make('Ayesha', AYESHA);
    const bilal = make('Bilal', BILAL);
    const card = await call(`/api/members/${bilal.id}`, admin.token);
    assert.equal(card.data.profile.name, 'Bilal');
    assert.deepEqual(card.data.profile.badges, ['fresh']);
    assert.equal(card.data.profile.books, 0);
    assert.doesNotMatch(card.raw, /9198000/);
    assert.equal((await call(`/api/members/${bilal.id}`, bilal.token)).data.profile.isMe, true);
    assert.deepEqual((await call('/api/me', bilal.token)).data.member.badges, ['fresh']);

    const book = await call('/api/books', admin.token, { method: 'POST', body: { books: [{ title: 'Dune' }] } });
    const bookId = book.data.added[0].id;
    const only = await call(`/api/books/${bookId}`, admin.token, { method: 'PATCH', body: { neverOverdueOnly: true } });
    assert.equal(only.data.book.never_overdue_only, 1);
    assert.equal((await call(`/api/books/${bookId}`, bilal.token, { method: 'PATCH', body: { neverOverdueOnly: false } })).status, 404); // not his
    const refused = await call('/api/requests', bilal.token, { method: 'POST', body: { bookId } });
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /only to 📗 Never overdue readers/);
  } finally {
    srv.close();
  }
});

test('upgrading from the short-lived "verified neighbours" version keeps book choices, drops vouches', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mr-')), 'old.db');
  let s = openDb(file);
  const a = s.createMember({ name: 'A', phone: '919811100001' });
  const book = s.addBooks(a.id, [{ title: 'Treasured' }]).added[0];
  s.setNeverOverdueOnly(a.id, book.id, true);
  // As that version stored it:
  s.db.exec('ALTER TABLE books RENAME COLUMN never_overdue_only TO verified_only');
  s.db.exec("ALTER TABLE members ADD COLUMN verified_place TEXT; ALTER TABLE members ADD COLUMN verified_at TEXT; ALTER TABLE members ADD COLUMN verified_by INTEGER");
  s.db.exec('CREATE TABLE vouches (member_id INTEGER, voucher_id INTEGER, building TEXT, created_at TEXT)');
  s.db.close();

  s = openDb(file);
  assert.equal(s.bookById(book.id).never_overdue_only, 1);
  const memberCols = s.db.prepare('PRAGMA table_info(members)').all().map((c) => c.name);
  assert.ok(!memberCols.includes('verified_place'));
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'vouches'").get().n, 0);
  s.db.close();
});
