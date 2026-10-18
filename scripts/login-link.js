// Prints a one-time sign-in link for a member, for testing without WhatsApp or helping someone who
// can't use the bot. Creates the member if needed.
//   node scripts/login-link.js <whatsapp number> [display name]
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { normalizePhone } from '../src/phone.js';

const phone = normalizePhone(process.argv[2]);
if (!phone) {
  console.error('Usage: node scripts/login-link.js <whatsapp number> [display name]');
  process.exit(1);
}
const store = openDb(config.dbPath);
const member = store.memberByPhone(phone) || store.createMember({ name: process.argv[3] || 'Neighbour', phone });
const base = config.publicUrl || `http://localhost:${config.port}`;
console.log(`${member.name}: ${base}/#login=${store.createLoginCode(member.id)}`);
