import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';

test('upgrades a database created before building/locality existed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muhalla-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE members (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE,
            last_inbound_at TEXT, created_at TEXT NOT NULL);
            INSERT INTO members (name, phone, created_at) VALUES ('Ayesha', '919800000001', '2026-10-18');`);
  old.close();

  const store = openDb(file);
  const m = store.memberByPhone('919800000001');
  assert.equal(m.building, '');
  assert.equal(store.setPlace(m.id, { building: 'Green Park Tower', locality: '' }).building, 'Green Park Tower');
  openDb(file); // opening again is a no-op
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Hindi titles keep their vowel signs when matched and searched', async () => {
  const { normText, openDb } = await import('../src/db.js');
  assert.equal(normText('वातायन'), 'वातायन');
  assert.equal(normText('  मेरी प्रिय कहानियाँ! '), 'मेरी प्रिय कहानियाँ');
  assert.equal(normText('Café Coffee'), 'cafe coffee'); // Latin accents still ignored

  const store = openDb(':memory:');
  const m = store.createMember({ name: 'Aditi', phone: '919800000009' });
  store.addBooks(m.id, [{ title: 'जालक', author: 'शिवानी' }]);
  const { added } = store.addBooks(m.id, [{ title: 'जलक', author: 'शिवानी' }]); // differs only by a vowel sign
  assert.equal(added.length, 1);
  assert.equal(store.search('वातायन').length, 0);
  assert.equal(store.search('जालक').length, 1);
});
