// Safeguards so books come back: the borrowing limit, the lender's own-risk confirmation, the
// borrower's record, reminders that escalate, and no deleting an account while holding a book.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { makeWorld, baseSettings, AYESHA, BILAL, CHAND } from './helpers.js';
import { TERMS_VERSION } from '../src/terms.js';

const RIYA = '919800000004';
const DAY = 86400_000;
const understood = { understood: true };

/** Everything a member has been told: messages sent now, and ones waiting for their next visit. */
const heard = (w, phone) =>
  [...w.transport.to(phone).map((s) => s.text || ''), ...w.store.pendingInbox(w.member(phone).id).map((i) => i.text)].join('\n');

async function world(settings) {
  const w = makeWorld({ settings });
  await w.join(AYESHA, 'Ayesha'); // the admin
  await w.join(BILAL, 'Bilal', 'Sunrise Apartments');
  await w.join(CHAND, 'Chand', 'Lotus Heights');
  return w;
}

const lend = async (w, owner, borrower, title) => {
  const { added } = await w.library.addBooks(w.member(owner), [{ title }]);
  const r = await w.library.want(w.member(borrower), added[0].id);
  await w.library.decide(w.member(owner), r.id, true, understood);
  return w.library.handOver(w.member(borrower), r.id); // picked up straight away
};

test('nobody can have more than 2 books borrowed at once', async () => {
  const w = await world();
  await lend(w, AYESHA, CHAND, 'Dune');
  await lend(w, BILAL, CHAND, 'Ikigai');
  const { added } = await w.library.addBooks(w.member(AYESHA), [{ title: 'Sapiens' }]);
  await assert.rejects(w.library.want(w.member(CHAND), added[0].id), /already borrowing 2 books/);

  // A request made before the limit was reached can't be accepted past it either.
  const w2 = await world();
  const { added: books } = await w2.library.addBooks(w2.member(AYESHA), [{ title: 'A' }, { title: 'B' }, { title: 'C' }]);
  const asks = [];
  for (const b of books) asks.push(await w2.library.want(w2.member(CHAND), b.id));
  await w2.library.decide(w2.member(AYESHA), asks[0].id, true, understood);
  await w2.library.decide(w2.member(AYESHA), asks[1].id, true, understood);
  await assert.rejects(w2.library.decide(w2.member(AYESHA), asks[2].id, true, understood), /Chand already has 2 borrowed books/);

  // Returning one frees a place.
  await w2.library.handOver(w2.member(CHAND), asks[0].id);
  await w2.library.markReturned(w2.member(AYESHA), asks[0].id);
  assert.equal((await w2.library.decide(w2.member(AYESHA), asks[2].id, true, understood)).status, 'accepted');
});

test('lending needs the owner to confirm it is at their own risk', async () => {
  const w = await world();
  const { added } = await w.library.addBooks(w.member(AYESHA), [{ title: 'Dune' }]);
  const r = await w.library.want(w.member(BILAL), added[0].id);
  await assert.rejects(w.library.decide(w.member(AYESHA), r.id, true), /own risk/);
  const ok = await w.library.decide(w.member(AYESHA), r.id, true, understood);
  assert.ok(ok.owner_risk_at);
});

test("the owner sees the borrower's record with each request", async () => {
  const w = await world();
  w.transport.clear();
  const { added } = await w.library.addBooks(w.member(BILAL), [{ title: 'Dune' }, { title: 'Ikigai' }]);
  const r = await w.library.want(w.member(CHAND), added[0].id);
  assert.match(w.transport.to(BILAL).at(-1).text, /📋 First time borrowing/);
  await w.library.decide(w.member(BILAL), r.id, true, understood);
  await w.library.handOver(w.member(CHAND), r.id);
  await w.library.markReturned(w.member(BILAL), r.id);
  w.transport.clear();
  await w.library.want(w.member(CHAND), added[1].id);
  assert.match(w.transport.to(BILAL).at(-1).text, /📋 Returned 1 of 1 on time/);
});

test('overdue books: weekly reminders, the owner told once, admins and the inviter after 2 weeks', async () => {
  const w = await world();
  // Riya joins with Chand's invite link.
  const code = w.store.refCodeFor(w.member(CHAND).id);
  await w.say(RIYA, `join ${code}`, { profileName: 'Riya' });
  await w.say(RIYA, 'I agree');
  await w.say(RIYA, 'skip');
  await w.say(RIYA, 'Bani Park');
  w.store.setMemberStatus(w.member(RIYA).id, 'active');

  const loan = await lend(w, BILAL, RIYA, 'Dune'); // due in 21 days
  w.transport.clear();
  const at = (days) => w.library.runReminders(new Date(Date.parse(loan.decided_at) + days * DAY));

  assert.equal(await at(19.5), 1); // due soon
  assert.doesNotMatch(heard(w, BILAL), /hasn't returned/);
  assert.equal(await at(24.5), 1); // 3 days overdue
  assert.match(heard(w, BILAL), /Riya hasn't returned \*Dune\* yet/);
  assert.equal(await at(25), 0);
  assert.equal(await at(31.5), 1); // a week later
  assert.equal((heard(w, BILAL).match(/hasn't returned/g) || []).length, 1); // the owner is told once

  assert.doesNotMatch(heard(w, AYESHA), /overdue with/);
  assert.equal(await at(35.5), 0); // 14 days overdue: no borrower reminder today, but escalation
  assert.match(heard(w, AYESHA), /\*Dune\*, lent by Bilal \(Sunrise Apartments, Saket\), is 14 days overdue with Riya \(Bani Park\), who was invited by Chand/);
  assert.match(heard(w, CHAND), /Riya, whom you invited, has had Bilal's book \*Dune\* for 14 days past its return date/);
  await at(36);
  assert.equal((heard(w, AYESHA).match(/overdue with/g) || []).length, 1); // once
  assert.equal(await at(38.5), 1); // and the weekly reminders go on
});

test("you can't delete your account while holding someone's book", async () => {
  const w = await world();
  const loan = await lend(w, AYESHA, BILAL, 'Dune');
  assert.match(await w.say(BILAL, 'delete me'), /You still have \*Dune\* from Ayesha\. Please return it first/);
  assert.match(await w.say(BILAL, 'delete everything'), /Send \*delete me\* first/);
  assert.ok(w.member(BILAL));

  await w.library.markReturned(w.member(AYESHA), loan.id);
  assert.match(await w.say(BILAL, 'delete me'), /DELETE EVERYTHING/);
  assert.match(await w.say(BILAL, 'delete everything'), /deleted/);
  assert.equal(w.member(BILAL), undefined);

  // An admin can still remove someone, and is told what they were holding.
  await lend(w, AYESHA, CHAND, 'Ikigai');
  assert.match(await w.say(AYESHA, `remove member ${w.member(CHAND).id}`), /They still had \*Ikigai\* from Ayesha/);
});

test('over the API: terms first, delete refused while borrowing', async () => {
  const s = openDb(':memory:');
  const app = createApp({ store: s, settings: { ...baseSettings, whatsapp: {} }, deps: { transport: null } });
  const srv = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (path, token, opts = {}) => {
    const res = await fetch(base + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: opts.body && JSON.stringify(opts.body),
    });
    return { status: res.status, data: await res.json() };
  };
  try {
    const owner = s.createMember({ name: 'Ayesha', phone: AYESHA });
    s.setPlace(owner.id, { building: 'Green Park Tower', locality: 'Saket' });
    const a = s.createSession(owner.id);
    // An older member who hasn't agreed to the Terms yet: can look, but not add, borrow or lend.
    assert.equal((await call('/api/me', a)).data.member.termsAccepted, false);
    const refused = await call('/api/books', a, { method: 'POST', body: { books: [{ title: 'Dune' }] } });
    assert.equal(refused.status, 403);
    assert.equal(refused.data.code, 'terms');
    assert.equal((await call('/api/terms', a, { method: 'POST', body: {} })).status, 400);
    assert.equal((await call('/api/terms', a, { method: 'POST', body: { agree: true } })).data.member.termsAccepted, true);
    const added = await call('/api/books', a, { method: 'POST', body: { books: [{ title: 'Dune' }] } });
    assert.equal(added.status, 200);

    const borrower = s.createMember({ name: 'Bilal', phone: BILAL });
    s.setPlace(borrower.id, { building: 'Sunrise Apartments', locality: 'Saket' });
    s.acceptTerms(borrower.id);
    const b = s.createSession(borrower.id);
    const bookId = s.booksOf(owner.id)[0].id;
    const req = await call('/api/requests', b, { method: 'POST', body: { bookId } });
    await call(`/api/requests/${req.data.request.id}/accept`, a, { method: 'POST', body: understood });
    const del = await call('/api/me', b, { method: 'DELETE' });
    assert.equal(del.status, 400);
    assert.match(del.data.error, /You still have Dune from Ayesha/);
    assert.ok(s.memberById(borrower.id));
  } finally {
    srv.close();
  }
});

test('agreeing to the Terms is recorded with the version and where; no loan starts without both agreeing', async () => {
  const w = await world();
  const ayesha = w.member(AYESHA);
  assert.equal(ayesha.terms_version, TERMS_VERSION);
  assert.equal(ayesha.terms_via, 'whatsapp'); // she agreed when joining on WhatsApp
  assert.ok(ayesha.terms_at);

  // Bilal asked for Dune before the Terms existed (or before they changed), and hasn't agreed since.
  const { added } = await w.library.addBooks(ayesha, [{ title: 'Dune' }]);
  const r = await w.library.want(w.member(BILAL), added[0].id);
  w.store.q('UPDATE members SET terms_version = ? WHERE id = ?').run('2020-01-01', w.member(BILAL).id);
  w.transport.clear();
  await assert.rejects(w.library.decide(w.member(AYESHA), r.id, true, understood), /Bilal hasn't agreed to the Terms yet/);
  assert.match(w.transport.to(BILAL)[0].text, /Ayesha would like to lend you \*Dune\*\. Please open the app and agree to the Terms first/);
  assert.equal(w.store.requestById(r.id).status, 'pending');

  // Nor can he ask for more books or add his own until he agrees.
  const { added: more } = await w.library.addBooks(ayesha, [{ title: 'Sapiens' }]);
  await assert.rejects(w.library.want(w.member(BILAL), more[0].id), /agree to the Terms/);
  await assert.rejects(w.library.addBooks(w.member(BILAL), [{ title: 'Ikigai' }]), /agree to the Terms/);

  w.store.acceptTerms(w.member(BILAL).id, { via: 'app' });
  assert.equal((await w.library.decide(w.member(AYESHA), r.id, true, understood)).status, 'accepted');
});

test('when the Terms change, members are asked to agree again', async () => {
  const s = openDb(':memory:');
  const app = createApp({ store: s, settings: { ...baseSettings, whatsapp: {} }, deps: { transport: null } });
  const srv = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const m = s.createMember({ name: 'Ayesha', phone: AYESHA });
    s.setPlace(m.id, { building: 'Green Park Tower', locality: 'Saket' });
    s.acceptTerms(m.id, { version: '2026-01-01' }); // an older version
    const token = s.createSession(m.id);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const me = await (await fetch(`${base}/api/me`, { headers })).json();
    assert.equal(me.member.termsAccepted, false);
    assert.equal(me.member.termsChanged, true);
    const add = await fetch(`${base}/api/books`, { method: 'POST', headers, body: JSON.stringify({ books: [{ title: 'Dune' }] }) });
    assert.equal(add.status, 403);
    await fetch(`${base}/api/terms`, { method: 'POST', headers, body: JSON.stringify({ agree: true }) });
    const now = s.memberById(m.id);
    assert.equal(now.terms_version, TERMS_VERSION);
    assert.equal(now.terms_via, 'app');
  } finally {
    srv.close();
  }
});
