// Sends a message to the library's admins on WhatsApp. Used by the security monitor (deploy/oracle/soc).
//   node scripts/notify-admins.js [--if-free] "text"     (or pipe the text in)
// Free when an admin has messaged the bot in the last 24 hours; otherwise it waits and is delivered
// the next time they do (never a paid template). With --if-free it's dropped instead of waiting.
import fs from 'node:fs';
import { config, whatsappEnabled } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createNotifier } from '../src/notifier.js';
import { createMetaTransport } from '../src/whatsapp.js';

const args = process.argv.slice(2);
const optional = args[0] === '--if-free';
if (optional) args.shift();
const text = (args.join(' ') || fs.readFileSync(0, 'utf8')).trim().slice(0, 3500);
if (!text) {
  console.error('Usage: node scripts/notify-admins.js [--if-free] "message"');
  process.exit(1);
}
const store = openDb(config.dbPath);
const transport = whatsappEnabled() ? createMetaTransport(config.whatsapp) : null;
const notifier = createNotifier({ store, transport, settings: config });

let told = 0;
for (const phone of config.adminPhones) {
  const admin = store.memberByPhone(phone);
  if (admin?.status !== 'active') continue;
  console.log(`admin #${admin.id}: ${await notifier.notify(admin.id, { text, optional })}`);
  told++;
}
if (!told) {
  console.error('No active admin to tell (check ADMIN_PHONES).');
  process.exit(2);
}
