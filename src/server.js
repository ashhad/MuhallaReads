import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, visionEnabled, whatsappEnabled } from './config.js';
import { openDb, placeOf, normText } from './db.js';
import { normalizeIsbn, looksLikeIsbn } from './isbn.js';
import * as lookup from './lookup.js';
import { identifyBooks, parseDataUrl, VisionError } from './vision.js';
import { createBot, cleanName, cleanPlace } from './bot.js';
import { createLibrary, LibraryError } from './library.js';
import { createNotifier } from './notifier.js';
import { createPhotoLimits, PhotoLimitError } from './photos.js';
import { createMetaTransport, whatsappRouter } from './whatsapp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApp({ store, deps = {}, settings = config } = {}) {
  const enrichAll = deps.enrichAll || lookup.enrichAll;
  const identify = deps.identifyBooks || identifyBooks;
  const lookupIsbn = deps.lookupIsbn || lookup.lookupIsbn;
  const searchBooks = deps.searchBooks || lookup.searchBooks;
  const bookDetails = deps.bookDetails || lookup.bookDetails;
  const canSeePhotos = deps.identifyBooks ? () => true : visionEnabled;
  const transport =
    deps.transport !== undefined ? deps.transport : whatsappEnabled(settings) ? createMetaTransport(settings.whatsapp) : null;

  const notifier = createNotifier({ store, transport, settings });
  const library = createLibrary({ store, notifier, settings });
  const photos = createPhotoLimits({ store, notifier, settings });
  const bot = createBot({ store, library, notifier, settings });

  const app = express();
  app.locals.library = library;
  app.locals.photos = photos;
  app.disable('x-powered-by');
  app.use(
    express.json({
      limit: '12mb',
      verify: (req, _res, buf) => {
        req.rawBody = buf; // needed to check WhatsApp webhook signatures
      },
    }),
  );
  app.use(whatsappRouter({ bot, transport, config: settings }));

  // ---------- public ----------

  app.get('/api/config', (_req, res) => {
    res.json({
      communityName: settings.communityName,
      photoScan: canSeePhotos(),
      whatsappNumber: settings.whatsapp?.displayNumber || '',
      stats: store.stats(),
    });
  });

  // Sign-in links come from the WhatsApp bot ("login"), so the web app never asks for a phone number.
  app.post('/api/login', (req, res) => {
    const memberId = store.consumeLoginCode(req.body?.code);
    if (!memberId) throw new HttpError(401, 'That sign-in link has expired. Send "login" to the bot for a new one.');
    res.json({ token: store.createSession(memberId) });
  });

  // ---------- members only ----------

  const auth = (req, _res, next) => {
    req.token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    req.member = store.memberBySession(req.token);
    if (!req.member) throw new HttpError(401, 'Please sign in.');
    next();
  };
  const api = express.Router();
  api.use(auth);
  app.use('/api', api);

  const isAdmin = (m) => Boolean(settings.adminPhones?.includes(m.phone));
  const publicMe = (m) => ({
    id: m.id,
    name: m.name,
    building: m.building,
    locality: m.locality,
    place: placeOf(m),
    // Admins see this month's running costs on their Me tab.
    ...(isAdmin(m) && {
      usage: { photos: photos.usage(), templates: store.usageFor().templates, templateLimit: settings.monthlyTemplateLimit },
    }),
  });

  api.get('/me', (req, res) => res.json({ member: publicMe(req.member) }));

  // Any of: name, building, locality. Building or locality must remain set.
  api.patch('/me', (req, res) => {
    const b = req.body || {};
    if ('name' in b) {
      const name = cleanName(b.name);
      if (!name) throw new HttpError(400, 'Please use a name of 2–40 characters.');
      store.renameMember(req.member.id, name);
    }
    if ('building' in b || 'locality' in b) {
      const place = {
        building: 'building' in b ? cleanPlace(b.building) : req.member.building,
        locality: 'locality' in b ? cleanPlace(b.locality) : req.member.locality,
      };
      if (!place.building && !place.locality) {
        throw new HttpError(400, 'Please give your building or your locality (2–60 characters).');
      }
      store.setPlace(req.member.id, place);
    }
    res.json({ member: publicMe(store.memberById(req.member.id)) });
  });

  // Adding and requesting books need a building or locality, so neighbours know roughly where you are.
  const requirePlace = (req, _res, next) => {
    if (!placeOf(req.member)) throw new HttpError(400, 'Please add your building or locality first (Me tab).');
    next();
  };

  api.delete('/me', (req, res) => {
    library.deleteAccount(req.member);
    res.json({ ok: true });
  });

  api.post('/logout', (req, res) => {
    store.deleteSession(req.token);
    res.json({ ok: true });
  });

  api.get('/books', (req, res) => {
    res.json({ results: store.search(String(req.query.q || ''), { limit: 200 }) });
  });

  api.get('/my-books', (req, res) => res.json({ books: store.booksOf(req.member.id) }));

  // Suggestions while adding: ?isbn=… for a scanned barcode, ?q=… for typed text.
  api.get('/lookup', async (req, res) => {
    const q = String(req.query.q || req.query.isbn || '').trim();
    if (!q) return res.json({ results: [] });
    if (looksLikeIsbn(q)) {
      const hit = await lookupIsbn(q);
      return res.json({ results: hit ? [hit] : [], isbn: normalizeIsbn(q) });
    }
    res.json({ results: await searchBooks(q, 8) });
  });

  // Introduction, year, pages and genre for the book card. Looked up by the server (so Google never
  // sees members' devices) and cached: found books for 30 days, misses for 3.
  const DAY = 86400_000;
  api.get('/book-info', async (req, res) => {
    const isbn = normalizeIsbn(req.query.isbn);
    const title = String(req.query.title || '').trim().slice(0, 300);
    const author = String(req.query.author || '').trim().slice(0, 200);
    if (!isbn && !title) throw new HttpError(400, 'Which book?');
    // "v2": results saved before the subtitle and Hindi fixes are ignored and looked up again.
    const key = `v2:${isbn || `${normText(title)}|${normText(author)}`}`;
    let info = store.cachedBookInfo(key, (data) => (data ? 30 : 3) * DAY);
    if (info === undefined) {
      try {
        info = await bookDetails({ isbn, title, author });
        store.cacheBookInfo(key, info);
      } catch (err) {
        console.warn(`Book card: ${err.message}; not cached, will try again next time`);
        info = null;
      }
    }
    res.json({ info });
  });

  api.post('/books', requirePlace, async (req, res) => {
    const books = (Array.isArray(req.body?.books) ? req.body.books : [])
      .slice(0, 200)
      .map((b) => ({
        title: String(b?.title || '').trim().slice(0, 300),
        author: String(b?.author || '').trim().slice(0, 200),
        isbn: normalizeIsbn(b?.isbn),
        cover: /^https:\/\//.test(b?.cover || '') ? String(b.cover).slice(0, 500) : null,
      }))
      .filter((b) => b.title);
    if (!books.length) throw new HttpError(400, 'Add at least one book with a title.');
    const { added, skipped } = await library.addBooks(req.member, books);
    res.json({ added, skipped: skipped.length });
  });

  api.post('/scan-photo', async (req, res) => {
    const img = parseDataUrl(req.body?.image);
    if (!img) throw new HttpError(400, 'No photo received.');
    let found;
    try {
      found = await photos.scan(req.member, () => identify(img.buffer, img.mediaType));
    } catch (err) {
      if (err instanceof PhotoLimitError) throw new HttpError(429, err.message);
      if (err instanceof VisionError) throw new HttpError(422, err.message);
      throw err;
    }
    res.json({ results: await enrichAll(found.books) });
  });

  api.patch('/books/:id', async (req, res) => {
    const status = req.body?.status;
    if (!['available', 'lent'].includes(status)) throw new HttpError(400, 'Unknown status.');
    const book = await library.setAvailability(req.member, req.params.id, status);
    if (!book) throw new HttpError(404, 'Book not found.');
    res.json({ book });
  });

  api.delete('/books/:id', (req, res) => {
    const book = store.removeBook(req.member.id, Number(req.params.id));
    if (!book) throw new HttpError(404, 'Book not found.');
    res.json({ book });
  });

  // ---------- borrowing ----------

  /** What the web app may know about a request: names only, plus the other person's number only if they shared it. */
  const viewRequest = (r, me) => {
    const iOwn = r.owner_id === me.id;
    const otherShared = Boolean(iOwn ? r.borrower_shared : r.owner_shared);
    return {
      id: r.id,
      role: iOwn ? 'owner' : 'borrower',
      status: r.status,
      note: r.note,
      book: { id: r.book_id, title: r.book_title, author: r.book_author, cover: r.book_cover },
      other: iOwn
        ? { name: r.borrower_name, place: placeOf({ building: r.borrower_building, locality: r.borrower_locality }) }
        : { name: r.owner_name, place: placeOf({ building: r.owner_building, locality: r.owner_locality }) },
      otherPhone: otherShared ? store.memberById(iOwn ? r.borrower_id : r.owner_id)?.phone || null : null,
      iShared: Boolean(iOwn ? r.owner_shared : r.borrower_shared),
      createdAt: r.created_at,
      dueAt: r.due_at,
    };
  };

  api.get('/requests', (req, res) => {
    // Request notifications seen here count as seen, so WhatsApp won't repeat them later. Others (e.g.
    // admin alerts) aren't shown in the app, so they still wait for WhatsApp.
    const pending = store.pendingInbox(req.member.id).filter((i) => i.request_id).map((i) => i.id);
    store.markInboxDelivered(pending);
    res.json({ requests: store.requestsFor(req.member.id).map((r) => viewRequest(r, req.member)) });
  });

  api.post('/requests', requirePlace, async (req, res) => {
    const r = await library.want(req.member, req.body?.bookId, req.body?.note);
    res.json({ request: viewRequest(r, req.member) });
  });

  const actions = {
    accept: (m, id) => library.decide(m, id, true),
    decline: (m, id) => library.decide(m, id, false),
    cancel: (m, id) => library.cancel(m, id),
    returned: (m, id) => library.markReturned(m, id),
    share: async (m, id) => (await library.shareNumber(m, id), store.requestById(Number(id))),
    block: (m, id) => (library.block(m, id), store.requestById(Number(id))),
  };
  api.post('/requests/:id/:action', async (req, res, next) => {
    const fn = Object.hasOwn(actions, req.params.action) && actions[req.params.action];
    if (!fn) return next(); // e.g. /messages, handled below
    const r = await fn(req.member, req.params.id);
    res.json({ request: viewRequest(r, req.member) });
  });

  api.get('/requests/:id/messages', (req, res) => {
    const r = library.getRequest(req.params.id, req.member);
    res.json({
      request: viewRequest(r, req.member),
      messages: store.messagesFor(r.id).map((m) => ({ id: m.id, mine: m.from_id === req.member.id, body: m.body, at: m.created_at })),
    });
  });

  api.post('/requests/:id/messages', async (req, res) => {
    const m = await library.sendMessage(req.member, req.params.id, req.body?.body);
    res.json({ message: { id: m.id, mine: true, body: m.body, at: m.created_at } });
  });

  // ---------- wishlist ----------

  api.get('/wishes', (req, res) => res.json({ wishes: store.wishesOf(req.member.id) }));
  api.post('/wishes', (req, res) => res.json({ wish: library.addWish(req.member, req.body?.query) }));
  api.delete('/wishes/:id', (req, res) => {
    if (!store.removeWish(req.member.id, Number(req.params.id))) throw new HttpError(404, 'Not found.');
    res.json({ ok: true });
  });

  api.use((_req, _res, next) => next(new HttpError(404, 'Not found.')));

  // ---------- static web app ----------

  app.get('/vendor/html5-qrcode.min.js', (_req, res) =>
    res.sendFile(path.join(root, 'node_modules/html5-qrcode/html5-qrcode.min.js')),
  );
  // Self-hosted fonts (Latin, variable weight), so no font CDN sees members' visits.
  const fonts = {
    'fraunces.woff2': '@fontsource-variable/fraunces/files/fraunces-latin-wght-normal.woff2',
    'instrument-sans.woff2': '@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2',
  };
  app.get('/fonts/:file', (req, res, next) =>
    Object.hasOwn(fonts, req.params.file)
      ? res.sendFile(path.join(root, 'node_modules', fonts[req.params.file]), { maxAge: '30d' })
      : next(),
  );
  app.use(express.static(path.join(root, 'public')));

  app.use((err, _req, res, _next) => {
    if (err instanceof LibraryError) err.status = 400;
    const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500) console.error(err);
    const message = status >= 500 ? 'Something went wrong.' : err.message.replace(/\*/g, '');
    res.status(status).json({ error: message });
  });

  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = openDb(config.dbPath);
  const app = createApp({ store });
  app.listen(config.port, config.host, () => {
    console.log(`📚 ${config.communityName} running on http://localhost:${config.port}`);
    console.log(
      `   Photo scanning: ${visionEnabled() ? `on (${config.claudeModel}, up to ₹${config.photoMonthlyBudgetInr}/month)` : 'off (set ANTHROPIC_API_KEY)'}`,
    );
    console.log(
      `   WhatsApp: ${whatsappEnabled() ? `on (templates ${config.templatesEnabled ? 'on' : 'off'}, budget ${config.monthlyTemplateLimit}/month)` : 'off'}`,
    );
  });
  // Return reminders and the admins' weekly photo-cost summary: check hourly.
  const remind = () => {
    app.locals.library.runReminders().catch((err) => console.error('Reminders failed:', err));
    app.locals.photos.weeklySummary().catch((err) => console.error('Weekly summary failed:', err));
  };
  setInterval(remind, 3600_000).unref();
  setTimeout(remind, 60_000).unref();
}
