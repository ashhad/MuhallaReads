// A small in-memory world for tests: store, fake WhatsApp transport, controllable clock.
import { openDb } from '../src/db.js';
import { createNotifier } from '../src/notifier.js';
import { createLibrary } from '../src/library.js';
import { createBot } from '../src/bot.js';

export const AYESHA = '919800000001';
export const BILAL = '919800000002';
export const CHAND = '919800000003';

export const baseSettings = {
  communityName: 'Test Muhalla',
  joinCode: '',
  adminPhones: [AYESHA],
  publicUrl: 'https://books.example.org',
  timeZone: 'Asia/Kolkata',
  loanDays: 21,
  maxPendingRequests: 5,
  monthlyTemplateLimit: 200,
  templatesEnabled: true,
};

export function fakeTransport() {
  let n = 0;
  const sent = [];
  return {
    sent,
    async send(to, { text, buttons }) {
      const id = `wamid.${++n}`;
      sent.push({ id, to, kind: 'text', text, buttons });
      return id;
    },
    async sendTemplate(to, t) {
      const id = `wamid.${++n}`;
      sent.push({ id, to, kind: 'template', ...t });
      return id;
    },
    to(phone) {
      return sent.filter((s) => s.to === phone);
    },
    clear() {
      sent.length = 0;
    },
  };
}

export function makeWorld({ settings = {}, photoBooks = [] } = {}) {
  const store = openDb(':memory:');
  const transport = fakeTransport();
  const time = { now: Date.now() };
  const clock = () => new Date(time.now);
  const s = { ...baseSettings, ...settings };
  const notifier = createNotifier({ store, transport, settings: s, clock });
  const library = createLibrary({ store, notifier, settings: s, clock });
  const bot = createBot({
    store,
    library,
    notifier,
    settings: s,
    enrichAll: async (books) =>
      books.map((b) => (b.isbn === '9780062315007' ? { ...b, title: 'The Alchemist', author: 'Paulo Coelho' } : b)),
    identifyBooks: async () => photoBooks,
  });

  /** Sends a WhatsApp message as `phone`; returns the bot's direct replies joined together. */
  async function say(phone, text, extra = {}) {
    const replies = [];
    await bot.handle({ phone, text, ...extra }, async (t, buttons) => {
      replies.push(buttons ? `${t}\n[${buttons.map((b) => `${b.title}=${b.id}`).join(' | ')}]` : t);
    });
    return replies.join('\n---\n');
  }

  /** Makes it look like the member hasn't messaged the bot for two days (WhatsApp window closed). */
  function closeWindow(phone) {
    const m = store.memberByPhone(phone);
    store.touchInbound(m.id, new Date(time.now - 2 * 86400_000).toISOString());
  }

  return { store, transport, notifier, library, bot, say, closeWindow, time, settings: s };
}
