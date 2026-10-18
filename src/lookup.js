// Book metadata lookup: Open Library first (free, no key), Google Books as a fallback.
import { config } from './config.js';
import { normalizeIsbn } from './isbn.js';
import { normText } from './db.js';

const TIMEOUT_MS = 8000;

async function getJson(url) {
  const host = new URL(url).host;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': 'MuhallaReads/1.0 (community library catalogue)' },
    });
    if (!res.ok) {
      console.warn(`Book lookup: ${host} answered ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`Book lookup: ${host} failed (${err.name}: ${err.message})`);
    return null;
  }
}

const olCover = (coverId) => (coverId ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : null);
const httpsUrl = (u) => (u ? u.replace(/^http:/, 'https:') : null);

function fromGoogle(item) {
  const v = item?.volumeInfo;
  if (!v?.title) return null;
  const ids = v.industryIdentifiers || [];
  const isbn = normalizeIsbn(
    ids.find((i) => i.type === 'ISBN_13')?.identifier || ids.find((i) => i.type === 'ISBN_10')?.identifier,
  );
  return {
    title: v.subtitle ? `${v.title}: ${v.subtitle}` : v.title,
    author: (v.authors || []).join(', '),
    isbn,
    cover: httpsUrl(v.imageLinks?.thumbnail),
  };
}

function googleUrl(q) {
  const key = config.googleBooksApiKey ? `&key=${encodeURIComponent(config.googleBooksApiKey)}` : '';
  return `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5${key}`;
}

/** Looks up a single book by ISBN. Returns { title, author, isbn, cover } or null. */
export async function lookupIsbn(rawIsbn) {
  const isbn = normalizeIsbn(rawIsbn);
  if (!isbn) return null;

  const ol = await getJson(
    `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`,
  );
  const d = ol?.[`ISBN:${isbn}`];
  if (d?.title) {
    return {
      title: d.subtitle ? `${d.title}: ${d.subtitle}` : d.title,
      author: (d.authors || []).map((a) => a.name).join(', '),
      isbn,
      cover: d.cover?.medium || `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false`,
    };
  }

  const g = await getJson(googleUrl(`isbn:${isbn}`));
  const fromG = fromGoogle(g?.items?.[0]);
  return fromG ? { ...fromG, isbn } : null;
}

/** Free-text search for book suggestions. Returns up to `limit` candidates. */
export async function searchBooks(query, limit = 6) {
  const q = String(query || '').trim();
  if (!q) return [];

  const ol = await getJson(
    `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=${limit}` +
      '&fields=title,author_name,isbn,cover_i,edition_count',
  );
  const docs = ol?.docs || [];
  if (docs.length) {
    return docs.slice(0, limit).map((d) => ({
      title: d.title,
      author: (d.author_name || []).slice(0, 2).join(', '),
      isbn: (d.isbn || []).map(normalizeIsbn).find(Boolean) || null,
      cover: olCover(d.cover_i),
    }));
  }

  const g = await getJson(googleUrl(q));
  return (g?.items || []).map(fromGoogle).filter(Boolean).slice(0, limit);
}

/**
 * Fills in missing details (author, cover, canonical title) for a book someone typed or a photo
 * showed. Only accepts a match whose title clearly corresponds, so we never swap in a different book.
 */
export async function enrich(book) {
  if (book.isbn) {
    const hit = await lookupIsbn(book.isbn);
    if (hit) {
      return {
        title: book.title || hit.title,
        author: book.author || hit.author,
        isbn: hit.isbn,
        cover: book.cover || hit.cover,
      };
    }
  }
  if (!book.title) return book;

  const q = book.author ? `${book.title} ${book.author}` : book.title;
  const candidates = await searchBooks(q, 5);
  const want = normText(book.title);
  const wantAuthor = normText(book.author);
  const hit = candidates.find((c) => {
    const titleOk = normText(c.title) === want; // exact, so "Dune" never becomes "Dune Messiah"
    const authorOk = !wantAuthor || normText(c.author).split(' ').some((w) => w.length > 2 && wantAuthor.includes(w));
    return titleOk && authorOk;
  });
  if (!hit) return book;
  return {
    title: book.title,
    author: book.author || hit.author,
    isbn: book.isbn || hit.isbn,
    cover: book.cover || hit.cover,
  };
}

/** Enriches many books with limited concurrency so a shelf photo doesn't fire 30 requests at once. */
export async function enrichAll(books, concurrency = 4) {
  const out = new Array(books.length);
  let next = 0;
  const worker = async () => {
    while (next < books.length) {
      const i = next++;
      out[i] = await enrich(books[i]).catch(() => books[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, books.length) }, worker));
  return out;
}
