import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { lookupIsbn, searchBooks, enrich } from '../src/lookup.js';

const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

const mockFetch = (routes) => {
  globalThis.fetch = async (url) => {
    const hit = Object.entries(routes).find(([k]) => String(url).includes(k));
    return hit ? new Response(JSON.stringify(hit[1])) : new Response('{}', { status: 404 });
  };
};

test('looks up an ISBN on Open Library', async () => {
  mockFetch({
    'openlibrary.org/api/books': {
      'ISBN:9780062315007': { title: 'The Alchemist', authors: [{ name: 'Paulo Coelho' }], cover: { medium: 'https://c/x.jpg' } },
    },
  });
  assert.deepEqual(await lookupIsbn('0062315005'), {
    title: 'The Alchemist', author: 'Paulo Coelho', isbn: '9780062315007', cover: 'https://c/x.jpg',
  });
});

test('falls back to Google Books', async () => {
  mockFetch({
    'googleapis.com': {
      items: [{ volumeInfo: { title: 'Ikigai', authors: ['Héctor García'], imageLinks: { thumbnail: 'http://g/i.jpg' },
        industryIdentifiers: [{ type: 'ISBN_13', identifier: '9781786330895' }] } }],
    },
  });
  const r = await lookupIsbn('9781786330895');
  assert.equal(r.title, 'Ikigai');
  assert.equal(r.cover, 'https://g/i.jpg');
});

test('search maps Open Library docs', async () => {
  mockFetch({ 'search.json': { docs: [{ title: 'Dune', author_name: ['Frank Herbert'], isbn: ['0441172717'], cover_i: 1 }] } });
  const [d] = await searchBooks('dune');
  assert.equal(d.isbn, '9780441172719');
  assert.equal(d.cover, 'https://covers.openlibrary.org/b/id/1-M.jpg');
});

test('enrich only accepts a matching title', async () => {
  mockFetch({ 'search.json': { docs: [{ title: 'Dune Messiah', author_name: ['Frank Herbert'], cover_i: 2 }] } });
  assert.deepEqual(await enrich({ title: 'Dune', author: '' }), { title: 'Dune', author: '' });
  mockFetch({ 'search.json': { docs: [{ title: 'Dune', author_name: ['Frank Herbert'], cover_i: 2 }] } });
  const r = await enrich({ title: 'dune', author: '' });
  assert.equal(r.author, 'Frank Herbert');
  assert.equal(r.title, 'dune');
});
