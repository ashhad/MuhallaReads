// Library-style rules: no borrowing while a book is overdue, owner-approved renewals (capped), a queue
// for lent-out books, and books marked lost 30 days after they were due.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { makeWorld, AYESHA, BILAL, CHAND } from './helpers.js';

const RIYA = '919800000004';
const DAY = 86400_000;
const understood = { understood: true };

async function world(settings) {
  const w = makeWorld({ settings });
  await w.join(AYESHA, 'Ayesha'); // the admin
  await w.join(BILAL, 'Bilal');
  await w.join(CHAND, 'Chand');
  await w.join(RIYA, 'Riya');
  return w;
}

/** Ayesha lends a book to someone, who picks it up straight away. */
async function lend(w, borrower, title) {
  const { added } = await w.library.addBooks(w.member(AYESHA), [{ title }]);
  const r = await w.library.want(w.member(borrower), added[0].id);
  await w.library.decide(w.member(AYESHA), r.id, true, understood);
  return w.library.handOver(w.member(borrower), r.id);
}

/** As if the member messaged the bot just now, so free-only notices reach them too. */
const active = (w, phone) => w.store.touchInbound(w.member(phone).id, new Date(w.time.now).toISOString());

/** Everything a member has been told, sent now or waiting for their next visit. */
const heard = (w, phone) =>
  [...w.transport.to(phone).map((s) => s.text || ''), ...w.store.pendingInbox(w.member(phone).id).map((i) => i.text)].join('\n');

test('no new borrowing while a book is overdue', async () => {
  const w = await world();
  const loan = await lend(w, BILAL, 'Dune');
  const { added } = await w.library.addBooks(w.member(CHAND), [{ title: 'Ikigai' }, { title: 'Sapiens' }]);
  const asked = await w.library.want(w.member(BILAL), added[0].id); // fine while Dune isn't late

  w.time.now += 22 * DAY;
  await assert.rejects(w.library.want(w.member(BILAL), added[1].id), /Please return \*Dune\* to Ayesha first: it was due on/);
  await assert.rejects(w.library.decide(w.member(CHAND), asked.id, true, understood), /Bilal has a book that's overdue/);

  await w.library.markReturned(w.member(AYESHA), loan.id);
  assert.equal((await w.library.decide(w.member(CHAND), asked.id, true, understood)).status, 'accepted');
});

test('renewals: the owner agrees, a week at a time, at most twice, and not when someone is waiting', async () => {
  const w = await world();
  const { added } = await w.library.addBooks(w.member(AYESHA), [{ title: 'Dune' }]);
  const r = await w.library.want(w.member(BILAL), added[0].id);
  await w.library.decide(w.member(AYESHA), r.id, true, understood);
  await assert.rejects(w.library.askRenewal(w.member(BILAL), r.id), /once you have the book/);
  const loan = await w.library.handOver(w.member(BILAL), r.id);
  const due = Date.parse(loan.due_at);

  w.transport.clear();
  await w.library.askRenewal(w.member(BILAL), r.id);
  assert.match(heard(w, AYESHA), /Bilal asks to keep \*Dune\* one more week/);
  await assert.rejects(w.library.askRenewal(w.member(BILAL), r.id), /already asked Ayesha/);
  await assert.rejects(w.library.answerRenewal(w.member(BILAL), r.id, true), /Only Ayesha/);
  let now = await w.library.answerRenewal(w.member(AYESHA), r.id, true);
  assert.equal(Date.parse(now.due_at), due + 7 * DAY);
  assert.match(heard(w, BILAL), /Ayesha said yes: keep \*Dune\* until/);

  await w.library.askRenewal(w.member(BILAL), r.id);
  now = await w.library.answerRenewal(w.member(AYESHA), r.id, false); // "no" leaves the date alone
  assert.equal(Date.parse(now.due_at), due + 7 * DAY);
  await w.library.askRenewal(w.member(BILAL), r.id);
  await w.library.answerRenewal(w.member(AYESHA), r.id, true);
  await assert.rejects(w.library.askRenewal(w.member(BILAL), r.id), /already had 2 extra weeks, the most allowed/);

  // Someone waiting: no extensions at all.
  const r2 = await lend(w, CHAND, 'Sapiens');
  await w.library.joinQueue(w.member(RIYA), r2.book_id);
  await assert.rejects(w.library.askRenewal(w.member(CHAND), r2.id), /1 person is waiting for \*Sapiens\*, so it can't be extended/);
  assert.equal(w.library.loanView(w.store.requestById(r2.id), w.member(CHAND)).canRenew, false);
});

test('the queue: the first in line is told and the book is kept for them, then the next', async () => {
  const w = await world();
  const loan = await lend(w, BILAL, 'Dune');
  const bookId = loan.book_id;
  await assert.rejects(w.library.want(w.member(CHAND), bookId), /lent out right now\. Join the queue/);
  assert.deepEqual(await w.library.joinQueue(w.member(CHAND), bookId), { waiting: 1, place: 1, keptForMe: false });
  assert.deepEqual(await w.library.joinQueue(w.member(RIYA), bookId), { waiting: 2, place: 2, keptForMe: false });
  await assert.rejects(w.library.joinQueue(w.member(AYESHA), bookId), /your own copy/);

  w.transport.clear();
  w.time.now += 10 * DAY;
  await w.library.runReminders(); // nothing due yet, but the borrower hears people are waiting when reminded
  w.time.now += 10 * DAY;
  await w.library.runReminders();
  assert.match(heard(w, BILAL), /2 people are waiting for it/);

  await w.library.markReturned(w.member(AYESHA), loan.id);
  assert.match(heard(w, CHAND), /\*Dune\* is back with Ayesha \(Green Park Tower, Saket\), and you're first in the queue\. It's kept for you until/);
  await assert.rejects(w.library.want(w.member(RIYA), bookId), /kept for the next person in the queue until/);
  assert.equal(w.library.queueView(bookId, w.member(CHAND)).keptForMe, true);

  // Chand asks; Ayesha can't lend it now after all: it's offered to Riya.
  const asked = await w.library.want(w.member(CHAND), bookId);
  assert.equal(w.library.queueView(bookId, w.member(RIYA)).place, 1);
  await w.library.decide(w.member(AYESHA), asked.id, false);
  assert.match(heard(w, RIYA), /\*Dune\* is back with Ayesha.*you're first in the queue/);

  // Riya doesn't ask within 2 days: her turn passes, and the book is free for anyone.
  w.time.now += 49 * 3600_000;
  active(w, RIYA);
  await w.library.runQueues();
  assert.match(heard(w, RIYA), /Your turn for \*Dune\* has passed/);
  assert.equal(w.store.holdsFor(bookId).length, 0);
  assert.equal((await w.library.want(w.member(BILAL), bookId)).status, 'pending');
});

test('a book 30 days overdue can be marked lost; the borrower settles up before borrowing again', async () => {
  const w = await world();
  const loan = await lend(w, BILAL, 'Dune');
  await w.library.joinQueue(w.member(CHAND), loan.book_id);

  w.time.now += 40 * DAY; // 19 days overdue
  await assert.rejects(w.library.markLost(w.member(AYESHA), loan.id), /You can mark it lost from/);
  assert.equal(w.library.loanView(w.store.requestById(loan.id), w.member(AYESHA)).canMarkLost, false);
  w.time.now += 12 * DAY; // 31 days overdue
  assert.equal(w.library.loanView(w.store.requestById(loan.id), w.member(AYESHA)).canMarkLost, true);
  await assert.rejects(w.library.markLost(w.member(BILAL), loan.id), /Only Ayesha/);

  w.transport.clear();
  active(w, CHAND);
  const lost = await w.library.markLost(w.member(AYESHA), loan.id);
  assert.equal(lost.status, 'lost');
  assert.match(heard(w, BILAL), /Ayesha has marked \*Dune\* as lost.*replace it, or agree a price/s);
  assert.match(heard(w, CHAND), /isn't coming back, so its queue has closed/);
  assert.equal(w.store.search('dune').length, 0); // hidden from searches
  assert.match(w.library.borrowerRecord(w.member(BILAL).id), /1 marked lost/);

  const { added } = await w.library.addBooks(w.member(CHAND), [{ title: 'Ikigai' }]);
  await assert.rejects(w.library.want(w.member(BILAL), added[0].id), /Please settle \*Dune\* with Ayesha first/);
  assert.match(await w.say(BILAL, 'delete me'), /haven't settled \*Dune\* with Ayesha/);
  await w.library.sendMessage(w.member(BILAL), loan.id, 'I will buy you a new copy'); // they can still talk

  await w.library.markSettled(w.member(AYESHA), loan.id);
  assert.equal((await w.library.want(w.member(BILAL), added[0].id)).status, 'pending');
  await w.library.relist(w.member(AYESHA), loan.book_id); // the replacement copy is on the shelf
  assert.equal(w.store.search('dune').length, 1);
});

test('a lost book that turns up counts as a late return', async () => {
  const w = await world();
  const loan = await lend(w, BILAL, 'Dune');
  w.time.now += 52 * DAY;
  await w.library.markLost(w.member(AYESHA), loan.id);
  const back = await w.library.markReturned(w.member(AYESHA), loan.id);
  assert.equal(back.status, 'returned');
  assert.equal(w.store.bookById(loan.book_id).lost_at, null);
  const rec = w.store.memberRecord(w.member(BILAL).id);
  assert.deepEqual([rec.returned, rec.onTime, rec.lost], [1, 0, 0]);
});

test("upgrading an older database allows 'lost' and keeps every loan, message and notification", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mr-')), 'old.db');
  let s = openDb(file);
  const a = s.createMember({ name: 'A', phone: '919811100001' });
  const b = s.createMember({ name: 'B', phone: '919811100002' });
  const book = s.addBooks(a.id, [{ title: 'Old loan' }]).added[0];
  const id = s.createRequest({ bookId: book.id, borrowerId: b.id, ownerId: a.id, note: 'Sunday?' });
  s.updateRequest(id, { status: 'accepted', due_at: '2026-10-22T10:00:00.000Z' });
  s.addMessage(id, b.id, 'Hello');
  s.addInbox(a.id, { text: 'A request', requestId: id });
  // Put back the older table, which didn't allow 'lost' (as SQLite documents for schema changes).
  const sql = s.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'requests'").get().sql;
  s.db.exec('PRAGMA foreign_keys = OFF');
  s.db.exec(sql.replace("'returned', 'lost'", "'returned'").replace('CREATE TABLE requests', 'CREATE TABLE requests_old'));
  s.db.exec('INSERT INTO requests_old SELECT * FROM requests; DROP TABLE requests; ALTER TABLE requests_old RENAME TO requests');
  assert.throws(() => s.db.exec(`UPDATE requests SET status = 'lost' WHERE id = ${id}`), /CHECK/);
  s.db.close();

  s = openDb(file);
  assert.equal(s.requestById(id).note, 'Sunday?');
  assert.equal(s.messagesFor(id)[0].body, 'Hello');
  assert.equal(s.pendingInbox(a.id)[0].request_id, id);
  s.updateRequest(id, { status: 'lost' });
  assert.equal(s.requestById(id).status, 'lost');
  assert.equal(s.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  s.db.close();
});
