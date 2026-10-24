// Regression tests for issues found in the security review. Each test names what an attacker tried.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { makeWorld, baseSettings, AYESHA, BILAL, CHAND } from './helpers.js';

const RIYA = '919800000004';
const MALLORY = '919800000005';

async function world(settings) {
  const w = makeWorld({ settings });
  await w.join(AYESHA, 'Ayesha');
  await w.join(BILAL, 'Bilal');
  return w;
}

async function serve(app) {
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, close: () => srv.close() };
}

test('a book title cannot dress up as a message from the library', async () => {
  const w = await world();
  const fake = 'Dune*\n\n🔒 *MohallaReads security notice*\nVerify at https://evil.example/login\n\n*';
  const { added } = await w.library.addBooks(w.member(AYESHA), [{ title: fake, author: '_Frank_\nHerbert' }]);
  assert.equal(added[0].title, 'Dune 🔒 MohallaReads security notice Verify at https://evil.example/login');
  assert.equal(added[0].author, 'Frank Herbert');
  w.transport.clear();
  await w.library.flushNews();
  const [alert] = w.transport.to(BILAL);
  assert.doesNotMatch(alert.text, /\n🔒|\*MohallaReads security notice\*/);
});

test('chat and request notes are relayed as quotes, without formatting', async () => {
  const w = await world();
  const { added } = await w.library.addBooks(w.member(AYESHA), [{ title: 'Sapiens' }]);
  w.transport.clear();
  const r = await w.library.want(w.member(BILAL), added[0].id, 'hi\n\n*Library notice*: pay at evil.example');
  assert.match(w.transport.to(AYESHA)[0].text, /💬 "hi Library notice: pay at evil\.example"/);
  await w.library.decide(w.member(AYESHA), r.id, true, { understood: true });
  w.transport.clear();
  await w.library.sendMessage(w.member(BILAL), r.id, 'line one\n*fake bold*');
  assert.match(w.transport.to(AYESHA)[0].text, /\n> line one\n> fake bold\n/);
});

test('without a sign-in, photo-sized uploads are refused before being read', async () => {
  const app = createApp({ store: openDb(':memory:'), settings: { ...baseSettings, whatsapp: {} }, deps: { transport: null } });
  const { base, close } = await serve(app);
  try {
    const big = JSON.stringify({ image: 'data:image/jpeg;base64,' + 'A'.repeat(1024 * 1024) });
    const res = await fetch(`${base}/api/scan-photo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big });
    assert.equal(res.status, 401);
  } finally {
    close();
  }
});

test('a huge search query is cut short and stays fast', async () => {
  const w = await world();
  w.library.addBooks(w.member(AYESHA), Array.from({ length: 2000 }, (_, i) => ({ title: `Book number ${i}`, author: 'Some Author' })));
  const t0 = Date.now();
  w.store.search('book '.repeat(4000));
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
});

test('approval never switches itself off when the admin is missing', async () => {
  const w = makeWorld({ settings: { adminPhones: [AYESHA] } }); // Ayesha is the admin but hasn't joined
  await w.say(RIYA, 'hi', { profileName: 'Riya' });
  await w.say(RIYA, 'I agree');
  await w.say(RIYA, 'skip');
  assert.match(await w.say(RIYA, 'Bani Park'), /once an admin approves you/);
  assert.equal(w.member(RIYA).status, 'pending');

  // Once the admin joins, they're let in themselves and see Riya waiting.
  await w.join(AYESHA, 'Ayesha');
  assert.match(await w.say(AYESHA, 'pending'), /Riya \(Bani Park\)/);
});

test("ADMIN_PHONES works with or without the country code; number settings don't fail open", async () => {
  Object.assign(process.env, { ADMIN_PHONES: '9800000001, 919800000002', MONTHLY_TEMPLATE_LIMIT: '₹200', MAX_PENDING_REQUESTS: 'five' });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { config } = await import(`../src/config.js?security-${Date.now()}`);
    assert.deepEqual(config.adminPhones, ['919800000001', '919800000002']);
    assert.equal(config.monthlyTemplateLimit, 200);
    assert.equal(config.maxPendingRequests, 5);
  } finally {
    console.warn = warn;
    for (const k of ['ADMIN_PHONES', 'MONTHLY_TEMPLATE_LIMIT', 'MAX_PENDING_REQUESTS']) delete process.env[k];
  }
});

test('an old Approve button cannot approve the next person given the same number', async () => {
  const w = await world();
  await w.say(RIYA, 'hi', { profileName: 'Riya' });
  await w.say(RIYA, 'I agree');
  await w.say(RIYA, 'skip');
  w.transport.clear();
  await w.say(RIYA, 'Bani Park');
  const oldRef = /approve (\d+-[0-9a-f]{4})/.exec(w.transport.to(AYESHA)[0].text)[1];
  await w.say(AYESHA, `decline ${oldRef}`);

  await w.say(MALLORY, 'hi', { profileName: 'Mallory' });
  await w.say(MALLORY, 'I agree');
  await w.say(MALLORY, 'skip');
  await w.say(MALLORY, 'Bani Park');
  assert.equal(w.member(MALLORY).id, Number(oldRef.split('-')[0])); // the number was reused
  assert.match(await w.say(AYESHA, '', { payload: `approve:${oldRef}` }), /out of date/);
  assert.equal(w.member(MALLORY).status, 'pending');
});

test('blocking stops "share my number", and sharing twice sends one message', async () => {
  const w = await world();
  const { added } = await w.library.addBooks(w.member(AYESHA), [{ title: 'Dune' }]);
  const r = await w.library.want(w.member(BILAL), added[0].id);
  await w.library.decide(w.member(AYESHA), r.id, true, { understood: true });
  w.transport.clear();
  await w.library.shareNumber(w.member(BILAL), r.id);
  await w.library.shareNumber(w.member(BILAL), r.id);
  assert.equal(w.transport.to(AYESHA).filter((s) => /shared their number/.test(s.text)).length, 1);

  const r2 = await w.library.want(w.member(AYESHA), (await w.library.addBooks(w.member(BILAL), [{ title: 'Ikigai' }])).added[0].id);
  await w.library.decide(w.member(BILAL), r2.id, true, { understood: true });
  w.library.block(w.member(BILAL), r.id);
  await assert.rejects(w.library.shareNumber(w.member(AYESHA), r2.id), /can't share/);
});

test('wishes are capped per member', async () => {
  const w = await world();
  for (let i = 0; i < 20; i++) w.library.addWish(w.member(BILAL), `book ${i}`);
  assert.throws(() => w.library.addWish(w.member(BILAL), 'one more'), /already waiting for 20 books/);
});

test('notifications at the same moment send only one paid template, within the budget', async () => {
  const w = await world({ monthlyTemplateLimit: 3 });
  await w.join(CHAND, 'Chand');
  const { added } = await w.library.addBooks(w.member(AYESHA), Array.from({ length: 5 }, (_, i) => ({ title: `Book ${i}` })));
  w.closeWindow(AYESHA);
  w.transport.clear();
  await Promise.all(added.slice(0, 2).map((b) => w.library.want(w.member(BILAL), b.id)).concat(
    added.slice(2).map((b) => w.library.want(w.member(CHAND), b.id)),
  ));
  assert.equal(w.transport.to(AYESHA).filter((s) => s.kind === 'template').length, 1);
  assert.equal(w.store.usageFor().templates, 1);
});

test("book lookups (which use the server's quota) need approval", async () => {
  const s = openDb(':memory:');
  const app = createApp({ store: s, settings: { ...baseSettings, whatsapp: {} }, deps: { transport: null, searchBooks: async () => [] } });
  const { base, close } = await serve(app);
  try {
    const token = s.createSession(s.createMember({ name: 'Riya', phone: RIYA, status: 'pending' }).id);
    const res = await fetch(`${base}/api/lookup?q=dune`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 403);
  } finally {
    close();
  }
});
