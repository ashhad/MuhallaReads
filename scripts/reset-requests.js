// Starts lending afresh: deletes every borrow request and loan (waiting, lent out, returned, lost…),
// their chats and the queues, and puts books lent through the app back on the shelf. Members, books
// and wishlists stay. Without --yes it only shows what it would delete. With --yes it first saves a
// copy of the database next to it.
//   node scripts/reset-requests.js [--yes]
import fs from 'node:fs';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';

const store = openDb(config.dbPath);
store.db.exec('PRAGMA busy_timeout = 10000'); // the app may be writing at the same moment

const show = (c) =>
  [
    `Requests and loans: ${c.requests} (${c.pending} waiting for an answer, ${c.lent} lent out now, ${c.lost} marked lost, ` +
      `${c.requests - c.pending - c.lent - c.lost} finished)`,
    `Chat messages: ${c.messages}`,
    `People in queues: ${c.holds}`,
    `Books going back on the shelf: ${c.books}`,
  ].join('\n');

if (!process.argv.includes('--yes')) {
  console.log(show(store.requestCounts()));
  console.log("\nNothing has changed. Members' borrowing records and badges start again from zero too.");
  console.log('To delete all of this, run the same command with --yes at the end.');
  process.exit(0);
}

const backup = `${config.dbPath.replace(/\.db$/, '')}-before-reset-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.db`;
store.db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
fs.chmodSync(backup, 0o600); // it holds members' phone numbers
console.log(show(store.resetRequests()));
console.log(`\nDone: all of the above is cleared. A copy from just before is at ${backup}`);
