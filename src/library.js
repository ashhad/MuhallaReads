// Borrowing, lending and private messaging between members, done in the web app. WhatsApp only carries
// notifications, each with a button that opens the right page of the app.
// Nobody's phone number is ever revealed unless they explicitly choose to share it with one person.
import crypto from 'node:crypto';
import { matchesQuery, placeOf, plainLine, queryWords } from './db.js';

export class LibraryError extends Error {}

/**
 * A member's own words relayed to someone else on WhatsApp: as a quote, without formatting, so they
 * can't pass for a message from the library itself.
 */
const quoted = (text) =>
  String(text)
    .replace(/[*_~`]/g, '')
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');

const CHAT_MAX = 1000;

/**
 * A short tag that, with the member number, names one specific person waiting to join. Member numbers
 * can be reused after someone is declined, so an old "approve 12" button must not approve the next #12.
 */
export const approvalTag = (m) => crypto.createHash('sha256').update(`${m.id}|${m.created_at}|${m.phone}`).digest('hex').slice(0, 4);

/** "Bilal (Sunrise Apartments, Saket)": name plus rough location, for messages to the other person. */
export const who = (m) => (placeOf(m) ? `${m.name} (${placeOf(m)})` : m.name);

export function createLibrary({ store, notifier, settings, clock = () => new Date() }) {
  const fmtDate = (iso) =>
    new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: settings.timeZone });

  /** A button that opens the web app at `path` (e.g. "/?request=7"). Omitted if the site address isn't set. */
  const appLink = (path, label) => (settings.publicUrl ? { url: settings.publicUrl + path, label } : undefined);
  const requestLink = (id, label = 'Open request') => appLink(`/?request=${id}`, label);

  function getRequest(id, member) {
    const r = store.requestById(Number(id));
    if (!r || (r.borrower_id !== member.id && r.owner_id !== member.id)) {
      throw new LibraryError(`No request #${id} found for you.`);
    }
    return r;
  }

  const otherParty = (r, member) =>
    r.owner_id === member.id
      ? { id: r.borrower_id, name: r.borrower_name }
      : { id: r.owner_id, name: r.owner_name };

  async function want(borrower, bookId, note = '') {
    const book = store.bookById(Number(bookId));
    if (!book) throw new LibraryError("That book isn't in the catalogue any more.");
    if (book.owner_id === borrower.id) throw new LibraryError('That one is your own copy 🙂');
    if (store.isBlocked(borrower.id, book.owner_id)) throw new LibraryError("You can't request this book.");
    if (book.status === 'lent') throw new LibraryError(`*${book.title}* is lent out right now. Try again later.`);
    if (store.openRequestFor(borrower.id, book.id)) {
      throw new LibraryError(`You've already asked for *${book.title}*. See the Requests tab.`);
    }
    if (store.countPending(borrower.id) >= settings.maxPendingRequests) {
      throw new LibraryError(
        `You have ${settings.maxPendingRequests} requests waiting for an answer. Cancel one before asking for more.`,
      );
    }
    note = plainLine(note, 200); // one plain line, shown in quotes
    const id = store.createRequest({ bookId: book.id, borrowerId: borrower.id, ownerId: book.owner_id, note });

    await notifier.notify(book.owner_id, {
      requestId: id,
      text:
        `📚 *${who(borrower)}* would like to borrow *${book.title}*.` +
        (note ? `\n💬 "${note}"` : '') +
        '\n\nOpen the app to accept or decline.',
      link: requestLink(id),
      template: { name: 'book_request', params: [who(borrower), book.title, note || '-'], url: String(id) },
    });
    return store.requestById(id);
  }

  async function decide(owner, requestId, accept) {
    const r = getRequest(requestId, owner);
    if (r.owner_id !== owner.id) throw new LibraryError(`Only ${r.owner_name} can answer request #${r.id}.`);
    if (r.status !== 'pending') throw new LibraryError(`Request #${r.id} is already ${r.status}.`);

    if (!accept) {
      store.updateRequest(r.id, { status: 'declined', decided_at: clock().toISOString() });
      await notifier.notify(r.borrower_id, {
        requestId: r.id,
        text: `🙁 *${owner.name}* can't lend *${r.book_title}* right now.`,
        link: requestLink(r.id),
        template: { name: 'request_update', params: [r.book_title, `${owner.name} can't lend it right now`], url: String(r.id) },
      });
      return store.requestById(r.id);
    }

    const book = store.bookById(r.book_id);
    if (book.status === 'lent') {
      throw new LibraryError(`*${r.book_title}* is marked as lent. Mark it returned first, or decline this request.`);
    }
    const due = new Date(clock().getTime() + settings.loanDays * 86400_000).toISOString();
    store.updateRequest(r.id, { status: 'accepted', decided_at: clock().toISOString(), due_at: due });
    store.setBookStatus(r.book_id, 'lent');

    await notifier.notify(r.borrower_id, {
      requestId: r.id,
      text:
        `✅ *${owner.name}* agreed to lend you *${r.book_title}*!\n\n` +
        'Arrange the pickup in the app’s chat. Your numbers stay private unless one of you chooses to share. ' +
        `Please return it by ${fmtDate(due)}.`,
      link: requestLink(r.id, 'Open chat'),
      template: { name: 'request_update', params: [r.book_title, `${owner.name} agreed to lend it`], url: String(r.id) },
    });
    return store.requestById(r.id);
  }

  function cancel(borrower, requestId) {
    const r = getRequest(requestId, borrower);
    if (r.borrower_id !== borrower.id) throw new LibraryError('Only the person who asked can cancel a request.');
    if (r.status !== 'pending') throw new LibraryError(`Request #${r.id} is already ${r.status}.`);
    return store.updateRequest(r.id, { status: 'cancelled', closed_at: clock().toISOString() });
  }

  async function markReturned(owner, requestId) {
    const r = getRequest(requestId, owner);
    if (r.owner_id !== owner.id) {
      throw new LibraryError(`Only ${r.owner_name} can mark it returned. Hand it back and let them know!`);
    }
    if (r.status !== 'accepted') throw new LibraryError(`Request #${r.id} isn't an active loan.`);
    store.updateRequest(r.id, { status: 'returned', closed_at: clock().toISOString() });
    store.setBookStatus(r.book_id, 'available');
    await notifier.notify(r.borrower_id, {
      requestId: r.id,
      text: `📗 ${owner.name} got *${r.book_title}* back. Thanks for returning it!`,
      optional: true, // a nice-to-have; never worth a paid message
    });
    return store.requestById(r.id);
  }

  /** Manual "lent"/"available" toggle. Making a book available again closes its active loan, if any. */
  async function setAvailability(owner, bookId, status) {
    const loan = status === 'available' && store.activeLoanForBook(Number(bookId));
    const book = store.bookById(Number(bookId));
    if (loan && book?.owner_id === owner.id) await markReturned(owner, loan.id);
    return store.setStatus(owner.id, Number(bookId), status);
  }

  async function sendMessage(member, requestId, body) {
    const r = getRequest(requestId, member);
    if (r.status !== 'accepted') {
      throw new LibraryError(
        r.status === 'pending'
          ? 'You can message each other once the request is accepted.'
          : `Request #${r.id} is ${r.status}; messaging is closed.`,
      );
    }
    const other = otherParty(r, member);
    if (store.isBlocked(member.id, other.id)) throw new LibraryError("You can't message this person.");
    body = String(body || '').trim().slice(0, CHAT_MAX);
    if (!body) throw new LibraryError('Message is empty.');
    const msg = store.addMessage(r.id, member.id, body);

    await notifier.notify(other.id, {
      requestId: r.id,
      text: `💬 *${member.name}* about _${r.book_title}_:\n${quoted(body)}\n\nReply in the app.`,
      link: requestLink(r.id, 'Reply'),
      template: { name: 'request_update', params: [r.book_title, `${member.name} sent you a message`], url: String(r.id) },
    });
    return msg;
  }

  async function shareNumber(member, requestId) {
    const r = getRequest(requestId, member);
    if (r.status !== 'accepted') throw new LibraryError('You can share your number once a request is accepted.');
    const other = otherParty(r, member);
    if (store.isBlocked(member.id, other.id)) throw new LibraryError("You can't share your number with this person.");
    const flag = r.owner_id === member.id ? 'owner_shared' : 'borrower_shared';
    if (r[flag]) return other; // already shared: don't send it again
    store.updateRequest(r.id, { [flag]: 1 });

    await notifier.notify(other.id, {
      requestId: r.id,
      text:
        `📞 *${member.name}* shared their number with you for *${r.book_title}*:\n` +
        `+${member.phone}\nhttps://wa.me/${member.phone}`,
      link: requestLink(r.id),
      template: {
        name: 'request_update',
        params: [r.book_title, `${member.name} shared their contact number`],
        url: String(r.id),
      },
    });
    return other;
  }

  function block(member, requestId) {
    const r = getRequest(requestId, member);
    const other = otherParty(r, member);
    store.block(member.id, other.id);
    if (r.status === 'pending') {
      store.updateRequest(r.id, {
        status: r.owner_id === member.id ? 'declined' : 'cancelled',
        closed_at: clock().toISOString(),
      });
    }
    return other;
  }

  /** Adds books, then tells anyone who was waiting for one of them (once per wish). */
  async function addBooks(member, books) {
    const result = store.addBooks(member.id, books);
    if (!result.added.length) return result;

    for (const wish of store.allWishes()) {
      if (wish.member_id === member.id || store.isBlocked(wish.member_id, member.id)) continue;
      const words = queryWords(wish.query);
      const book = result.added.find((b) => matchesQuery(b, words));
      if (!book) continue;
      store.removeWish(wish.member_id, wish.id);
      await notifier.notify(wish.member_id, {
        text:
          `📚 Good news: *${book.title}* (you asked about "${wish.query}") was just added by *${who(member)}*.`,
        link: appLink(`/?q=${encodeURIComponent(book.title)}`, 'See the book'),
        template: { name: 'wishlist_alert', params: [book.title, who(member)], url: encodeURIComponent(book.title) },
      });
    }
    if (member.status === 'active') queueNews(member, result.added);
    return result;
  }

  // ---------- new-book alerts ----------
  // Books one member adds within a few minutes go out as one message ("Dune and 17 other books, added
  // by Aditi"). They're only sent where it's free (the member messaged the bot in the last 24 hours),
  // at most once every 6 hours each; anyone else gets one "while you were away" summary the next time
  // they message the bot. Members can turn them off.

  const NEWS_GAP_MS = 6 * 3600_000;
  const news = new Map(); // owner id -> { ids: book ids, timer }

  function queueNews(owner, books) {
    const entry = news.get(owner.id) || { ids: [] };
    entry.ids.push(...books.map((b) => b.id));
    clearTimeout(entry.timer);
    entry.timer = setTimeout(
      () => sendNews(owner.id).catch((err) => console.error('New-book alert failed:', err)),
      settings.newsDelayMs ?? 10 * 60_000,
    );
    entry.timer.unref?.();
    news.set(owner.id, entry);
  }

  const listTitles = (titles, total) =>
    total === 1 ? titles[0] : total === 2 ? `${titles[0]} and ${titles[1]}` : `${titles.slice(0, 2).join(', ')} and ${total - 2} more`;

  async function sendNews(ownerId) {
    const entry = news.get(ownerId);
    if (!entry) return 0;
    clearTimeout(entry.timer);
    news.delete(ownerId);
    const owner = store.memberById(ownerId);
    const books = entry.ids.map((id) => store.bookById(id)).filter(Boolean); // some may have been removed since
    if (!owner || owner.status !== 'active' || !books.length) return 0;

    const others = books.length - 1;
    const text =
      `📚 New in the library: *${books[0].title}*${others ? ` and ${others} other book${others > 1 ? 's' : ''}` : ''}, ` +
      `added by ${who(owner)}.\n\nReply *alerts off* to stop these.`;
    const link =
      books.length === 1 ? appLink(`/?q=${encodeURIComponent(books[0].title)}`, 'See the book') : appLink('/', 'See new books');
    const at = clock();
    let sent = 0;
    for (const m of store.membersForBookAlerts(ownerId)) {
      if (store.isBlocked(m.id, ownerId) || store.isBlocked(ownerId, m.id)) continue;
      if (m.book_alert_at && at - new Date(m.book_alert_at) < NEWS_GAP_MS) continue;
      if ((await notifier.notify(m.id, { text, link, optional: true })) === 'sent') {
        store.markBooksSeen(m.id, { alertedAt: at.toISOString() });
        sent++;
      }
    }
    return sent;
  }

  /** Sends any batched alerts now (tests, and shutdown). */
  async function flushNews() {
    let sent = 0;
    for (const id of [...news.keys()]) sent += await sendNews(id);
    return sent;
  }

  /** When a member messages the bot: one summary of books added since they last looked. */
  async function newsSummary(member, reply) {
    if (member.status !== 'active' || !member.book_alerts) return false;
    const at = clock();
    if (member.books_seen_id == null) {
      store.markBooksSeen(member.id);
      return false;
    }
    if (member.book_alert_at && at - new Date(member.book_alert_at) < NEWS_GAP_MS) return false;
    const books = store
      .booksAddedSince(member.books_seen_id, member.id)
      .filter((b) => !store.isBlocked(member.id, b.owner_id) && !store.isBlocked(b.owner_id, member.id));
    if (!books.length) return false;
    store.markBooksSeen(member.id, { alertedAt: at.toISOString() });
    const titles = books.slice(0, 2).map((b) => `*${b.title}*`);
    await reply(
      `📚 While you were away, neighbours added ${books.length} book${books.length > 1 ? 's' : ''}: ${listTitles(titles, books.length)}.`,
      { link: appLink('/', 'See new books') },
    );
    return true;
  }

  // ---------- joining: admins approve everyone ----------

  const admins = () =>
    (settings.adminPhones || []).map((p) => store.memberByPhone(p)).filter((m) => m && m.status === 'active');

  /**
   * Asks the admins (once) to approve a member who has finished setup. If no admin has joined yet,
   * there's nobody to ask, so the member is let straight in.
   * @returns {Promise<'asked'|'approved'>}
   */
  async function askApproval(member) {
    member = store.memberById(member.id);
    if (member.status !== 'pending') return 'approved';
    if (member.approval_asked_at) return 'asked';
    const list = admins();
    if (!settings.adminPhones?.length) {
      // No admins configured at all: the library is open, as the operator chose.
      store.setMemberStatus(member.id, 'active');
      return 'approved';
    }
    if (!list.length) {
      // Admins are configured but none has an active account (not joined yet, or left): never let
      // people in unchecked. They wait, and appear on the admin's list once an admin joins.
      console.warn('A new member is waiting, but no admin account is active (has an admin joined?).');
      return 'asked';
    }
    store.markApprovalAsked(member.id);
    const referrer = member.referred_by && store.memberById(member.referred_by);
    const how = referrer ? `invited by *${who(referrer)}*` : 'using the join code';
    const ref = `${member.id}-${approvalTag(member)}`;
    for (const admin of list) {
      await notifier.notify(admin.id, {
        text:
          `🆕 *${who(member)}* wants to join, ${how}.\n` +
          `Reply *approve ${ref}* or *decline ${ref}*, or use the Me tab in the app.`,
        buttons: [
          { id: `approve:${ref}`, title: 'Approve' },
          { id: `decline:${ref}`, title: 'Decline' },
        ],
      });
    }
    return 'asked';
  }

  /** The member waiting as #id, if `tag` (when given) matches them: an old button or list can't pick someone else. */
  function waiting(id, tag) {
    const m = store.memberById(Number(id));
    if (!m || (tag && tag.toLowerCase() !== approvalTag(m))) {
      throw new LibraryError("That request is out of date (they may have been declined already). Send *pending* to see who's waiting.");
    }
    return m;
  }

  async function approveMember(id, tag) {
    const m = waiting(id, tag);
    if (m.status === 'active') return { member: m, already: true };
    if (m.status !== 'pending') throw new LibraryError(`${m.name} is no longer waiting to join.`);
    const me = store.setMemberStatus(m.id, 'active');
    await notifier.notify(me.id, {
      text:
        `🎉 You're in, ${me.name}! Welcome to ${settings.communityName}.\n` +
        'You can now see who has each book, add yours and borrow. Send *login* any time for a sign-in button.',
      link: appLink('/', 'Open MohallaReads'),
    });
    const referrer = me.referred_by && store.memberById(me.referred_by);
    if (referrer) {
      await notifier.notify(referrer.id, { text: `👋 ${who(me)}, whom you invited, has joined ${settings.communityName}.`, optional: true });
    }
    return { member: me };
  }

  async function declineMember(id, tag) {
    const m = waiting(id, tag);
    if (m.status !== 'pending') throw new LibraryError(`${m.name} is already a member. To remove them, send *remove member ${m.id}*.`);
    store.setMemberStatus(m.id, 'declined'); // first, so an approval arriving meanwhile can't let them in
    await notifier.notify(m.id, {
      text: "Sorry, your request to join wasn't approved. If you think this is a mistake, talk to the neighbour who invited you.",
      optional: true,
    });
    store.deleteMember(m.id);
    return m;
  }

  const MAX_WISHES = 20;

  function addWish(member, query) {
    query = String(query || '').trim().slice(0, 100);
    if (!query) throw new LibraryError('Which book should we watch for?');
    if (store.wishesOf(member.id).length >= MAX_WISHES) {
      throw new LibraryError(`You're already waiting for ${MAX_WISHES} books. Remove one on the Me tab first.`);
    }
    return store.addWish(member.id, query);
  }

  /** Sends due-soon and overdue reminders. Run periodically. */
  async function runReminders(at = clock()) {
    const loans = store.loansNeedingReminder(at, 2 * 86400_000, 3 * 86400_000);
    for (const r of loans) {
      const overdue = new Date(r.due_at) < at;
      store.updateRequest(r.id, { reminders: r.reminders + 1 });
      await notifier.notify(r.borrower_id, {
        requestId: r.id,
        text: overdue
          ? `⏰ *${r.book_title}* from ${r.owner_name} was due back on ${fmtDate(r.due_at)}. Please return it soon, or message them in the app.`
          : `⏰ Reminder: *${r.book_title}* from ${r.owner_name} is due back on ${fmtDate(r.due_at)}.`,
        link: requestLink(r.id),
        template: { name: 'return_reminder', params: [r.book_title, r.owner_name, fmtDate(r.due_at)], url: String(r.id) },
      });
    }
    return loans.length;
  }

  function deleteAccount(member) {
    store.deleteMember(member.id);
  }

  return {
    want,
    decide,
    cancel,
    markReturned,
    setAvailability,
    sendMessage,
    shareNumber,
    block,
    addBooks,
    addWish,
    runReminders,
    deleteAccount,
    getRequest,
    flushNews,
    newsSummary,
    askApproval,
    approveMember,
    declineMember,
    otherParty,
    fmtDate,
  };
}
