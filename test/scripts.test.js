// The command-line helpers the server's scripts use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { openDb } from '../src/db.js';

const run = promisify(execFile);
const ADMIN = '919800000001';

function notifyAdmins(dataDir, args, env = {}) {
  return run(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/notify-admins.js', ...args], {
    env: { PATH: process.env.PATH, DATA_DIR: dataDir, ADMIN_PHONES: ADMIN, ...env },
  });
}

test('notify-admins: security alerts wait for the admin; reports are only sent when free', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-'));
  const store = openDb(path.join(dataDir, 'muhallareads.db'));
  const admin = store.createMember({ name: 'Ayesha', phone: ADMIN, status: 'active' });

  const alert = await notifyAdmins(dataDir, ['🛡️ SSH login: ubuntu from 203.0.113.9']);
  assert.match(alert.stdout, /admin #\d+: queued/); // no WhatsApp window open, so it waits (never a paid template)
  assert.match(store.pendingInbox(admin.id)[0].text, /SSH login/);

  const report = await notifyAdmins(dataDir, ['--if-free', 'daily report']);
  assert.match(report.stdout, /dropped/);
  assert.equal(store.pendingInbox(admin.id).length, 1);

  await assert.rejects(notifyAdmins(dataDir, ['hi'], { ADMIN_PHONES: '919800000009' }), (err) => err.code === 2);
});

test('reset-requests: shows what it would clear, and with --yes saves a copy first, then clears it', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-'));
  const file = path.join(dataDir, 'muhallareads.db');
  const store = openDb(file);
  const owner = store.createMember({ name: 'Ayesha', phone: ADMIN });
  const borrower = store.createMember({ name: 'Bilal', phone: '919800000002' });
  const book = store.addBooks(owner.id, [{ title: 'Dune' }]).added[0];
  store.createRequest({ bookId: book.id, borrowerId: borrower.id, ownerId: owner.id, note: '' });
  const reset = (...args) =>
    run(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/reset-requests.js', ...args], {
      env: { PATH: process.env.PATH, DATA_DIR: dataDir },
    });

  const dry = await reset();
  assert.match(dry.stdout, /Requests and loans: 1 \(1 waiting for an answer, 0 lent out now/);
  assert.match(dry.stdout, /Nothing has changed/);
  assert.equal(store.requestCounts().requests, 1);

  const done = await reset('--yes');
  assert.match(done.stdout, /Done: all of the above is cleared/);
  assert.equal(store.requestCounts().requests, 0);
  const [copy] = fs.readdirSync(dataDir).filter((f) => f.includes('-before-reset-'));
  assert.equal(fs.statSync(path.join(dataDir, copy)).mode & 0o777, 0o600);
  assert.equal(openDb(path.join(dataDir, copy)).requestCounts().requests, 1);
});
