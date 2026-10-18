import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, visionEnabled } from './config.js';
import { openDb } from './db.js';
import { normalizeIsbn, looksLikeIsbn } from './isbn.js';
import * as lookup from './lookup.js';
import { normalizePhone } from './phone.js';
import { identifyBooks, parseDataUrl, VisionError } from './vision.js';
import { createBot } from './bot.js';
import { whatsappRouter } from './whatsapp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const publicMember = (m) => ({ id: m.id, name: m.name, phone: m.phone });

export function createApp({ store, deps = {}, settings = config } = {}) {
  const enrichAll = deps.enrichAll || lookup.enrichAll;
  const identify = deps.identifyBooks || identifyBooks;
  const lookupIsbn = deps.lookupIsbn || lookup.lookupIsbn;
  const searchBooks = deps.searchBooks || lookup.searchBooks;
  const canSeePhotos = deps.identifyBooks ? () => true : visionEnabled;

  const app = express();
  app.disable('x-powered-by');
  app.use(
    express.json({
      limit: '12mb',
      verify: (req, _res, buf) => {
        req.rawBody = buf; // needed to check WhatsApp webhook signatures
      },
    }),
  );

  const bot = createBot({ store, enrichAll, identifyBooks: identify, settings });
  app.use(whatsappRouter({ bot, config: settings }));

  // ---------- public ----------

  app.get('/api/config', (_req, res) => {
    res.json({
      communityName: settings.communityName,
      needsCode: Boolean(settings.joinCode),
      photoScan: canSeePhotos(),
      whatsappNumber: settings.whatsapp?.displayNumber || '',
      stats: store.stats(),
    });
  });

  app.post('/api/join', (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    const phone = normalizePhone(req.body?.phone);
    if (!name) throw new HttpError(400, 'Please enter your name.');
    if (!phone) throw new HttpError(400, 'Please enter a valid WhatsApp number.');
    if (settings.joinCode && String(req.body?.code || '').trim() !== settings.joinCode) {
      throw new HttpError(403, 'That community code is not right.');
    }
    const member = store.upsertMember({ name, phone });
    res.json({ token: member.token, member: publicMember(member) });
  });

  // ---------- members only ----------

  const auth = (req, _res, next) => {
    const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    req.member = store.memberByToken(token);
    if (!req.member) throw new HttpError(401, 'Please join first.');
    next();
  };

  app.get('/api/me', auth, (req, res) => res.json({ member: publicMember(req.member) }));

  app.get('/api/books', auth, (req, res) => {
    res.json({ results: store.search(String(req.query.q || ''), { limit: 200 }) });
  });

  app.get('/api/my-books', auth, (req, res) => res.json({ books: store.booksOf(req.member.id) }));

  // Suggestions while adding: ?isbn=… for a scanned barcode, ?q=… for typed text.
  app.get('/api/lookup', auth, async (req, res) => {
    const q = String(req.query.q || req.query.isbn || '').trim();
    if (!q) return res.json({ results: [] });
    if (looksLikeIsbn(q)) {
      const hit = await lookupIsbn(q);
      return res.json({ results: hit ? [hit] : [], isbn: normalizeIsbn(q) });
    }
    res.json({ results: await searchBooks(q, 8) });
  });

  app.post('/api/books', auth, (req, res) => {
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
    const { added, skipped } = store.addBooks(req.member.id, books);
    res.json({ added, skipped: skipped.length });
  });

  app.post('/api/scan-photo', auth, async (req, res) => {
    const img = parseDataUrl(req.body?.image);
    if (!img) throw new HttpError(400, 'No photo received.');
    let found;
    try {
      found = await identify(img.buffer, img.mediaType);
    } catch (err) {
      if (err instanceof VisionError) throw new HttpError(422, err.message);
      throw err;
    }
    res.json({ results: await enrichAll(found) });
  });

  app.patch('/api/books/:id', auth, (req, res) => {
    const status = req.body?.status;
    if (!['available', 'lent'].includes(status)) throw new HttpError(400, 'Unknown status.');
    const book = store.setStatus(req.member.id, Number(req.params.id), status);
    if (!book) throw new HttpError(404, 'Book not found.');
    res.json({ book });
  });

  app.delete('/api/books/:id', auth, (req, res) => {
    const book = store.removeBook(req.member.id, Number(req.params.id));
    if (!book) throw new HttpError(404, 'Book not found.');
    res.json({ book });
  });

  // ---------- static web app ----------

  app.get('/vendor/html5-qrcode.min.js', (_req, res) =>
    res.sendFile(path.join(root, 'node_modules/html5-qrcode/html5-qrcode.min.js')),
  );
  app.use(express.static(path.join(root, 'public')));

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));
  app.use((err, _req, res, _next) => {
    const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong.' : err.message });
  });

  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = openDb(config.dbPath);
  createApp({ store }).listen(config.port, config.host, () => {
    console.log(`📚 ${config.communityName} running on http://localhost:${config.port}`);
    console.log(`   Photo scanning: ${visionEnabled() ? 'on' : 'off (set ANTHROPIC_API_KEY)'}`);
    console.log(`   WhatsApp Cloud API: ${config.whatsapp.token ? 'on' : 'off'} · Twilio: ${config.twilio.authToken ? 'on' : 'off'}`);
  });
}
