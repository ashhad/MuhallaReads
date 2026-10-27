// The library's contact card: WhatsApp shows the bot as a bare number until Meta approves its display
// name, so members are offered the card to save, on WhatsApp and on the website.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { vCard } from '../src/whatsapp.js';
import { makeWorld, baseSettings, fakeTransport, AYESHA, BILAL } from './helpers.js';

const NUMBER = '919900000000';
const withNumber = { settings: { whatsapp: { displayNumber: NUMBER } } };
const CARD = `[card: Test Muhalla +${NUMBER}]`;

test('a newcomer gets the contact card once setup is done', async () => {
  const w = makeWorld(withNumber);
  await w.say(AYESHA, 'hi', { profileName: 'Ayesha' });
  assert.ok(!(await w.say(AYESHA, 'I agree')).includes(CARD)); // not in the middle of the questions
  await w.say(AYESHA, 'Green Park Tower');
  const done = await w.say(AYESHA, 'Saket');
  assert.match(done, /All set[\s\S]*---\n📇 Save \*Test Muhalla\* to your contacts/);
  assert.ok(done.endsWith(CARD));
  assert.ok(w.member(AYESHA).card_sent_at);
  assert.ok(!(await w.say(AYESHA, 'hello')).includes(CARD)); // only once
});

test('"save" sends the card again, and says so when the number is not set up', async () => {
  const w = makeWorld(withNumber);
  await w.join(AYESHA, 'Ayesha');
  assert.ok((await w.say(AYESHA, 'save')).endsWith(CARD));
  assert.match(await w.say(AYESHA, 'help'), /`save`/);

  const plain = makeWorld();
  await plain.join(BILAL, 'Bilal');
  assert.match(await plain.say(BILAL, 'save contact'), /number isn't set up yet/);
  assert.ok(!plain.transport.sent.some((s) => s.contact));
});

test('members who joined before the card existed get it once, on their next message', async () => {
  const w = makeWorld(withNumber);
  await w.join(AYESHA, 'Ayesha');
  await w.join(BILAL, 'Bilal');
  for (const phone of [AYESHA, BILAL]) w.store.db.prepare('UPDATE members SET card_sent_at = NULL WHERE phone = ?').run(phone);

  const first = await w.say(AYESHA, 'alerts off');
  assert.match(first, /no more new-book messages[\s\S]*---\n📇/);
  assert.ok(first.endsWith(CARD));
  assert.ok(!(await w.say(AYESHA, 'alerts on')).includes(CARD));

  // Not tacked onto the "are you sure?" of deleting an account.
  assert.ok(!(await w.say(BILAL, 'delete me')).includes(CARD));
  assert.match(await w.say(BILAL, 'delete everything'), /deleted/);
  assert.equal(w.member(BILAL), undefined);
});

test('the website offers the card as a vCard, and only when the number is set up', async () => {
  assert.equal(
    vCard({ name: 'Books; and, more', phone: NUMBER, url: 'https://books.example.org' }),
    'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Books\\; and\\, more\r\nN:;Books\\; and\\, more;;;\r\nORG:Books\\; and\\, more\r\n' +
      `TEL;TYPE=CELL;waid=${NUMBER}:+${NUMBER}\r\nURL:https://books.example.org\r\nEND:VCARD\r\n`,
  );

  const serve = async (whatsapp) => {
    const app = createApp({ store: openDb(':memory:'), settings: { ...baseSettings, whatsapp }, deps: { transport: fakeTransport() } });
    const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    try {
      return await fetch(`http://127.0.0.1:${server.address().port}/library.vcf`);
    } finally {
      server.close();
    }
  };
  const res = await serve({ displayNumber: NUMBER });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/vcard/);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="TestMuhalla.vcf"');
  const body = await res.text();
  assert.match(body, /^BEGIN:VCARD\r\n[\s\S]*FN:Test Muhalla\r\n[\s\S]*END:VCARD\r\n$/);
  assert.ok(body.includes(`waid=${NUMBER}:+${NUMBER}`));
  assert.equal((await serve({})).status, 404);
});
