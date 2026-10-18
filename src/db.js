import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL UNIQUE,
  token      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS books_owner ON books(owner_id);
CREATE INDEX IF NOT EXISTS books_isbn ON books(isbn);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return new Store(db);
}

const newToken = () => crypto.randomBytes(24).toString('base64url');

/** Lower-cases and strips punctuation so "The Alchemist!" and "the alchemist" compare equal. */
export const normText = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export class Store {
  constructor(db) {
    this.db = db;
  }

  // ---- members ----

  memberByPhone(phone) {
    return this.db.prepare('SELECT * FROM members WHERE phone = ?').get(phone);
  }

  memberByToken(token) {
    if (!token) return undefined;
    return this.db.prepare('SELECT * FROM members WHERE token = ?').get(token);
  }

  /** Creates the member, or returns the existing one for that phone (updating the name). */
  upsertMember({ name, phone }) {
    const existing = this.memberByPhone(phone);
    if (existing) {
      if (name && name !== existing.name) {
        this.db.prepare('UPDATE members SET name = ? WHERE id = ?').run(name, existing.id);
        existing.name = name;
      }
      return existing;
    }
    this.db
      .prepare('INSERT INTO members (name, phone, token) VALUES (?, ?, ?)')
      .run(name, phone, newToken());
    return this.memberByPhone(phone);
  }

  // ---- books ----

  /**
   * Adds books for a member, skipping ones they already have (same ISBN or same title+author).
   * Returns { added: [...rows], skipped: [...inputs] }.
   */
  addBooks(ownerId, books, batchId = crypto.randomUUID()) {
    const mine = this.booksOf(ownerId);
    const haveIsbn = new Set(mine.filter((b) => b.isbn).map((b) => b.isbn));
    const haveTitle = new Set(mine.map((b) => normText(b.title) + '|' + normText(b.author)));
    const insert = this.db.prepare(
      `INSERT INTO books (owner_id, title, author, isbn, cover_url, batch_id)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
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
      added.push(insert.get(ownerId, title, author, b.isbn || null, b.cover || null, batchId));
      if (b.isbn) haveIsbn.add(b.isbn);
      haveTitle.add(key);
    }
    return { added, skipped, batchId };
  }

  booksOf(ownerId) {
    return this.db
      .prepare('SELECT * FROM books WHERE owner_id = ? ORDER BY title COLLATE NOCASE')
      .all(ownerId);
  }

  setStatus(ownerId, bookId, status) {
    return this.db
      .prepare('UPDATE books SET status = ? WHERE id = ? AND owner_id = ? RETURNING *')
      .get(status, bookId, ownerId);
  }

  removeBook(ownerId, bookId) {
    return this.db
      .prepare('DELETE FROM books WHERE id = ? AND owner_id = ? RETURNING *')
      .get(bookId, ownerId);
  }

  /** Removes the member's most recently added batch (used by the WhatsApp "undo" command). */
  undoLastBatch(ownerId) {
    const last = this.db
      .prepare(
        'SELECT batch_id FROM books WHERE owner_id = ? AND batch_id IS NOT NULL ORDER BY id DESC LIMIT 1',
      )
      .get(ownerId);
    if (!last) return [];
    return this.db
      .prepare('DELETE FROM books WHERE owner_id = ? AND batch_id = ? RETURNING *')
      .all(ownerId, last.batch_id);
  }

  /**
   * Searches the whole catalogue. Every word of the query must appear in the title, author or ISBN.
   * Copies of the same book owned by different members are grouped together.
   */
  search(query, { limit = 100 } = {}) {
    const words = normText(query).split(' ').filter(Boolean);
    const isbnQuery = String(query || '').replace(/[^0-9Xx]/g, '');
    const rows = this.db
      .prepare(
        `SELECT b.*, m.name AS owner_name, m.phone AS owner_phone
         FROM books b JOIN members m ON m.id = b.owner_id
         ORDER BY b.created_at DESC, b.id DESC`,
      )
      .all();

    const matches = rows.filter((r) => {
      if (!words.length) return true;
      if (isbnQuery.length >= 10 && r.isbn && r.isbn.includes(isbnQuery)) return true;
      const hay = normText(r.title) + ' ' + normText(r.author);
      return words.every((w) => hay.includes(w));
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
      g.copies.push({
        bookId: r.id,
        status: r.status,
        owner: { id: r.owner_id, name: r.owner_name, phone: r.owner_phone },
      });
    }
    return [...groups.values()].slice(0, limit);
  }

  stats() {
    return this.db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM books) AS books, (SELECT COUNT(*) FROM members) AS members',
      )
      .get();
  }
}
