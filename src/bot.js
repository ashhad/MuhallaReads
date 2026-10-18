// The WhatsApp bot's brain. whatsapp.js feeds it incoming messages; it replies via `send`.
// Members only ever see each other's display names. Phone numbers stay on the server.
import { looksLikeIsbn, normalizeIsbn } from './isbn.js';
import { LibraryError, who } from './library.js';
import { placeOf } from './db.js';

const MAX_RESULTS = 5;
const MAX_MESSAGE = 3900; // WhatsApp's limit is 4096 characters

export function helpText(communityName) {
  return [
    `📚 *${communityName}*: our neighbourhood library`,
    '',
    '🔎 *Find*: type a title or author',
    '🙋 *Borrow*: `want 12` (the number from search results)',
    '➕ *Add*: `add Title by Author`, `add <ISBN>`, or send a photo of your shelf',
    '📋 `requests`: your requests and loans',
    '💬 `msg 7 hello`: message about request 7 (or swipe-reply)',
    '🔔 `notify me`: after a search finds nothing',
    '📖 `my books` · ↩️ `undo` · 🗑️ `remove 12`',
    '🌐 `login`: open the website',
    '👤 `name Ashhad`: how neighbours see you',
    '🏢 `building Green Park Tower` · 📍 `locality Saket`: where you are (shown with your name)',
    '',
    '🔒 Your number is never shown to anyone. `share 7` gives it to that one person, only if you choose.',
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

/** Display names: no WhatsApp formatting characters, no line breaks, 2–40 characters. */
export function cleanName(s, max = 40) {
  const name = String(s || '').replace(/[*_~`\n\r\t]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  return name.length >= 2 ? name : '';
}

/** Building or locality: like a name, up to 60 characters. */
export const cleanPlace = (s) => cleanName(s, 60);

const ASK_BUILDING =
  '🏢 What\'s your *building or society* name? e.g. _Green Park Tower_\n' +
  'Only this and your locality are shown next to your name, never your flat number or address.';
const ASK_LOCALITY = '📍 And your *locality or area*? e.g. _Saket_';
const SKIP = [{ id: 'skip', title: 'Skip' }];

const describe = (b) => `*${b.title}*${b.author ? ` — ${b.author}` : ''}`;
const clip = (s) => (s.length > MAX_MESSAGE ? s.slice(0, MAX_MESSAGE - 20) + '\n…(more not shown)' : s);
const shorten = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Button ids look like "accept:7"; turn them into the equivalent typed command.
const payloadToCommand = (p) => String(p).replace(':', ' ');
const payloadRequestId = (p) => {
  const m = /^(accept|decline|share):(\d+)$/.exec(String(p || ''));
  return m ? Number(m[2]) : undefined;
};

/**
 * @param {object} deps
 * @param {import('./db.js').Store} deps.store
 * @param {ReturnType<import('./library.js').createLibrary>} deps.library
 * @param {ReturnType<import('./notifier.js').createNotifier>} deps.notifier
 * @param {(books: object[]) => Promise<object[]>} deps.enrichAll
 * @param {(buf: Buffer, type: string) => Promise<object[]>} deps.identifyBooks
 * @param {object} deps.settings
 */
export function createBot({ store, library, notifier, enrichAll, identifyBooks, settings }) {
  const lastEmptySearch = new Map(); // member id -> query, for "notify me"
  const confirmingDelete = new Set();
  const setupStep = new Map(); // member id -> 'building' | 'locality' while answering the setup questions

  /** First-time setup: building, then locality. At least one is required. */
  async function setup(member, text, reply) {
    const step = setupStep.get(member.id);
    const skip = /^skip$/i.test(text);
    if (step && !skip && isCommand(text)) {
      // e.g. tapping a button from an older message: finish setup first
      return reply(`Let's finish setting you up first.\n\n${step === 'building' ? ASK_BUILDING : ASK_LOCALITY}`, SKIP);
    }
    if (!step) {
      setupStep.set(member.id, 'building');
      return reply(ASK_BUILDING, SKIP);
    }
    if (step === 'building') {
      if (!skip) {
        const building = cleanPlace(text);
        if (!building) return reply('Please send your building or society name, or tap *Skip*.', SKIP);
        store.setPlace(member.id, { building, locality: member.locality });
      }
      setupStep.set(member.id, 'locality');
      return reply(ASK_LOCALITY, store.memberById(member.id).building ? SKIP : undefined);
    }
    const locality = skip ? '' : cleanPlace(text);
    if (!locality && !member.building) {
      return reply('Please send at least your locality, so neighbours have a rough idea where you are. e.g. _Saket_');
    }
    if (locality) store.setPlace(member.id, { building: member.building, locality });
    setupStep.delete(member.id);
    const me = store.memberById(member.id);
    const website = settings.publicUrl
      ? `\n\n🌐 Or use the website (link works once, for 15 minutes):\n${settings.publicUrl}/#login=${store.createLoginCode(me.id)}`
      : '';
    return reply(
      `✅ All set! Neighbours will see you as *${who(me)}*.\n` +
        'Change it any time with `name …`, `building …` or `locality …`.\n\n' +
        'Now type a book title to search, or `add <title>` to share one of yours. Send *help* for everything else.' +
        website,
    );
  }

  /** Changes building or locality later, keeping at least one of them. */
  function changePlace(member, field, value, reply) {
    const cleared = /^(none|remove|clear|-)$/i.test(value.trim());
    const v = cleared ? '' : cleanPlace(value);
    if (!v && !cleared) return reply(`Please give a ${field} of 2–60 characters.`);
    const next = { building: member.building, locality: member.locality, [field]: v };
    if (!next.building && !next.locality) return reply('Keep at least one of building or locality, so neighbours know roughly where you are.');
    const me = store.setPlace(member.id, next);
    return reply(`📍 Neighbours now see you as *${who(me)}*.`);
  }

  async function addBooks(member, books, reply) {
    const enriched = await enrichAll(books);
    const usable = enriched.filter((b) => b.title);
    const unknown = enriched.length - usable.length;
    const { added, skipped } = await library.addBooks(member, usable);
    const lines = [];
    if (added.length) {
      lines.push(`✅ Added ${added.length} book${added.length > 1 ? 's' : ''}:`);
      for (const b of added) lines.push(`#${b.id} ${describe(b)}`);
    }
    if (skipped.length) lines.push(`ℹ️ Already in your list: ${skipped.map((b) => b.title).join(', ')}`);
    if (unknown) lines.push(`⚠️ Couldn't find ${unknown} ISBN${unknown > 1 ? 's' : ''}. Try adding by title instead.`);
    if (added.length) lines.push('', 'Wrong? Reply `undo`, or `remove <number>`.');
    await reply(clip(lines.join('\n') || 'Nothing to add.'));
  }

  async function search(member, query, reply) {
    const groups = store.search(query, { limit: MAX_RESULTS + 1 });
    if (!groups.length) {
      lastEmptySearch.set(member.id, query);
      return reply(`😕 Nobody has "${query}" yet.\nReply *notify me* and I'll tell you when someone adds it.`, [
        { id: `wish:${query.slice(0, 100)}`, title: 'Notify me' },
      ]);
    }
    const lines = [];
    const wantable = [];
    for (const g of groups.slice(0, MAX_RESULTS)) {
      lines.push(`📖 ${describe(g)}`);
      for (const c of g.copies) {
        const owner = c.owner.place ? `${c.owner.name} · ${c.owner.place}` : c.owner.name;
        if (c.owner.id === member.id) lines.push('   • You');
        else if (c.status === 'lent') lines.push(`   • ${owner} (lent out)`);
        else {
          lines.push(`   • ${owner} ✅ → *want ${c.bookId}*`);
          wantable.push({ ...c, title: g.title });
        }
      }
      lines.push('');
    }
    if (groups.length > MAX_RESULTS) lines.push('More results: try a more specific search.');
    const single = groups.length === 1;
    const buttons =
      wantable.length && wantable.length <= 3
        ? wantable.map((c) => ({
            id: `want:${c.bookId}`,
            title: single ? shorten(`Ask ${c.owner.name}`, 20) : shorten(`${shorten(c.title, 10)}·${c.owner.name}`, 20),
          }))
        : undefined;
    return reply(clip(lines.join('\n').trim()), buttons);
  }

  function myBooks(member) {
    const books = store.booksOf(member.id);
    if (!books.length) return "You haven't added any books yet. Send `add <title>` or a photo of your shelf.";
    const lines = [`📚 Your ${books.length} book${books.length > 1 ? 's' : ''}:`];
    for (const b of books) lines.push(`#${b.id} ${describe(b)}${b.status === 'lent' ? ' (lent out)' : ''}`);
    return clip(lines.join('\n'));
  }

  function requestsText(member) {
    const all = store.requestsFor(member.id);
    const incoming = all.filter((r) => r.owner_id === member.id && r.status === 'pending');
    const lending = all.filter((r) => r.owner_id === member.id && r.status === 'accepted');
    const mine = all.filter((r) => r.borrower_id === member.id && ['pending', 'accepted'].includes(r.status));
    if (!incoming.length && !lending.length && !mine.length) return 'No open requests or loans.';
    const lines = [];
    if (incoming.length) {
      lines.push('📥 *Asking for your books*');
      for (const r of incoming) {
        const borrower = who({ name: r.borrower_name, building: r.borrower_building, locality: r.borrower_locality });
        lines.push(`#${r.id} ${borrower} → *${r.book_title}*: *accept ${r.id}* / *decline ${r.id}*`);
      }
      lines.push('');
    }
    if (lending.length) {
      lines.push('🤝 *You lent*');
      for (const r of lending) {
        lines.push(`#${r.id} *${r.book_title}* to ${r.borrower_name}, due ${library.fmtDate(r.due_at)}. Got it back? *returned ${r.id}*`);
      }
      lines.push('');
    }
    if (mine.length) {
      lines.push('📤 *You asked for*');
      for (const r of mine) {
        lines.push(
          r.status === 'pending'
            ? `#${r.id} *${r.book_title}* from ${r.owner_name}: waiting (*cancel ${r.id}*)`
            : `#${r.id} *${r.book_title}* from ${r.owner_name}: due ${library.fmtDate(r.due_at)}`,
        );
      }
    }
    return clip(lines.join('\n').trim());
  }

  const isAdmin = (member) => settings.adminPhones?.includes(member.phone);

  // Each command: [pattern, handler(member, match, reply, msg)].
  const commands = [
    [/^(help|hi|hello|hey|menu|start|salaam|salam|\?)\W*$/i, (m, _, reply) => reply(helpText(settings.communityName))],
    [/^join\b/i, (m, _, reply) => reply(`You're already a member, ${m.name}! 🙂`)],
    [
      /^name\s+([\s\S]+)$/i,
      (m, x, reply) => {
        const name = cleanName(x[1]);
        if (!name) return reply('Please give a name of 2–40 characters, e.g. `name Ashhad (Block C)`');
        store.renameMember(m.id, name);
        return reply(`👤 Neighbours will now see you as *${name}*.`);
      },
    ],
    [/^building\s+([\s\S]+)$/i, (m, x, reply) => changePlace(m, 'building', x[1], reply)],
    [/^(locality|area)\s+([\s\S]+)$/i, (m, x, reply) => changePlace(m, 'locality', x[2], reply)],
    [
      /^(login|log in|website|web|link)$/i,
      (m, _, reply) => {
        if (!settings.publicUrl) return reply('The website address isn\'t set up yet. Ask the admin.');
        const code = store.createLoginCode(m.id);
        return reply(`🌐 Tap to open the library (link works once, for 15 minutes):\n${settings.publicUrl}/#login=${code}`);
      },
    ],
    [
      /^add\b[:\s]*([\s\S]*)$/i,
      (m, x, reply) => {
        const lines = x[1].split('\n').map((l) => l.trim()).filter(Boolean);
        if (!lines.length) return reply('What should I add? e.g. `add The Alchemist by Paulo Coelho`');
        return addBooks(m, lines.map(parseBookLine), reply);
      },
    ],
    [/^(my books|my|mine|my list|list|books)$/i, (m, _, reply) => reply(myBooks(m))],
    [
      /^(remove|delete|del)\s+#?(\d+)$/i,
      (m, x, reply) => {
        const b = store.removeBook(m.id, Number(x[2]));
        return reply(b ? `🗑️ Removed ${describe(b)}` : `No book #${x[2]} in your list. Send \`my books\` to see numbers.`);
      },
    ],
    [
      /^(lent|lend|loaned|given)\s+#?(\d+)$/i,
      (m, x, reply) => {
        const b = store.setStatus(m.id, Number(x[2]), 'lent');
        return reply(b ? `🤝 Marked ${describe(b)} as lent out.` : `No book #${x[2]} in your list.`);
      },
    ],
    [
      /^(back|available)\s+#?(\d+)$/i,
      async (m, x, reply) => {
        const b = await library.setAvailability(m, x[2], 'available');
        return reply(b ? `✅ ${describe(b)} is available again.` : `No book #${x[2]} in your list.`);
      },
    ],
    [
      /^undo$/i,
      (m, _, reply) => {
        const removed = store.undoLastBatch(m.id);
        return reply(removed.length ? `↩️ Removed ${removed.map((b) => b.title).join(', ')}` : 'Nothing to undo.');
      },
    ],
    [
      /^(want|borrow|request)\s+#?(\d+)(?:\s+([\s\S]+))?$/i,
      async (m, x, reply) => {
        const r = await library.want(m, x[2], x[3]);
        return reply(
          `🙋 Asked ${r.owner_name} for *${r.book_title}* (request #${r.id}). I'll let you know when they answer.\n` +
            `Your number is not shared.`,
        );
      },
    ],
    [
      /^(accept|yes|decline|no|reject)\s+#?(\d+)$/i,
      async (m, x, reply) => {
        const accept = /^(accept|yes)$/i.test(x[1]);
        const r = await library.decide(m, x[2], accept);
        if (!accept) return reply(`Declined. ${r.borrower_name} has been told.`);
        return reply(
          `✅ You're lending *${r.book_title}* to ${r.borrower_name} (due ${library.fmtDate(r.due_at)}).\n` +
            `Arrange the hand-over here: *msg ${r.id} your message*. Your number stays private unless you tap *Share my number*.\n` +
            `When you get it back: *returned ${r.id}*`,
          [{ id: `share:${r.id}`, title: 'Share my number' }],
        );
      },
    ],
    [
      /^(msg|message|reply)\s+#?(\d+)\s+([\s\S]+)$/i,
      async (m, x, reply) => {
        await library.sendMessage(m, x[2], x[3]);
        return reply('✉️ Sent.');
      },
    ],
    [
      /^share\s+#?(\d+)$/i,
      async (m, x, reply) => {
        const other = await library.shareNumber(m, x[1]);
        return reply(`📞 Your number was shared with ${other.name} only.`);
      },
    ],
    [
      /^(returned|got it back)\s+#?(\d+)$/i,
      async (m, x, reply) => {
        const r = await library.markReturned(m, x[2]);
        return reply(`📗 *${r.book_title}* is back on your shelf and available again.`);
      },
    ],
    [
      /^cancel\s+#?(\d+)$/i,
      (m, x, reply) => {
        const r = library.cancel(m, x[1]);
        return reply(`Cancelled your request for *${r.book_title}*.`);
      },
    ],
    [
      /^block\s+#?(\d+)$/i,
      (m, x, reply) => {
        const other = library.block(m, x[1]);
        return reply(`🚫 Blocked ${other.name}. They can't request your books or message you, and you won't see requests from them.`);
      },
    ],
    [/^(requests|loans|borrowed|status)$/i, (m, _, reply) => reply(requestsText(m))],
    [
      /^(wish|notify me|notify)\b[:\s]*(.*)$/is,
      (m, x, reply) => {
        const query = x[2].trim() || lastEmptySearch.get(m.id);
        if (!query) return reply('What should I watch for? e.g. `notify me Harry Potter`');
        library.addWish(m, query);
        lastEmptySearch.delete(m.id);
        return reply(`🔔 I'll tell you when someone adds "${query}".`);
      },
    ],
    [
      /^(wishes|my wishes|wishlist)$/i,
      (m, _, reply) => {
        const w = store.wishesOf(m.id);
        if (!w.length) return reply('You are not waiting for any books.');
        return reply(['🔔 Waiting for:', ...w.map((x) => `#${x.id} ${x.query}  (*unwish ${x.id}*)`)].join('\n'));
      },
    ],
    [
      /^unwish\s+#?(\d+)$/i,
      (m, x, reply) => reply(store.removeWish(m.id, Number(x[1])) ? 'Removed.' : 'Not found.'),
    ],
    [
      /^(delete me|delete my account|delete account)$/i,
      (m, _, reply) => {
        confirmingDelete.add(m.id);
        return reply(
          '⚠️ This removes your account, your books and all your requests and messages. It can\'t be undone.\n' +
            'Reply *DELETE EVERYTHING* to confirm.',
        );
      },
    ],
    [
      /^delete everything$/i,
      (m, _, reply) => {
        if (!confirmingDelete.delete(m.id)) return reply('Send *delete me* first.');
        library.deleteAccount(m);
        return reply('Your account and data have been deleted. Goodbye! 👋');
      },
    ],
    // ---- admin ----
    [
      /^stats$/i,
      (m, _, reply) => {
        if (!isAdmin(m)) return search(m, 'stats', reply);
        const s = store.stats();
        const u = store.usageFor();
        return reply(
          `📊 ${s.members} members · ${s.books} books · ${s.loans} active loans\n` +
            `WhatsApp this month: ${u.templates}/${settings.monthlyTemplateLimit} paid templates (≈ ₹${(u.templates * 0.136).toFixed(2)}), ${u.service} free replies`,
        );
      },
    ],
    [
      /^members$/i,
      (m, _, reply) => {
        if (!isAdmin(m)) return search(m, 'members', reply);
        return reply(clip(store.listMembers().map((x) => `#${x.id} ${x.name}`).join('\n')));
      },
    ],
    [
      /^remove member\s+#?(\d+)$/i,
      (m, x, reply) => {
        if (!isAdmin(m)) return reply('Only admins can remove members.');
        const target = store.memberById(Number(x[1]));
        if (!target) return reply('No such member.');
        store.deleteMember(target.id);
        return reply(`Removed ${target.name} and their books.`);
      },
    ],
  ];

  const isCommand = (text) => commands.some(([re]) => re.test(text));

  /**
   * Handles one incoming message.
   * @param {{phone: string, profileName?: string, text?: string, payload?: string, contextId?: string,
   *          image?: () => Promise<{buffer: Buffer, mediaType: string}>}} msg
   * @param {(text: string, buttons?: {id: string, title: string}[]) => Promise<unknown>} send
   */
  async function handle(msg, send) {
    const reply = async (text, buttons) => {
      await send(text, buttons);
      store.bumpUsage('service');
    };
    const text = (msg.payload ? payloadToCommand(msg.payload) : msg.text || '').trim();
    let member = store.memberByPhone(msg.phone);

    if (!member) {
      const join = /^join\b\s*(.*)$/is.exec(text);
      const code = join?.[1]?.trim() || '';
      if (settings.joinCode && code.toLowerCase() !== settings.joinCode.toLowerCase()) {
        return reply(
          `👋 Welcome to *${settings.communityName}*!\nTo join, reply: \`join <code>\`\n(Ask a neighbour for the code.)`,
        );
      }
      const name = cleanName(msg.profileName) || 'Neighbour';
      member = store.createMember({ name, phone: msg.phone });
      store.touchInbound(member.id);
      await reply(
        `🎉 Welcome, ${name}! Neighbours will see you as *${name}* (change it later with \`name …\`).\n` +
          'Two quick questions so they have a rough idea where you are:',
      );
      return setup(member, '', reply);
    }

    store.touchInbound(member.id);
    member = store.memberById(member.id);

    // Setup isn't finished until there's a building or locality.
    if (setupStep.has(member.id) || !placeOf(member)) return setup(member, text, reply);

    const delivered = await notifier.flush(member, { skipRequestId: payloadRequestId(msg.payload) });

    try {
      // Swipe-reply to a relayed chat message → send it to the other person.
      if (msg.contextId && text && !isCommand(text)) {
        const requestId = store.requestForOutbound(msg.contextId, member.id);
        if (requestId) {
          await library.sendMessage(member, requestId, text);
          return await reply('✉️ Sent.');
        }
      }

      if (msg.image) {
        await reply('📷 Got it! Looking for books in your photo…');
        let found;
        try {
          const { buffer, mediaType } = await msg.image();
          found = await identifyBooks(buffer, mediaType);
        } catch (err) {
          return await reply(`⚠️ ${err.message || 'Could not read that photo.'}`);
        }
        if (!found.length) return await reply("😕 I couldn't make out any book titles. Try a closer, well-lit photo.");
        return await addBooks(member, found, reply);
      }

      if (!text) return delivered ? undefined : await reply(helpText(settings.communityName));

      for (const [re, fn] of commands) {
        const match = re.exec(text);
        if (match) return await fn(member, match, reply, msg);
      }

      // Anything else is a search, unless they were just catching up on queued messages.
      if (delivered && !/^(find|search)\b/i.test(text)) return;
      const query = text.replace(/^(find|search|who has|whohas|anyone has|does anyone have)\b[:\s]*/i, '').replace(/[?？]+$/, '').trim();
      return await search(member, query || text, reply);
    } catch (err) {
      if (err instanceof LibraryError) return reply(`⚠️ ${err.message}`);
      throw err;
    }
  }

  return { handle };
}
