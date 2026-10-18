// Borrowing, lending and private messaging between members, done in the web app. WhatsApp only carries
// notifications, each with a button that opens the right page of the app.
// Nobody's phone number is ever revealed unless they explicitly choose to share it with one person.
import { matchesQuery, placeOf } from './db.js';

export class LibraryError extends Error {}

const CHAT_MAX = 1000;

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
    note = String(note || '').trim().slice(0, 200);
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
      text: `💬 *${member.name}* about _${r.book_title}_:\n${body}\n\nReply in the app.`,
      link: requestLink(r.id, 'Reply'),
      template: { name: 'request_update', params: [r.book_title, `${member.name} sent you a message`], url: String(r.id) },
    });
    return msg;
  }

  async function shareNumber(member, requestId) {
    const r = getRequest(requestId, member);
    if (r.status !== 'accepted') throw new LibraryError('You can share your number once a request is accepted.');
    const other = otherParty(r, member);
    const flag = r.owner_id === member.id ? 'owner_shared' : 'borrower_shared';
    if (!r[flag]) store.updateRequest(r.id, { [flag]: 1 });

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
      const book = result.added.find((b) => matchesQuery(b, wish.query));
      if (!book) continue;
      store.removeWish(wish.member_id, wish.id);
      await notifier.notify(wish.member_id, {
        text:
          `📚 Good news: *${book.title}* (you asked about "${wish.query}") was just added by *${who(member)}*.`,
        link: appLink(`/?q=${encodeURIComponent(book.title)}`, 'See the book'),
        template: { name: 'wishlist_alert', params: [book.title, who(member)], url: encodeURIComponent(book.title) },
      });
    }
    return result;
  }

  function addWish(member, query) {
    query = String(query || '').trim().slice(0, 100);
    if (!query) throw new LibraryError('Which book should we watch for?');
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
    otherParty,
    fmtDate,
  };
}
