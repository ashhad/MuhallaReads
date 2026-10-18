import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBookLine, cleanName } from '../src/bot.js';
import { makeWorld, AYESHA, BILAL, CHAND } from './helpers.js';

const idFrom = (text, re) => Number(re.exec(text)[1]);

async function twoMembers(opts) {
  const w = makeWorld(opts);
  await w.say(AYESHA, 'hi', { profileName: 'Ayesha' });
  await w.say(BILAL, 'hi', { profileName: 'Bilal' });
  return w;
}

test('parses "title by author" lines and cleans display names', () => {
  assert.deepEqual(parseBookLine('1. Dune by Frank Herbert'), { title: 'Dune', author: 'Frank Herbert', isbn: null });
  assert.deepEqual(parseBookLine('1984 - George Orwell'), { title: '1984', author: 'George Orwell', isbn: null });
  assert.deepEqual(parseBookLine('isbn 0062315005'), { title: '', author: '', isbn: '9780062315007' });
  assert.equal(cleanName('  *Ayesha*\n (Block C) '), 'Ayesha (Block C)');
  assert.equal(cleanName('x'), '');
});

test('join code is required when configured', async () => {
  const w = makeWorld({ settings: { joinCode: 'books42' } });
  assert.match(await w.say(AYESHA, 'hello'), /join <community code>/);
  assert.equal(w.store.memberByPhone(AYESHA), undefined);
  assert.match(await w.say(AYESHA, 'join BOOKS42', { profileName: 'Ayesha' }), /Welcome, Ayesha/);
  assert.ok(w.store.memberByPhone(AYESHA));
});

test('search shows display names only, never phone numbers', async () => {
  const w = await twoMembers();
  await w.say(AYESHA, 'add Dune by Frank Herbert');
  const r = await w.say(BILAL, 'who has dune?');
  assert.match(r, /\*Dune\* — Frank Herbert/);
  assert.match(r, /Ayesha ✅ → \*want \d+\*/);
  assert.match(r, /Ask Ayesha=want:\d+/);
  assert.doesNotMatch(r, /9198000/);
  assert.doesNotMatch(r, /wa\.me/);
});

test('full private loan: request → accept → chat → share number → return', async () => {
  const w = await twoMembers();
  const bookId = idFrom(await w.say(AYESHA, 'add Dune by Frank Herbert'), /#(\d+) \*Dune\*/);
  w.closeWindow(AYESHA);
  w.transport.clear();

  // Bilal asks; Ayesha hasn't messaged in 2 days, so she gets one paid template with buttons.
  const asked = await w.say(BILAL, `want ${bookId} could I pick it up Sunday?`);
  assert.match(asked, /Asked Ayesha for \*Dune\*/);
  const reqId = idFrom(asked, /request #(\d+)/);
  const [tpl] = w.transport.to(AYESHA);
  assert.equal(tpl.kind, 'template');
  assert.equal(tpl.name, 'book_request');
  assert.deepEqual(tpl.params, ['Bilal', 'Dune', 'could I pick it up Sunday?']);
  assert.deepEqual(tpl.buttons, [`accept:${reqId}`, `decline:${reqId}`]);
  assert.match(await w.say(BILAL, `want ${bookId}`), /already asked/);

  // Ayesha taps Accept on the template. The queued copy of the same request isn't re-sent.
  w.transport.clear();
  const accepted = await w.say(AYESHA, '', { payload: `accept:${reqId}` });
  assert.match(accepted, /You're lending \*Dune\* to Bilal/);
  assert.equal(w.transport.to(AYESHA).length, 0);
  const [toBilal] = w.transport.to(BILAL);
  assert.equal(toBilal.kind, 'text'); // Bilal messaged recently, so it's a free reply
  assert.match(toBilal.text, /Ayesha\* agreed to lend you \*Dune\*/);
  assert.equal(w.store.bookById(bookId).status, 'lent');

  // Chat is relayed without numbers; Bilal swipe-replies to answer.
  w.transport.clear();
  assert.match(await w.say(AYESHA, `msg ${reqId} I'm at Block C, come by at 6`), /Sent/);
  const relayed = w.transport.to(BILAL)[0];
  assert.match(relayed.text, /Ayesha\* · _Dune_[\s\S]*Block C, come by at 6/);
  assert.doesNotMatch(relayed.text, /9198000/);
  assert.match(await w.say(BILAL, 'Great, see you then!', { contextId: relayed.id }), /Sent/);
  assert.match(w.transport.to(AYESHA).at(-1).text, /Bilal\* · _Dune_[\s\S]*see you then/);
  assert.equal(w.store.messagesFor(reqId).length, 2);

  // Only an explicit share reveals a number, and only to the other person.
  w.transport.clear();
  assert.match(await w.say(BILAL, `share ${reqId}`), /shared with Ayesha only/);
  assert.match(w.transport.to(AYESHA)[0].text, /\+919800000002/);

  // Only the owner can close the loan.
  assert.match(await w.say(BILAL, `returned ${reqId}`), /Only Ayesha can mark it returned/);
  assert.match(await w.say(AYESHA, `returned ${reqId}`), /back on your shelf/);
  assert.equal(w.store.bookById(bookId).status, 'available');
  assert.match(await w.say(AYESHA, `msg ${reqId} hi`), /messaging is closed/);
});

test('one paid nudge per absence; the rest wait until the member is back', async () => {
  const w = await twoMembers();
  await w.say(CHAND, 'hi', { profileName: 'Chand' });
  await w.say(AYESHA, 'add\nDune by Frank Herbert\nSapiens by Yuval Noah Harari');
  const [dune, sapiens] = w.store.booksOf(w.store.memberByPhone(AYESHA).id).sort((a, b) => a.id - b.id);
  w.closeWindow(AYESHA);
  w.transport.clear();

  await w.say(BILAL, `want ${dune.id}`);
  await w.say(CHAND, `want ${sapiens.id}`);
  assert.equal(w.transport.to(AYESHA).length, 1);
  assert.equal(w.store.usageFor().templates, 1);

  // When Ayesha writes, both requests are delivered as free replies.
  w.transport.clear();
  await w.say(AYESHA, 'hi');
  const delivered = w.transport.to(AYESHA);
  assert.equal(delivered.length, 2);
  assert.ok(delivered.every((d) => d.kind === 'text'));
  assert.match(delivered.map((d) => d.text).join('\n'), /Bilal[\s\S]*Chand/);
});

test('monthly template budget stops paid messages', async () => {
  const w = await twoMembers({ settings: { monthlyTemplateLimit: 0 } });
  const bookId = idFrom(await w.say(AYESHA, 'add Dune'), /#(\d+)/);
  w.closeWindow(AYESHA);
  w.transport.clear();
  await w.say(BILAL, `want ${bookId}`);
  assert.equal(w.transport.to(AYESHA).length, 0);
  assert.equal(w.store.pendingInbox(w.store.memberByPhone(AYESHA).id).length, 1);
});

test('wishlist: notify me when someone adds a book', async () => {
  const w = await twoMembers();
  assert.match(await w.say(BILAL, 'gitanjali'), /Nobody has "gitanjali" yet[\s\S]*Notify me=wish:gitanjali/);
  assert.match(await w.say(BILAL, 'notify me'), /tell you when someone adds "gitanjali"/);
  w.closeWindow(BILAL);
  w.transport.clear();
  await w.say(AYESHA, 'add Gitanjali by Rabindranath Tagore');
  const [n] = w.transport.to(BILAL);
  assert.equal(n.name, 'wishlist_match');
  assert.deepEqual(n.params, ['Gitanjali', 'Ayesha']);
  assert.equal(w.store.wishesOf(w.store.memberByPhone(BILAL).id).length, 0);
});

test('due-soon and overdue reminders, once each', async () => {
  const w = await twoMembers();
  const bookId = idFrom(await w.say(AYESHA, 'add Dune'), /#(\d+)/);
  const reqId = idFrom(await w.say(BILAL, `want ${bookId}`), /request #(\d+)/);
  await w.say(AYESHA, `accept ${reqId}`);
  w.transport.clear();

  w.time.now += 20 * 86400_000; // due in 1 day
  assert.equal(await w.library.runReminders(), 1);
  assert.equal(await w.library.runReminders(), 0);
  assert.equal(w.transport.to(BILAL)[0].name, 'return_reminder');

  w.time.now += 5 * 86400_000; // 4 days overdue
  assert.equal(await w.library.runReminders(), 1);
  assert.equal(await w.library.runReminders(), 0);
});

test('blocking stops requests and messages', async () => {
  const w = await twoMembers();
  await w.say(AYESHA, 'add\nDune\nSapiens');
  const [dune, sapiens] = w.store.booksOf(w.store.memberByPhone(AYESHA).id).sort((a, b) => a.id - b.id);
  const reqId = idFrom(await w.say(BILAL, `want ${dune.id}`), /request #(\d+)/);
  assert.match(await w.say(AYESHA, `block ${reqId}`), /Blocked Bilal/);
  assert.equal(w.store.requestById(reqId).status, 'declined');
  assert.match(await w.say(BILAL, `want ${sapiens.id}`), /can't request/);
});

test('limits open requests per person', async () => {
  const w = await twoMembers({ settings: { maxPendingRequests: 1 } });
  await w.say(AYESHA, 'add\nDune\nSapiens');
  const [dune, sapiens] = w.store.booksOf(w.store.memberByPhone(AYESHA).id).sort((a, b) => a.id - b.id);
  await w.say(BILAL, `want ${dune.id}`);
  assert.match(await w.say(BILAL, `want ${sapiens.id}`), /1 requests waiting/);
});

test('login link, rename, admin stats and delete account', async () => {
  const w = await twoMembers();
  const link = await w.say(BILAL, 'login');
  const code = /#login=([\w-]+)/.exec(link)[1];
  assert.match(link, /^🌐[\s\S]*https:\/\/books\.example\.org\/#login=/);
  assert.equal(w.store.consumeLoginCode(code), w.store.memberByPhone(BILAL).id);
  assert.equal(w.store.consumeLoginCode(code), null); // single use

  assert.match(await w.say(BILAL, 'name Bilal (Block D)'), /Bilal \(Block D\)/);
  assert.match(await w.say(AYESHA, 'stats'), /2 members/);
  assert.match(await w.say(BILAL, 'stats'), /Nobody has "stats"/); // not an admin

  await w.say(BILAL, 'add Ikigai');
  assert.match(await w.say(BILAL, 'delete everything'), /Send \*delete me\* first/);
  await w.say(BILAL, 'delete me');
  assert.match(await w.say(BILAL, 'delete everything'), /deleted/);
  assert.equal(w.store.memberByPhone(BILAL), undefined);
  assert.equal(w.store.search('ikigai').length, 0);
});

test('photo adds every recognised book', async () => {
  const w = makeWorld({ photoBooks: [{ title: 'Atomic Habits', author: 'James Clear', isbn: null }, { title: 'Ikigai', author: '', isbn: null }] });
  await w.say(AYESHA, 'hi', { profileName: 'Ayesha' });
  const r = await w.say(AYESHA, '', { image: async () => ({ buffer: Buffer.from('x'), mediaType: 'image/jpeg' }) });
  assert.match(r, /Looking for books/);
  assert.match(r, /Added 2 books/);
  assert.match(await w.say(AYESHA, 'undo'), /Removed Atomic Habits, Ikigai/);
});

test('marking a lent book available closes its loan', async () => {
  const w = await twoMembers();
  const bookId = idFrom(await w.say(AYESHA, 'add Dune'), /#(\d+)/);
  const reqId = idFrom(await w.say(BILAL, `want ${bookId}`), /request #(\d+)/);
  await w.say(AYESHA, `accept ${reqId}`);
  assert.match(await w.say(AYESHA, `back ${bookId}`), /available again/);
  assert.equal(w.store.requestById(reqId).status, 'returned');
});
