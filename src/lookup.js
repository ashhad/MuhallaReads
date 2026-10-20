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

// ---------- details for the book card (introduction, year, pages, genre) ----------

const ENTITIES = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };

/** Plain text from Google's HTML-ish descriptions, trimmed to a readable length. */
function plainText(s, max = 1400) {
  const text = String(s || '')
    .replace(/<br\s*\/?>|<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|quot|#39|lt|gt|nbsp);/g, (m) => ENTITIES[m])
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf('. ') + 1, cut.lastIndexOf(' '))).trim() + '…';
}

const SUBTITLE = /\s*[:(–—]\s*|\s+-\s+/;
/** "When I Sing, Mountains Dance: A Novel" → "when i sing mountains dance". */
const mainTitle = (t) => normText(String(t || '').split(SUBTITLE)[0]);

/** "Fiction / Science Fiction / General" → "Science Fiction". */
const genre = (c) => String(c).split(' / ').filter((p) => p !== 'General').pop();

/**
 * Details for the book card: { description, published, pages, publisher, genres, source } or null.
 * Google Books first (it has introductions for most books), then Open Library. Only accepts a result
 * for the same title (or the same ISBN), so a card never shows another book's introduction.
 */
export async function bookDetails({ isbn: rawIsbn, title, author }) {
  const isbn = normalizeIsbn(rawIsbn);
  const want = normText(title);
  const wantMain = mainTitle(title);
  // The same book: the same title, or the same main title with a subtitle on either side ("Dune" and
  // "Dune: Deluxe Edition"; "When I Sing, Mountains Dance: A Novel" and "When I Sing, Mountains Dance"),
  // but never "Dune Messiah".
  const sameTitle = (t, subtitle) =>
    !want ||
    [t, subtitle && `${t}: ${subtitle}`].some((c) => c && (normText(c) === want || mainTitle(c) === wantMain));
  // A source that didn't answer (timeout, daily quota) isn't the same as "no introduction": remember it,
  // so a miss caused by it isn't cached.
  let failed = false;
  const get = async (url) => {
    const data = await getJson(url);
    if (data === null) failed = true;
    return data;
  };
  let info = null;

  const main = String(title || '').split(SUBTITLE)[0].replace(/"/g, '').trim();
  const by = String(author || '').split(',')[0].replace(/"/g, '').trim();
  const queries = [];
  if (isbn) queries.push(`isbn:${isbn}`);
  if (main) queries.push(`intitle:"${main}"${by ? ` inauthor:"${by}"` : ''}`);
  // The author may be listed in another script ("Shivani" for "शिवानी"), so also try the title alone.
  if (main && by) queries.push(`intitle:"${main}"`);
  for (const q of queries) {
    const items = ((await get(googleUrl(q)))?.items || []).map((i) => i.volumeInfo).filter(Boolean);
    const matches = items.filter((v) => v.title && (q.startsWith('isbn:') || sameTitle(v.title, v.subtitle)));
    const v = matches.find((m) => m.description) || matches[0];
    if (!v) continue;
    info = {
      description: plainText(v.description),
      published: String(v.publishedDate || '').slice(0, 4),
      pages: v.pageCount || null,
      publisher: v.publisher || '',
      genres: [...new Set((v.categories || []).map(genre))].slice(0, 2),
      source: 'Google Books',
    };
    if (info.description) return info;
  }

  if (!title) return info;
  const olSearch = async (byAuthor) =>
    ((
      await get(
        `https://openlibrary.org/search.json?title=${encodeURIComponent(main)}` +
          `${byAuthor ? `&author=${encodeURIComponent(by)}` : ''}&limit=5` +
          '&fields=key,title,first_publish_year,number_of_pages_median,subject,publisher',
      )
    )?.docs || []).find((d) => sameTitle(d.title));
  const doc = (by && (await olSearch(true))) || (await olSearch(false));
  if (!doc) {
    if (!info && failed) throw new Error('Book sources did not answer');
    return info;
  }
  const work = doc.key ? await get(`https://openlibrary.org${doc.key}.json`) : null;
  const description = plainText(typeof work?.description === 'string' ? work.description : work?.description?.value);
  return {
    description: description || info?.description || '',
    published: info?.published || (doc.first_publish_year ? String(doc.first_publish_year) : ''),
    pages: info?.pages || doc.number_of_pages_median || null,
    publisher: info?.publisher || doc.publisher?.[0] || '',
    genres: info?.genres?.length ? info.genres : (doc.subject || []).filter((s) => s.length <= 24).slice(0, 2),
    source: description ? 'Open Library' : info?.source || 'Open Library',
  };
}
