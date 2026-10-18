import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createBot, parseBookLine } from '../src/bot.js';

function setup({ joinCode = '', photoBooks = [] } = {}) {
  const store = openDb(':memory:');
  const bot = createBot({
    store,
    enrichAll: async (books) =>
      books.map((b) => (b.isbn === '9780062315007' ? { ...b, title: 'The Alchemist', author: 'Paulo Coelho' } : b)),
    identifyBooks: async () => photoBooks,
    settings: { communityName: 'Test Muhalla', joinCode },
  });
  const say = async (phone, text, extra = {}) => {
    const replies = [];
    await bot.handle({ phone, profileName: extra.name, text, ...extra }, async (r) => replies.push(r));
    return replies.join('\n---\n');
  };
  return { store, say };
}

test('parses "title by author" lines', () => {
  assert.deepEqual(parseBookLine('1. Dune by Frank Herbert'), { title: 'Dune', author: 'Frank Herbert', isbn: null });
  assert.deepEqual(parseBookLine('1984 - George Orwell'), { title: '1984', author: 'George Orwell', isbn: null });
  assert.deepEqual(parseBookLine('isbn 0062315005'), { title: '', author: '', isbn: '9780062315007' });
});

test('first message registers the sender using their WhatsApp name', async () => {
  const { store, say } = setup();
  const r = await say('919800000001', 'hi', { name: 'Ayesha' });
  assert.match(r, /You're in, Ayesha/);
  assert.equal(store.memberByPhone('919800000001').name, 'Ayesha');
});

test('join code is required when configured', async () => {
  const { store, say } = setup({ joinCode: 'books42' });
  assert.match(await say('919800000001', 'hello'), /join <community code>/);
  assert.equal(store.memberByPhone('919800000001'), undefined);
  assert.match(await say('919800000001', 'join books42', { name: 'Ayesha' }), /You're in/);
  assert.ok(store.memberByPhone('919800000001'));
});

test('add, search, lend, undo and remove', async () => {
  const { say } = setup();
  await say('911', 'hi', { name: 'Ayesha' });
  await say('912', 'hi', { name: 'Bilal' });

  const added = await say('911', 'add\nDune by Frank Herbert\n9780062315007');
  assert.match(added, /Added 2 books/);
  assert.match(added, /The Alchemist/);

  assert.match(await say('911', 'add dune by frank herbert'), /Already in your list/);

  const found = await say('912', 'who has dune?');
  assert.match(found, /\*Dune\* — Frank Herbert/);
  assert.match(found, /Ayesha ✅/);
  assert.match(found, /wa\.me\/911\?text=/);

  assert.match(await say('912', 'harry potter'), /Nobody has "harry potter"/);

  const mine = await say('911', 'my books');
  const duneId = /#(\d+) \*Dune\*/.exec(mine)[1];
  assert.match(await say('911', `lent ${duneId}`), /lent out/);
  assert.match(await say('912', 'dune'), /Ayesha \(lent out\)/);
  assert.match(await say('912', `remove ${duneId}`), /No book/); // not Bilal's book

  await say('911', 'add Sapiens');
  assert.match(await say('911', 'undo'), /Removed Sapiens/);
  assert.match(await say('911', `remove ${duneId}`), /Removed \*Dune\*/);
  assert.doesNotMatch(await say('911', 'my books'), /Dune|Sapiens/);
});

test('photo adds every recognised book', async () => {
  const { say } = setup({
    photoBooks: [
      { title: 'Atomic Habits', author: 'James Clear', isbn: null },
      { title: 'Ikigai', author: '', isbn: null },
    ],
  });
  await say('911', 'hi', { name: 'Ayesha' });
  const r = await say('911', '', { image: async () => ({ buffer: Buffer.from('x'), mediaType: 'image/jpeg' }) });
  assert.match(r, /looking for books/);
  assert.match(r, /Added 2 books/);
  assert.match(await say('911', 'ikigai'), /Ikigai/);
});
