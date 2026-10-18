import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanName } from '../src/bot.js';
import { LibraryError } from '../src/library.js';
import { makeWorld, AYESHA, BILAL, CHAND } from './helpers.js';

const SITE = 'https://books.example.org';

async function twoMembers(opts) {
  const w = makeWorld(opts);
  await w.join(AYESHA, 'Ayesha', 'Green Park Tower', 'Saket');
  await w.join(BILAL, 'Bilal', 'Sunrise Apartments', 'Saket');
  return w;
}

/** Ayesha owns Dune (added in the app). */
async function withDune(opts) {
  const w = await twoMembers(opts);
  const { added } = await w.library.addBooks(w.member(AYESHA), [{ title: 'Dune', author: 'Frank Herbert' }]);
  return { w, dune: added[0] };
}

// ---------- account management on WhatsApp ----------

test('cleans display names', () => {
  assert.equal(cleanName('  *Ayesha*\n (Block C) '), 'Ayesha (Block C)');
  assert.equal(cleanName('x'), '');
});

test('join code is required when configured', async () => {
  const w = makeWorld({ settings: { joinCode: 'books42' } });
  assert.match(await w.say(AYESHA, 'hello'), /join <code>/);
  assert.equal(w.member(AYESHA), undefined);
  assert.match(await w.say(AYESHA, 'join BOOKS42', { profileName: 'Ayesha' }), /Welcome, Ayesha[\s\S]*building or society/);
  assert.ok(w.member(AYESHA));
});

test('setup asks for building then locality, then hands over to the app', async () => {
  const w = makeWorld();
  assert.match(await w.say(AYESHA, 'hi', { profileName: 'Ayesha' }), /Welcome, Ayesha[\s\S]*building or society[\s\S]*Skip=skip/);
  assert.match(await w.say(AYESHA, '', { payload: 'skip' }), /locality or area/);
  assert.match(await w.say(AYESHA, 'skip'), /at least your locality/);
  assert.match(await w.say(AYESHA, '', { payload: 'accept:3' }), /finish setting you up/); // old button isn't a locality
  assert.match(await w.say(AYESHA, 'login'), /finish setting you up/);
  const done = await w.say(AYESHA, 'Saket');
  assert.match(done, /All set! Neighbours will see you as \*Ayesha \(Saket\)\*/);
  assert.match(done, new RegExp(`<Open MohallaReads: ${SITE}/#login=[\\w-]+>`));
  assert.equal(w.member(AYESHA).locality, 'Saket');

  await w.say(BILAL, 'hi', { profileName: 'Bilal' });
  await w.say(BILAL, 'Sunrise Apartments');
  assert.match(await w.say(BILAL, 'skip'), /Bilal \(Sunrise Apartments\)/);
});

test('members without a location are asked for it before anything else', async () => {
  const w = makeWorld();
  w.store.createMember({ name: 'Old Member', phone: AYESHA }); // e.g. created on the website by an admin
  assert.match(await w.say(AYESHA, 'dune'), /building or society/);
});

test('name, building and locality can be changed, keeping a location', async () => {
  const w = await twoMembers();
  assert.match(await w.say(AYESHA, 'name Ayesha K'), /Ayesha K \(Green Park Tower, Saket\)/);
  assert.match(await w.say(AYESHA, 'building Lotus Heights'), /Ayesha K \(Lotus Heights, Saket\)/);
  assert.match(await w.say(AYESHA, 'locality none'), /Ayesha K \(Lotus Heights\)/);
  assert.match(await w.say(AYESHA, 'building none'), /Keep at least one/);
  assert.match(await w.say(AYESHA, 'area Malviya Nagar'), /Lotus Heights, Malviya Nagar/);
});

test('login gives a one-time sign-in button', async () => {
  const w = await twoMembers();
  const r = await w.say(BILAL, 'login');
  const code = /#login=([\w-]+)>/.exec(r)[1];
  assert.equal(w.store.consumeLoginCode(code), w.member(BILAL).id);
  assert.equal(w.store.consumeLoginCode(code), null);
});

test('searching, adding, photos and old buttons all point to the app', async () => {
  const w = await twoMembers();
  for (const msg of [{ text: 'dune' }, { text: 'add Dune by Frank Herbert' }, { text: 'hi' }, { payload: 'want:12' }]) {
    const r = await w.say(AYESHA, msg.text || '', msg);
    assert.match(r, /happen in the app/);
    assert.match(r, /<Open MohallaReads: .*#login=/);
  }
  assert.match(await w.say(AYESHA, '', { other: 'image' }), /scan the barcode or type the title/);
  assert.equal(w.store.booksOf(w.member(AYESHA).id).length, 0); // nothing is added over WhatsApp
});

test('help, admin commands and account deletion', async () => {
  const w = await twoMembers();
  assert.match(await w.say(AYESHA, 'help'), /Admin: `stats`/); // Ayesha is an admin in the test settings
  assert.doesNotMatch(await w.say(BILAL, 'help'), /Admin/);
  assert.match(await w.say(AYESHA, 'stats'), /2 members/);
  assert.match(await w.say(BILAL, 'stats'), /happen in the app/); // not an admin
  assert.match(await w.say(AYESHA, 'members'), /Bilal/);

  await w.library.addBooks(w.member(BILAL), [{ title: 'Ikigai' }]);
  assert.match(await w.say(BILAL, 'delete everything'), /Send \*delete me\* first/);
  await w.say(BILAL, 'delete me');
  assert.match(await w.say(BILAL, 'delete everything'), /deleted/);
  assert.equal(w.member(BILAL), undefined);
  assert.equal(w.store.search('ikigai').length, 0);
});

// ---------- notifications ----------

test('a request notifies the owner with a button to the app, never a phone number', async () => {
  const { w, dune } = await withDune();
  w.closeWindow(AYESHA);
  w.transport.clear();

  // Ayesha hasn't messaged in 2 days, so she gets one paid template whose button opens the request.
  const r = await w.library.want(w.member(BILAL), dune.id, 'Sunday?');
  const [tpl] = w.transport.to(AYESHA);
  assert.equal(tpl.kind, 'template');
  assert.equal(tpl.name, 'book_request');
  assert.deepEqual(tpl.params, ['Bilal (Sunrise Apartments, Saket)', 'Dune', 'Sunday?']);
  assert.equal(tpl.url, String(r.id));
  await assert.rejects(w.library.want(w.member(BILAL), dune.id), LibraryError); // already asked

  // When she next writes, the full notification arrives (free) with an "Open request" button.
  w.transport.clear();
  await w.say(AYESHA, 'hi');
  const [queued] = w.transport.to(AYESHA);
  assert.match(queued.text, /Bilal \(Sunrise Apartments, Saket\)\* would like to borrow \*Dune\*[\s\S]*Open the app/);
  assert.deepEqual(queued.link, { url: `${SITE}/?request=${r.id}`, label: 'Open request' });

  // Accepting (in the app) tells Bilal, who messaged recently, for free.
  w.transport.clear();
  await w.library.decide(w.member(AYESHA), r.id, true);
  const [accepted] = w.transport.to(BILAL);
  assert.equal(accepted.kind, 'text');
  assert.match(accepted.text, /Ayesha\* agreed to lend you \*Dune\*/);
  assert.equal(accepted.link.label, 'Open chat');

  // Chat messages are notified with a Reply button; numbers stay private until shared.
  w.transport.clear();
  await w.library.sendMessage(w.member(AYESHA), r.id, "I'm at Block C, come by at 6");
  const [chat] = w.transport.to(BILAL);
  assert.match(chat.text, /Ayesha\* about _Dune_:\nI'm at Block C/);
  assert.equal(chat.link.url, `${SITE}/?request=${r.id}`);
  assert.doesNotMatch(chat.text, /9198000/);

  await w.library.shareNumber(w.member(BILAL), r.id);
  assert.match(w.transport.to(AYESHA).at(-1).text, /\+919800000002/);

  await w.library.markReturned(w.member(AYESHA), r.id);
  assert.equal(w.store.bookById(dune.id).status, 'available');
});

test('one paid nudge per absence; the rest wait until the member is back', async () => {
  const w = await twoMembers();
  await w.join(CHAND, 'Chand');
  const { added } = await w.library.addBooks(w.member(AYESHA), [{ title: 'Dune' }, { title: 'Sapiens' }]);
  w.closeWindow(AYESHA);
  w.transport.clear();

  await w.library.want(w.member(BILAL), added[0].id);
  await w.library.want(w.member(CHAND), added[1].id);
  assert.equal(w.transport.to(AYESHA).length, 1);
  assert.equal(w.store.usageFor().templates, 1);

  w.transport.clear();
  await w.say(AYESHA, 'hi');
  const delivered = w.transport.to(AYESHA);
  assert.equal(delivered.length, 2);
  assert.ok(delivered.every((d) => d.kind === 'text' && d.link));
});

test('monthly template budget stops paid messages', async () => {
  const { w, dune } = await withDune({ settings: { monthlyTemplateLimit: 0 } });
  w.closeWindow(AYESHA);
  w.transport.clear();
  await w.library.want(w.member(BILAL), dune.id);
  assert.equal(w.transport.to(AYESHA).length, 0);
  assert.equal(w.store.pendingInbox(w.member(AYESHA).id).length, 1);
});

test('wishlist: told when someone adds the book, with a link to it', async () => {
  const w = await twoMembers();
  w.library.addWish(w.member(BILAL), 'gitanjali');
  w.closeWindow(BILAL);
  w.transport.clear();
  await w.library.addBooks(w.member(AYESHA), [{ title: 'Gitanjali', author: 'Rabindranath Tagore' }]);
  const [n] = w.transport.to(BILAL);
  assert.equal(n.name, 'wishlist_match');
  assert.deepEqual(n.params, ['Gitanjali', 'Ayesha (Green Park Tower, Saket)']);
  assert.equal(n.url, 'Gitanjali');
  assert.equal(w.store.wishesOf(w.member(BILAL).id).length, 0);
});

test('due-soon and overdue reminders, once each', async () => {
  const { w, dune } = await withDune();
  const r = await w.library.want(w.member(BILAL), dune.id);
  await w.library.decide(w.member(AYESHA), r.id, true);
  w.transport.clear();

  w.time.now += 20 * 86400_000; // due in 1 day
  assert.equal(await w.library.runReminders(), 1);
  assert.equal(await w.library.runReminders(), 0);
  const [reminder] = w.transport.to(BILAL);
  assert.equal(reminder.name, 'return_reminder');
  assert.equal(reminder.url, String(r.id));

  w.time.now += 5 * 86400_000; // 4 days overdue
  assert.equal(await w.library.runReminders(), 1);
  assert.equal(await w.library.runReminders(), 0);
});

test('blocking stops requests', async () => {
  const w = await twoMembers();
  const { added } = await w.library.addBooks(w.member(AYESHA), [{ title: 'Dune' }, { title: 'Sapiens' }]);
  const r = await w.library.want(w.member(BILAL), added[0].id);
  w.library.block(w.member(AYESHA), r.id);
  assert.equal(w.store.requestById(r.id).status, 'declined');
  await assert.rejects(w.library.want(w.member(BILAL), added[1].id), /can't request/);
});

test('limits open requests per person', async () => {
  const w = await twoMembers({ settings: { maxPendingRequests: 1 } });
  const { added } = await w.library.addBooks(w.member(AYESHA), [{ title: 'Dune' }, { title: 'Sapiens' }]);
  await w.library.want(w.member(BILAL), added[0].id);
  await assert.rejects(w.library.want(w.member(BILAL), added[1].id), /1 requests waiting/);
});

test('marking a lent book available closes its loan', async () => {
  const { w, dune } = await withDune();
  const r = await w.library.want(w.member(BILAL), dune.id);
  await w.library.decide(w.member(AYESHA), r.id, true);
  await w.library.setAvailability(w.member(AYESHA), dune.id, 'available');
  assert.equal(w.store.requestById(r.id).status, 'returned');
});
