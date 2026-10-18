import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// Members' phone numbers are stored only so the WhatsApp bot can message them. They are never
// returned by any query used to show data to other members.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL UNIQUE,
  last_inbound_at TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_codes (
  code       TEXT PRIMARY KEY,
  member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id         INTEGER PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  author     TEXT NOT NULL DEFAULT '',
  isbn       TEXT,
  cover_url  TEXT,
  status     TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'lent')),
  batch_id   TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS books_owner ON books(owner_id);

CREATE TABLE IF NOT EXISTS requests (
  id              INTEGER PRIMARY KEY,
  book_id         INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  borrower_id     INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  owner_id        INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'returned')),
  note            TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  decided_at      TEXT,
  due_at          TEXT,
  closed_at       TEXT,
  reminders       INTEGER NOT NULL DEFAULT 0,
  borrower_shared INTEGER NOT NULL DEFAULT 0,
  owner_shared    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS requests_borrower ON requests(borrower_id);
CREATE INDEX IF NOT EXISTS requests_owner ON requests(owner_id);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  from_id    INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wishes (
  id         INTEGER PRIMARY KEY,
  member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  query      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (blocker_id, blocked_id)
);

-- Notifications waiting to be delivered on WhatsApp the next time the member messages the bot.
CREATE TABLE IF NOT EXISTS inbox (
  id           INTEGER PRIMARY KEY,
  member_id    INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  request_id   INTEGER REFERENCES requests(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  buttons      TEXT,
  relay        INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  delivered_at TEXT
);

-- WhatsApp message ids of relayed chat messages, so a swipe-reply can be routed to the right request.
CREATE TABLE IF NOT EXISTS outbound (
  wa_id      TEXT PRIMARY KEY,
  member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  month     TEXT PRIMARY KEY,
  templates INTEGER NOT NULL DEFAULT 0,
  service   INTEGER NOT NULL DEFAULT 0
);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return new Store(db);
}

const now = () => new Date().toISOString();
const randomToken = () => crypto.randomBytes(24).toString('base64url');

/** Lower-cases and strips punctuation so "The Alchemist!" and "the alchemist" compare equal. */
export const normText = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** True if every word of `query` appears in the book's title or author. */
export function matchesQuery(book, query) {
  const words = normText(query).split(' ').filter(Boolean);
  const hay = normText(book.title) + ' ' + normText(book.author);
  return words.length > 0 && words.every((w) => hay.includes(w));
}

const REQUEST_SELECT = `
  SELECT r.*, b.title AS book_title, b.author AS book_author, b.cover_url AS book_cover,
         bo.name AS borrower_name, ow.name AS owner_name
  FROM requests r
  JOIN books b ON b.id = r.book_id
  JOIN members bo ON bo.id = r.borrower_id
  JOIN members ow ON ow.id = r.owner_id`;

export class Store {
  constructor(db) {
    this.db = db;
  }

  q(sql) {
    return this.db.prepare(sql);
  }

  // ---------- members ----------

  memberById(id) {
    return this.q('SELECT * FROM members WHERE id = ?').get(id);
  }

  memberByPhone(phone) {
    return this.q('SELECT * FROM members WHERE phone = ?').get(phone);
  }

  createMember({ name, phone }) {
    return this.q('INSERT INTO members (name, phone, created_at) VALUES (?, ?, ?) RETURNING *').get(name, phone, now());
  }

  renameMember(id, name) {
    return this.q('UPDATE members SET name = ? WHERE id = ? RETURNING *').get(name, id);
  }

  deleteMember(id) {
    this.q('DELETE FROM members WHERE id = ?').run(id);
  }

  touchInbound(id, at = now()) {
    this.q('UPDATE members SET last_inbound_at = ? WHERE id = ?').run(at, id);
  }

  listMembers() {
    return this.q('SELECT id, name, created_at FROM members ORDER BY name COLLATE NOCASE').all();
  }

  // ---------- web sign-in ----------

  createSession(memberId) {
    const token = randomToken();
    this.q('INSERT INTO sessions (token, member_id, created_at) VALUES (?, ?, ?)').run(token, memberId, now());
    return token;
  }

  memberBySession(token) {
    if (!token) return undefined;
    return this.q('SELECT m.* FROM sessions s JOIN members m ON m.id = s.member_id WHERE s.token = ?').get(token);
  }

  deleteSession(token) {
    this.q('DELETE FROM sessions WHERE token = ?').run(token);
  }

  createLoginCode(memberId, ttlMinutes = 15) {
    const code = randomToken();
    const expires = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    this.q('DELETE FROM login_codes WHERE expires_at < ?').run(now());
    this.q('INSERT INTO login_codes (code, member_id, expires_at) VALUES (?, ?, ?)').run(code, memberId, expires);
    return code;
  }

  /** Single use: returns the member id, or null if the code is unknown or expired. */
  consumeLoginCode(code) {
    const row = this.q('DELETE FROM login_codes WHERE code = ? RETURNING *').get(String(code || ''));
    return row && row.expires_at > now() ? row.member_id : null;
  }

  // ---------- books ----------

  /**
   * Adds books for a member, skipping ones they already have (same ISBN or same title+author).
   * Returns { added: [...rows], skipped: [...inputs] }.
   */
  addBooks(ownerId, books, batchId = crypto.randomUUID()) {
    const mine = this.booksOf(ownerId);
    const haveIsbn = new Set(mine.filter((b) => b.isbn).map((b) => b.isbn));
    const haveTitle = new Set(mine.map((b) => normText(b.title) + '|' + normText(b.author)));
    const insert = this.q(
      `INSERT INTO books (owner_id, title, author, isbn, cover_url, batch_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    );
    const added = [];
    const skipped = [];
    for (const b of books) {
      const title = String(b.title || '').trim();
      if (!title) continue;
      const author = String(b.author || '').trim();
      const key = normText(title) + '|' + normText(author);
      if ((b.isbn && haveIsbn.has(b.isbn)) || haveTitle.has(key)) {
        skipped.push(b);
        continue;
      }
      added.push(insert.get(ownerId, title, author, b.isbn || null, b.cover || null, batchId, now()));
      if (b.isbn) haveIsbn.add(b.isbn);
      haveTitle.add(key);
    }
    return { added, skipped, batchId };
  }

  bookById(id) {
    return this.q('SELECT * FROM books WHERE id = ?').get(id);
  }

  booksOf(ownerId) {
    return this.q('SELECT * FROM books WHERE owner_id = ? ORDER BY title COLLATE NOCASE').all(ownerId);
  }

  setBookStatus(bookId, status) {
    this.q('UPDATE books SET status = ? WHERE id = ?').run(status, bookId);
  }

  setStatus(ownerId, bookId, status) {
    return this.q('UPDATE books SET status = ? WHERE id = ? AND owner_id = ? RETURNING *').get(status, bookId, ownerId);
  }

  removeBook(ownerId, bookId) {
    return this.q('DELETE FROM books WHERE id = ? AND owner_id = ? RETURNING *').get(bookId, ownerId);
  }

  /** Removes the member's most recently added batch (the WhatsApp "undo" command). */
  undoLastBatch(ownerId) {
    const last = this.q(
      'SELECT batch_id FROM books WHERE owner_id = ? AND batch_id IS NOT NULL ORDER BY id DESC LIMIT 1',
    ).get(ownerId);
    if (!last) return [];
    return this.q('DELETE FROM books WHERE owner_id = ? AND batch_id = ? RETURNING *').all(ownerId, last.batch_id);
  }

  /**
   * Searches the whole catalogue. Every word of the query must appear in the title, author or ISBN.
   * Copies of the same book are grouped. Owners are identified by display name only.
   */
  search(query, { limit = 100 } = {}) {
    const isbnQuery = String(query || '').replace(/[^0-9Xx]/g, '');
    const rows = this.q(
      `SELECT b.*, m.name AS owner_name FROM books b JOIN members m ON m.id = b.owner_id
       ORDER BY b.created_at DESC, b.id DESC`,
    ).all();

    const matches = rows.filter((r) => {
      if (!normText(query)) return true;
      if (isbnQuery.length >= 10 && r.isbn && r.isbn.includes(isbnQuery)) return true;
      return matchesQuery(r, query);
    });

    const groups = new Map();
    for (const r of matches) {
      const key = normText(r.title) + '|' + normText(r.author);
      let g = groups.get(key);
      if (!g) {
        g = { title: r.title, author: r.author, isbn: r.isbn, cover: r.cover_url, copies: [] };
        groups.set(key, g);
      }
      g.cover ||= r.cover_url;
      g.isbn ||= r.isbn;
      g.copies.push({ bookId: r.id, status: r.status, owner: { id: r.owner_id, name: r.owner_name } });
    }
    return [...groups.values()].slice(0, limit);
  }

  // ---------- borrow requests ----------

  createRequest({ bookId, borrowerId, ownerId, note }) {
    return this.q(
      `INSERT INTO requests (book_id, borrower_id, owner_id, note, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id`,
    ).get(bookId, borrowerId, ownerId, note || '', now()).id;
  }

  requestById(id) {
    return this.q(`${REQUEST_SELECT} WHERE r.id = ?`).get(id);
  }

  /** Open requests plus anything closed in the last 30 days, newest first. */
  requestsFor(memberId) {
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    return this.q(
      `${REQUEST_SELECT}
       WHERE (r.borrower_id = ? OR r.owner_id = ?)
         AND (r.status IN ('pending', 'accepted') OR r.created_at > ?)
       ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END, r.id DESC`,
    ).all(memberId, memberId, since);
  }

  openRequestFor(borrowerId, bookId) {
    return this.q(
      `SELECT * FROM requests WHERE borrower_id = ? AND book_id = ? AND status IN ('pending', 'accepted')`,
    ).get(borrowerId, bookId);
  }

  activeLoanForBook(bookId) {
    return this.q(`SELECT id FROM requests WHERE book_id = ? AND status = 'accepted'`).get(bookId);
  }

  countPending(borrowerId) {
    return this.q(`SELECT COUNT(*) AS n FROM requests WHERE borrower_id = ? AND status = 'pending'`).get(borrowerId).n;
  }

  updateRequest(id, fields) {
    const keys = Object.keys(fields);
    this.q(`UPDATE requests SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...keys.map((k) => fields[k]),
      id,
    );
    return this.requestById(id);
  }

  /** Accepted loans that need a reminder: due within `soonMs`, or overdue by `lateMs` (second reminder). */
  loansNeedingReminder(at, soonMs, lateMs) {
    const soon = new Date(at.getTime() + soonMs).toISOString();
    const late = new Date(at.getTime() - lateMs).toISOString();
    return this.q(
      `${REQUEST_SELECT}
       WHERE r.status = 'accepted' AND r.due_at IS NOT NULL
         AND ((r.reminders = 0 AND r.due_at <= ?) OR (r.reminders = 1 AND r.due_at <= ?))`,
    ).all(soon, late);
  }

  // ---------- relayed messages ----------

  addMessage(requestId, fromId, body) {
    return this.q('INSERT INTO messages (request_id, from_id, body, created_at) VALUES (?, ?, ?, ?) RETURNING *').get(
      requestId,
      fromId,
      body,
      now(),
    );
  }

  messagesFor(requestId) {
    return this.q('SELECT * FROM messages WHERE request_id = ? ORDER BY id').all(requestId);
  }

  recordOutbound(waId, memberId, requestId) {
    this.q('INSERT OR REPLACE INTO outbound (wa_id, member_id, request_id, created_at) VALUES (?, ?, ?, ?)').run(
      waId,
      memberId,
      requestId,
      now(),
    );
  }

  requestForOutbound(waId, memberId) {
    return this.q('SELECT request_id FROM outbound WHERE wa_id = ? AND member_id = ?').get(waId, memberId)?.request_id;
  }

  // ---------- wishlist ----------

  addWish(memberId, query) {
    const existing = this.q('SELECT * FROM wishes WHERE member_id = ? AND query = ?').get(memberId, query);
    return existing || this.q('INSERT INTO wishes (member_id, query, created_at) VALUES (?, ?, ?) RETURNING *').get(memberId, query, now());
  }

  wishesOf(memberId) {
    return this.q('SELECT * FROM wishes WHERE member_id = ? ORDER BY id').all(memberId);
  }

  removeWish(memberId, id) {
    return this.q('DELETE FROM wishes WHERE id = ? AND member_id = ? RETURNING *').get(id, memberId);
  }

  allWishes() {
    return this.q('SELECT * FROM wishes').all();
  }

  // ---------- blocking ----------

  block(blockerId, blockedId) {
    this.q('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)').run(blockerId, blockedId);
  }

  /** True if either member has blocked the other. */
  isBlocked(a, b) {
    return Boolean(
      this.q(
        'SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)',
      ).get(a, b, b, a),
    );
  }

  // ---------- WhatsApp inbox ----------

  addInbox(memberId, { text, buttons, requestId, relay }) {
    this.q('INSERT INTO inbox (member_id, request_id, text, buttons, relay, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      memberId,
      requestId ?? null,
      text,
      buttons ? JSON.stringify(buttons) : null,
      relay ? 1 : 0,
      now(),
    );
  }

  pendingInbox(memberId) {
    return this.q('SELECT * FROM inbox WHERE member_id = ? AND delivered_at IS NULL ORDER BY id')
      .all(memberId)
      .map((r) => ({ ...r, buttons: r.buttons ? JSON.parse(r.buttons) : null }));
  }

  markInboxDelivered(ids) {
    const mark = this.q('UPDATE inbox SET delivered_at = ? WHERE id = ?');
    for (const id of ids) mark.run(now(), id);
  }

  // ---------- usage (WhatsApp cost tracking) ----------

  bumpUsage(kind, month = now().slice(0, 7)) {
    const col = kind === 'template' ? 'templates' : 'service';
    this.q(`INSERT INTO usage (month, ${col}) VALUES (?, 1) ON CONFLICT(month) DO UPDATE SET ${col} = ${col} + 1`).run(month);
  }

  usageFor(month = now().slice(0, 7)) {
    return this.q('SELECT * FROM usage WHERE month = ?').get(month) || { month, templates: 0, service: 0 };
  }

  stats() {
    return this.q(
      `SELECT (SELECT COUNT(*) FROM books) AS books, (SELECT COUNT(*) FROM members) AS members,
              (SELECT COUNT(*) FROM requests WHERE status = 'accepted') AS loans`,
    ).get();
  }
}
