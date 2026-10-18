// The WhatsApp bot's brain. Transport-agnostic: whatsapp.js feeds it messages and sends its replies.
import { looksLikeIsbn, normalizeIsbn } from './isbn.js';
import { waLink } from './phone.js';

const MAX_RESULTS = 5;
const MAX_MESSAGE = 3900; // WhatsApp's limit is 4096 characters

export function helpText(communityName) {
  return [
    `📚 *${communityName}* — our neighbourhood library`,
    '',
    '🔎 *Find a book*: just type its title or author',
    '➕ *Add a book*: `add The Alchemist by Paulo Coelho`',
    '   or `add 9780062315007` (ISBN)',
    '   or several at once, one per line after `add`',
    '📷 *Add by photo*: send a photo of a cover, barcode or your bookshelf',
    '📖 *Your books*: `my books`',
    '🗑️ `remove 12` · 🤝 `lent 12` · ✅ `back 12`',
    '↩️ `undo` removes the books you added last',
  ].join('\n');
}

/** Splits "Title by Author" / "Title - Author" into parts. */
export function parseBookLine(line) {
  const text = line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '').trim();
  if (looksLikeIsbn(text)) return { title: '', author: '', isbn: normalizeIsbn(text) };
  const by = /^(.*\S)\s+by\s+(\S.*)$/i.exec(text);
  if (by) return { title: by[1].trim(), author: by[2].trim(), isbn: null };
  const dash = /^(.*\S)\s+[-–—]\s+(\S.*)$/.exec(text);
  if (dash) return { title: dash[1].trim(), author: dash[2].trim(), isbn: null };
  return { title: text, author: '', isbn: null };
}

const describe = (b) => `*${b.title}*${b.author ? ` — ${b.author}` : ''}`;

const clip = (s) => (s.length > MAX_MESSAGE ? s.slice(0, MAX_MESSAGE - 20) + '\n…(more not shown)' : s);

/**
 * @param {object} deps
 * @param {import('./db.js').Store} deps.store
 * @param {(books: object[]) => Promise<object[]>} deps.enrichAll
 * @param {(buf: Buffer, type: string) => Promise<object[]>} deps.identifyBooks
 * @param {{communityName: string, joinCode: string, publicUrl?: string}} deps.settings
 */
export function createBot({ store, enrichAll, identifyBooks, settings }) {
  async function addBooks(member, books, reply) {
    const enriched = await enrichAll(books);
    const usable = enriched.filter((b) => b.title);
    const unknown = enriched.length - usable.length;
    const { added, skipped } = store.addBooks(member.id, usable);
    const lines = [];
    if (added.length) {
      lines.push(`✅ Added ${added.length} book${added.length > 1 ? 's' : ''}:`);
      for (const b of added) lines.push(`#${b.id} ${describe(b)}`);
    }
    if (skipped.length) lines.push(`ℹ️ Already in your list: ${skipped.map((b) => b.title).join(', ')}`);
    if (unknown) lines.push(`⚠️ Couldn't find ${unknown} ISBN${unknown > 1 ? 's' : ''} — try adding by title instead.`);
    if (added.length) lines.push('', 'Wrong? Reply `undo`, or `remove <number>`.');
    await reply(clip(lines.join('\n') || 'Nothing to add.'));
  }

  function searchReply(member, query) {
    const groups = store.search(query, { limit: MAX_RESULTS + 1 });
    if (!groups.length) {
      return `😕 Nobody has "${query}" yet.\nAsk your group: ${waLink('', `Does anyone have "${query}"? 📚`)}`;
    }
    const lines = [];
    for (const g of groups.slice(0, MAX_RESULTS)) {
      lines.push(`📖 ${describe(g)}`);
      for (const c of g.copies) {
        const who = c.owner.id === member.id ? 'You' : c.owner.name;
        const state = c.status === 'lent' ? ' (lent out)' : ' ✅';
        const link =
          c.owner.id === member.id
            ? ''
            : `\n     ${waLink(c.owner.phone, `Hi ${c.owner.name}! Could I borrow "${g.title}"? (found it on ${settings.communityName})`)}`;
        lines.push(`   • ${who}${state}${link}`);
      }
      lines.push('');
    }
    if (groups.length > MAX_RESULTS) lines.push('More results — try a more specific search.');
    return clip(lines.join('\n').trim());
  }

  function myBooks(member) {
    const books = store.booksOf(member.id);
    if (!books.length) return 'You haven\'t added any books yet. Send `add <title>` or a photo of your shelf.';
    const lines = [`📚 Your ${books.length} book${books.length > 1 ? 's' : ''}:`];
    for (const b of books) lines.push(`#${b.id} ${describe(b)}${b.status === 'lent' ? ' (lent out)' : ''}`);
    return clip(lines.join('\n'));
  }

  /**
   * Handles one incoming message.
   * @param {{phone: string, profileName?: string, text?: string, image?: () => Promise<{buffer: Buffer, mediaType: string}>}} msg
   * @param {(text: string) => Promise<void>} reply
   */
  async function handle(msg, reply) {
    const text = (msg.text || '').trim();
    let member = store.memberByPhone(msg.phone);

    if (!member) {
      const join = /^join\b\s*(.*)$/is.exec(text);
      const code = join?.[1]?.trim() || '';
      if (settings.joinCode && code !== settings.joinCode) {
        return reply(
          `👋 Welcome to *${settings.communityName}*!\nTo join, reply: \`join <community code>\`\n(Ask a neighbour for the code.)`,
        );
      }
      member = store.upsertMember({ name: msg.profileName || `Member ${msg.phone.slice(-4)}`, phone: msg.phone });
      await reply(`🎉 You're in, ${member.name}!\n\n${helpText(settings.communityName)}`);
      if (join || !text) return;
    }

    if (msg.image) {
      await reply('📷 Got it — looking for books in your photo…');
      let found;
      try {
        const { buffer, mediaType } = await msg.image();
        found = await identifyBooks(buffer, mediaType);
      } catch (err) {
        return reply(`⚠️ ${err.message || 'Could not read that photo.'}`);
      }
      if (!found.length) return reply('😕 I couldn\'t make out any book titles. Try a closer, well-lit photo.');
      return addBooks(member, found, reply);
    }

    if (!text) return reply(helpText(settings.communityName));

    let m;
    if (/^(help|hi|hello|hey|menu|start|salaam|salam|\?)\W*$/i.test(text)) return reply(helpText(settings.communityName));
    if (/^join\b/i.test(text)) return reply(`You're already a member, ${member.name}! 🙂`);
    if ((m = /^add\b[:\s]*([\s\S]*)$/i.exec(text))) {
      const lines = m[1].split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length) return reply('What should I add? e.g. `add The Alchemist by Paulo Coelho`');
      return addBooks(member, lines.map(parseBookLine), reply);
    }
    if (/^(my books|my|mine|my list|list)$/i.test(text)) return reply(myBooks(member));
    if ((m = /^(remove|delete|del)\s+#?(\d+)$/i.exec(text))) {
      const b = store.removeBook(member.id, Number(m[2]));
      return reply(b ? `🗑️ Removed ${describe(b)}` : `No book #${m[2]} in your list. Send \`my books\` to see numbers.`);
    }
    if ((m = /^(lent|lend|loaned|given)\s+#?(\d+)/i.exec(text))) {
      const b = store.setStatus(member.id, Number(m[2]), 'lent');
      return reply(b ? `🤝 Marked ${describe(b)} as lent out.` : `No book #${m[2]} in your list.`);
    }
    if ((m = /^(back|returned|available)\s+#?(\d+)/i.exec(text))) {
      const b = store.setStatus(member.id, Number(m[2]), 'available');
      return reply(b ? `✅ ${describe(b)} is available again.` : `No book #${m[2]} in your list.`);
    }
    if (/^undo$/i.test(text)) {
      const removed = store.undoLastBatch(member.id);
      return reply(removed.length ? `↩️ Removed ${removed.map((b) => b.title).join(', ')}` : 'Nothing to undo.');
    }

    m = /^(find|search|who has|whohas|anyone has|does anyone have)\b[:\s]*(.+)$/i.exec(text);
    const query = (m ? m[2] : text).replace(/[?？]+$/, '').trim();
    return reply(searchReply(member, query));
  }

  return { handle };
}
