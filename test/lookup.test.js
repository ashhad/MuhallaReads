import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { lookupIsbn, searchBooks, enrich, bookDetails } from '../src/lookup.js';

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
  assert.deepEqual(await enrich({ title: 'Dune', author: '' }), { title: 'Dune', author: '', matched: false });
  mockFetch({ 'search.json': { docs: [{ title: 'Dune', author_name: ['Frank Herbert'], cover_i: 2 }] } });
  const r = await enrich({ title: 'dune', author: '' });
  assert.equal(r.author, 'Frank Herbert');
  assert.equal(r.title, 'dune');
});

test('book card details come from Google Books, as plain text, for the same title only', async () => {
  mockFetch({
    'googleapis.com': {
      items: [
        { volumeInfo: { title: 'Dune Messiah', description: 'The sequel.' } },
        {
          volumeInfo: {
            title: 'Dune', publishedDate: '1965-08-01', pageCount: 412, publisher: 'Chilton',
            categories: ['Fiction / Science Fiction / General'],
            description: '<p>Set on the desert planet <b>Arrakis</b>, Dune is&nbsp;the story of Paul Atreides.</p><p>A classic.</p>',
          },
        },
      ],
    },
  });
  assert.deepEqual(await bookDetails({ title: 'Dune', author: 'Frank Herbert' }), {
    description: 'Set on the desert planet Arrakis, Dune is the story of Paul Atreides.\nA classic.',
    published: '1965', pages: 412, publisher: 'Chilton', genres: ['Science Fiction'], source: 'Google Books',
  });
});

test('book card falls back to Open Library for the introduction', async () => {
  mockFetch({
    'googleapis.com': { items: [{ volumeInfo: { title: 'Gitanjali', pageCount: 120 } }] }, // no description
    'search.json': { docs: [{ key: '/works/OL1W', title: 'Gitanjali', first_publish_year: 1910, subject: ['Poetry'] }] },
    'openlibrary.org/works/OL1W.json': { description: { value: 'Song offerings.' } },
  });
  const d = await bookDetails({ title: 'Gitanjali', author: 'Rabindranath Tagore' });
  assert.equal(d.description, 'Song offerings.');
  assert.equal(d.pages, 120);
  assert.equal(d.source, 'Open Library');
});

test('book card never shows a different book with a similar title', async () => {
  mockFetch({
    'googleapis.com': { items: [{ volumeInfo: { title: 'Dune Messiah', description: 'The sequel.' } }] },
    'search.json': { docs: [{ title: 'Dune Messiah' }] },
  });
  assert.equal(await bookDetails({ title: 'Dune' }), null);
  mockFetch({ 'googleapis.com': { items: [{ volumeInfo: { title: 'Dune: Deluxe Edition', description: 'Arrakis.' } }] } });
  assert.equal((await bookDetails({ title: 'Dune' })).description, 'Arrakis.');
});

test('book card also tries the title alone, for authors written in another script', async () => {
  globalThis.fetch = async (url) => {
    const u = decodeURIComponent(String(url));
    if (u.includes('googleapis.com') && u.includes('inauthor:')) return new Response(JSON.stringify({ totalItems: 0 }));
    if (u.includes('googleapis.com')) {
      return new Response(JSON.stringify({ items: [{ volumeInfo: { title: 'वातायन', authors: ['Shivani'], description: 'कहानियों का संग्रह।' } }] }));
    }
    return new Response('{}', { status: 404 });
  };
  assert.equal((await bookDetails({ title: 'वातायन', author: 'शिवानी' })).description, 'कहानियों का संग्रह।');
});

test('book card matches a saved title that includes the subtitle Google lists separately', async () => {
  mockFetch({
    'googleapis.com': { items: [{ volumeInfo: { title: 'When I Sing, Mountains Dance', subtitle: 'A Novel', description: 'Set in the Pyrenees.' } }] },
  });
  const d = await bookDetails({ title: 'When I Sing, Mountains Dance: A Novel', author: 'Irene Solà' });
  assert.equal(d.description, 'Set in the Pyrenees.');
});

test('book card lookups that fail are reported, so they are not cached as "not found"', async () => {
  globalThis.fetch = async () => new Response('quota', { status: 429 });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(bookDetails({ title: 'Dune', author: 'Frank Herbert' }), /did not answer/);
  } finally {
    console.warn = warn;
  }
});

test('a title shared by different books gets no guessed author', async () => {
  mockFetch({
    'search.json': {
      docs: [
        { title: 'The Choice', author_name: ['Nicholas Sparks'], cover_i: 3 },
        { title: 'The Choice', author_name: ['Edith Eva Eger'], cover_i: 4 },
      ],
    },
  });
  const r = await enrich({ title: 'The Choice', author: '' });
  assert.equal(r.author, '');
  assert.equal(r.matched, true);
  assert.equal(r.cover, undefined);
  // With the printed author, the right book is used.
  const eger = await enrich({ title: 'The Choice', author: 'Edith Eger' });
  assert.equal(eger.cover, 'https://covers.openlibrary.org/b/id/4-M.jpg');
});

test('a title no book database knows is marked unmatched', async () => {
  mockFetch({ 'search.json': { docs: [{ title: 'Temple of the Gods', author_name: ['Someone'] }] } });
  assert.equal((await enrich({ title: 'Why Things Aren’t', author: '' })).matched, false);
});
