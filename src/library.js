// Borrowing, lending and private messaging between members, done in the web app. WhatsApp only carries
// notifications, each with a button that opens the right page of the app.
// Nobody's phone number is ever revealed unless they explicitly choose to share it with one person.
import crypto from 'node:crypto';
import { matchesQuery, placeOf, plainLine, queryWords } from './db.js';
import { agreedToTerms } from './terms.js';
import { BADGE_RULES, BADGES, badgeLine } from './badges.js';

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
const DAY = 86400_000;
// Overdue books: the borrower is reminded weekly; at this point admins (and whoever invited the
// borrower) are told too.
const ESCALATE_AFTER_DAYS = 14;
// An accepted loan's clock starts when the book changes hands; if nobody confirms that, after this many days.
const PICKUP_DAYS = 3;
const HOUR = 3600_000;
// Library-style rules: one more week per renewal (the owner agrees; MAX_RENEWALS caps it), a book can be
// marked lost this long after its due date, and a returned book is kept for the first person waiting.
const RENEWAL_DAYS = 7;
const LOST_AFTER_DAYS = 30;
const KEEP_HOURS = 48;
const MAX_QUEUES = 5;

/** "*Dune* from Ayesha and *Ikigai* from Bilal" */
export function listLoans(loans) {
  const named = loans.slice(0, 3).map((r) => `*${r.book_title}* from ${r.owner_name}`);
  if (loans.length > 3) named.push(`${loans.length - 3} more`);
  return named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
}

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
  const fmtWhen = (ms) =>
    new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: settings.timeZone });
  const maxRenewals = () => settings.maxRenewals ?? 2;
  const waitingLine = (n) => (n ? ` ${n} ${n > 1 ? 'people are' : 'person is'} waiting for it.` : '');

  function getRequest(id, member) {
    const r = store.requestById(Number(id));
    if (!r || (r.borrower_id !== member.id && r.owner_id !== member.id)) {
      throw new LibraryError(`No request #${id} found for you.`);
    }
    return r;
  }

  /** Most books one member may have borrowed at a time. */
  const maxBorrowed = () => settings.maxBorrowed ?? 2;

  /** The badges a member has earned (keys of BADGES), most special first. */
  function badgesFor(memberOrId) {
    const m = typeof memberOrId === 'object' ? memberOrId : store.memberById(memberOrId);
    if (!m || m.status !== 'active') return [];
    const at = clock();
    const r = store.memberRecord(m.id, at.toISOString());
    const days = (at - new Date(m.created_at)) / DAY;
    const earned = {
      neverOverdue: r.returned >= BADGE_RULES.onTimeReturns && r.onTime === r.returned && !r.overdue && !r.lost,
      bestseller: r.lent >= BADGE_RULES.lends,
      fresh: days < BADGE_RULES.freshDays,
    };
    earned.classic = earned.neverOverdue && earned.bestseller && days >= BADGE_RULES.classicDays;
    return Object.keys(BADGES).filter((k) => earned[k]);
  }

  /**
   * What a lender sees about someone asking to borrow: "Returned 4 of 4 on time · has 1 book now ·
   * invited by Ayesha · 📗 Never overdue". Facts only, so it stays friendly.
   */
  function borrowerRecord(memberId) {
    const r = store.memberRecord(memberId, clock().toISOString());
    const m = store.memberById(memberId);
    const inviter = m?.referred_by ? store.memberById(m.referred_by) : null;
    const parts = [];
    if (!r.returned && !r.borrowing) parts.push('first time borrowing');
    if (r.returned) parts.push(`returned ${r.onTime} of ${r.returned} on time`);
    if (r.borrowing) {
      parts.push(`has ${r.borrowing} book${r.borrowing > 1 ? 's' : ''} now${r.overdue ? ` (${r.overdue} overdue)` : ''}`);
    }
    if (r.lost) parts.push(`${r.lost} marked lost`);
    if (inviter) parts.push(`invited by ${inviter.name}`);
    const badges = badgesFor(m);
    if (badges.length) parts.push(badgeLine(badges));
    const text = parts.join(' · ');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /** What any member may see about another: name, place, badges and counts. Never a phone number. */
  function profileOf(viewer, targetId) {
    const target = store.memberById(Number(targetId));
    if (!target || target.status !== 'active' || store.isBlocked(target.id, viewer.id)) {
      throw new LibraryError('No such member.');
    }
    const r = store.memberRecord(target.id, clock().toISOString());
    const inviter = target.referred_by ? store.memberById(target.referred_by) : null;
    return {
      id: target.id,
      name: target.name,
      place: placeOf(target),
      badges: badgesFor(target),
      since: target.created_at,
      invitedBy: inviter?.name || null,
      books: r.books,
      lent: r.lent,
      returned: r.returned,
      isMe: target.id === viewer.id,
    };
  }

  const otherParty = (r, member) =>
    r.owner_id === member.id
      ? { id: r.borrower_id, name: r.borrower_name }
      : { id: r.owner_id, name: r.owner_name };

  async function want(borrower, bookId, note = '') {
    const book = store.bookById(Number(bookId));
    if (!book) throw new LibraryError("That book isn't in the catalogue any more.");
    if (book.owner_id === borrower.id) throw new LibraryError('That one is your own copy 🙂');
    if (!agreedToTerms(borrower)) throw new LibraryError('Please agree to the Terms first.');
    if (store.isBlocked(borrower.id, book.owner_id)) throw new LibraryError("You can't request this book.");
    if (book.never_overdue_only && !badgesFor(borrower).includes('neverOverdue')) {
      throw new LibraryError(
        `${store.memberById(book.owner_id)?.name || 'The owner'} lends *${book.title}* only to 📗 Never overdue readers: ` +
          `people who've returned ${BADGE_RULES.onTimeReturns} or more books, all on time.`,
      );
    }
    const block = borrowingBlock(borrower);
    if (block) throw new LibraryError(block);
    if (book.status === 'lent' || book.lost_at) {
      throw new LibraryError(`*${book.title}* is lent out right now. Join the queue to be told when it's back.`);
    }
    // A book that's back is kept for the first person in the queue for a while.
    const [first] = store.holdsFor(book.id);
    if (first && first.member_id !== borrower.id) {
      const until = first.offered_at ? Date.parse(first.offered_at) + KEEP_HOURS * HOUR : null;
      if (!until || clock().getTime() < until) {
        throw new LibraryError(
          `*${book.title}* is being kept for the next person in the queue${until ? ` until ${fmtWhen(until)}` : ''}. Join the queue to be next.`,
        );
      }
    }
    if (store.openRequestFor(borrower.id, book.id)) {
      throw new LibraryError(`You've already asked for *${book.title}*. See the Requests tab.`);
    }
    if (store.countPending(borrower.id) >= settings.maxPendingRequests) {
      throw new LibraryError(
        `You have ${settings.maxPendingRequests} requests waiting for an answer. Cancel one before asking for more.`,
      );
    }
    if (store.countBorrowed(borrower.id) >= maxBorrowed()) {
      throw new LibraryError(
        `You're already borrowing ${maxBorrowed()} books, the most anyone can have at once. Return one, then ask for this.`,
      );
    }
    note = plainLine(note, 200); // one plain line, shown in quotes
    const id = store.createRequest({ bookId: book.id, borrowerId: borrower.id, ownerId: book.owner_id, note });
    store.removeHold(book.id, borrower.id); // their turn in the queue is used

    await notifier.notify(book.owner_id, {
      requestId: id,
      text:
        `📚 *${who(borrower)}* would like to borrow *${book.title}*.` +
        (note ? `\n💬 "${note}"` : '') +
        `\n📋 ${borrowerRecord(borrower.id)}` +
        '\n\nOpen the app to accept or decline.',
      link: requestLink(id),
      template: { name: 'book_request', params: [who(borrower), book.title, note || '-'], url: String(id) },
    });
    return store.requestById(id);
  }

  /**
   * Accepts or declines a request. Accepting needs `understood`: the owner confirmed they lend at their
   * own risk (the app asks every time; see terms.html).
   */
  async function decide(owner, requestId, accept, { understood = false } = {}) {
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
      await offerToQueue(r.book_id);
      return store.requestById(r.id);
    }

    const book = store.bookById(r.book_id);
    if (book.status === 'lent') {
      throw new LibraryError(`*${r.book_title}* is marked as lent. Mark it returned first, or decline this request.`);
    }
    if (store.countBorrowed(r.borrower_id) >= maxBorrowed()) {
      throw new LibraryError(
        `${r.borrower_name} already has ${maxBorrowed()} borrowed books, the most anyone can have at once. ` +
          'You can accept once they’ve returned one.',
      );
    }
    // A loan only starts between two members who have both agreed to the current Terms (a request sent
    // before they existed, or before they changed, waits until the borrower agrees).
    if (!agreedToTerms(owner)) throw new LibraryError('Please agree to the Terms first.');
    const borrower = store.memberById(r.borrower_id);
    if (!agreedToTerms(borrower)) {
      await notifier.notify(borrower.id, {
        requestId: r.id,
        text: `📚 ${owner.name} would like to lend you *${r.book_title}*. Please open the app and agree to the Terms first.`,
        link: requestLink(r.id),
        optional: true,
      });
      throw new LibraryError(
        `${r.borrower_name} hasn't agreed to the Terms yet, so this can't go ahead. They've been asked to; try again once they have.`,
      );
    }
    if (book.never_overdue_only && !badgesFor(borrower).includes('neverOverdue')) {
      throw new LibraryError(`*${r.book_title}* is for 📗 Never overdue readers only, and ${r.borrower_name} isn't one yet.`);
    }
    if (borrowingBlock(borrower)) {
      throw new LibraryError(`${r.borrower_name} has a book that's overdue or not settled, so this can't go ahead until that's sorted.`);
    }
    if (!understood) throw new LibraryError('Please confirm that you’re lending at your own risk.');
    // The loan period starts at the hand-over (handOver); until then this allows a few days for pickup.
    const due = new Date(clock().getTime() + (settings.loanDays + PICKUP_DAYS) * DAY).toISOString();
    const at = clock().toISOString();
    store.updateRequest(r.id, { status: 'accepted', decided_at: at, due_at: due, owner_risk_at: at });
    store.setBookStatus(r.book_id, 'lent');
    // Lent to someone else while it was kept for the first in the queue: they keep their place for next time.
    const [first] = store.holdsFor(r.book_id);
    if (first?.offered_at && first.member_id !== r.borrower_id) store.updateHold(first.id, { offered_at: null });

    await notifier.notify(r.borrower_id, {
      requestId: r.id,
      text:
        `✅ *${owner.name}* agreed to lend you *${r.book_title}*!\n\n` +
        'Arrange the pickup in the app’s chat. When you have the book, tap *Got the book* in the app: your ' +
        `${settings.loanDays} days start then. Your numbers stay private unless one of you chooses to share.`,
      link: requestLink(r.id, 'Open chat'),
      template: { name: 'request_update', params: [r.book_title, `${owner.name} agreed to lend it`], url: String(r.id) },
    });
    return store.requestById(r.id);
  }

  /**
   * The borrower cancels a request; or, before the book has changed hands, either of them calls the
   * loan off. A loan that never started doesn't count in anyone's record.
   */
  async function cancel(member, requestId) {
    const r = getRequest(requestId, member);
    if (r.status === 'accepted' && !r.handed_over_at) {
      store.updateRequest(r.id, { status: 'cancelled', closed_at: clock().toISOString() });
      store.setBookStatus(r.book_id, 'available');
      const other = otherParty(r, member);
      await notifier.notify(other.id, {
        requestId: r.id,
        text: `${member.name} called off the loan of *${r.book_title}* before it changed hands.`,
        optional: true,
      });
      await offerToQueue(r.book_id);
      return store.requestById(r.id);
    }
    if (r.borrower_id !== member.id) throw new LibraryError('Only the person who asked can cancel a request.');
    if (r.status !== 'pending') throw new LibraryError(`Request #${r.id} is already ${r.status}.`);
    store.updateRequest(r.id, { status: 'cancelled', closed_at: clock().toISOString() });
    await offerToQueue(r.book_id);
    return store.requestById(r.id);
  }

  /** Either of them confirms the book has changed hands: the loan period starts now. */
  async function handOver(member, requestId) {
    const r = getRequest(requestId, member);
    if (r.status !== 'accepted') throw new LibraryError(`Request #${r.id} isn't an active loan.`);
    if (r.handed_over_at) return r;
    const at = clock();
    const due = new Date(at.getTime() + settings.loanDays * DAY).toISOString();
    store.updateRequest(r.id, { handed_over_at: at.toISOString(), due_at: due, reminders: 0, owner_late_at: null, escalated_at: null });
    const other = otherParty(r, member);
    await notifier.notify(other.id, {
      requestId: r.id,
      text:
        r.owner_id === member.id
          ? `📦 ${member.name} handed you *${r.book_title}*. Please return it by ${fmtDate(due)}.`
          : `📦 ${member.name} has *${r.book_title}* now. It's due back on ${fmtDate(due)}.`,
      optional: true,
    });
    return store.requestById(r.id);
  }

  async function markReturned(owner, requestId) {
    const r = getRequest(requestId, owner);
    if (r.owner_id !== owner.id) {
      throw new LibraryError(`Only ${r.owner_name} can mark it returned. Hand it back and let them know!`);
    }
    if (!['accepted', 'lost'].includes(r.status)) throw new LibraryError(`Request #${r.id} isn't an active loan.`);
    if (r.status === 'accepted' && !r.handed_over_at) return cancel(owner, r.id); // it never left: calling it off
    // A book marked lost that turns up after all counts as a (late) return.
    store.updateRequest(r.id, { status: 'returned', closed_at: clock().toISOString(), renewal_asked_at: null });
    store.setBookStatus(r.book_id, 'available');
    store.setBookLost(r.book_id, null);
    await notifier.notify(r.borrower_id, {
      requestId: r.id,
      text: `📗 ${owner.name} got *${r.book_title}* back. Thanks for returning it!`,
      optional: true, // a nice-to-have; never worth a paid message
    });
    await offerToQueue(r.book_id);
    return store.requestById(r.id);
  }

  // ---------- library-style rules: no borrowing while overdue, renewals, the queue, lost books ----------

  /** Why this member can't borrow right now (a book overdue, or one marked lost and not settled), or null. */
  function borrowingBlock(member) {
    const now = clock().toISOString();
    const late = store.borrowedBy(member.id).find((r) => r.due_at && r.due_at < now);
    if (late) return `Please return *${late.book_title}* to ${late.owner_name} first: it was due on ${fmtDate(late.due_at)}.`;
    const [lost] = store.unsettledLostBy(member.id);
    if (lost) {
      return `Please settle *${lost.book_title}* with ${lost.owner_name} first (it was marked lost): replace it, or agree a price with them.`;
    }
    return null;
  }

  /** When a loan may get one more week: after the hand-over, under the cap, and nobody waiting. */
  const renewedDue = (r) => new Date(Math.max(Date.parse(r.due_at), clock().getTime()) + RENEWAL_DAYS * DAY).toISOString();

  async function askRenewal(borrower, requestId) {
    const r = getRequest(requestId, borrower);
    if (r.borrower_id !== borrower.id) throw new LibraryError('Only the borrower can ask for more time.');
    if (r.status !== 'accepted' || !r.handed_over_at) throw new LibraryError('You can ask for more time once you have the book.');
    if (r.renewal_asked_at) throw new LibraryError(`You've already asked ${r.owner_name}. They'll answer in the app.`);
    if (r.renewals >= maxRenewals()) {
      throw new LibraryError(
        `*${r.book_title}* has already had ${maxRenewals()} extra week${maxRenewals() > 1 ? 's' : ''}, the most allowed. Please return it by ${fmtDate(r.due_at)}.`,
      );
    }
    const waiting = store.holdsFor(r.book_id).length;
    if (waiting) throw new LibraryError(`${waiting} ${waiting > 1 ? 'people are' : 'person is'} waiting for *${r.book_title}*, so it can't be extended.`);
    store.updateRequest(r.id, { renewal_asked_at: clock().toISOString() });
    await notifier.notify(r.owner_id, {
      requestId: r.id,
      text: `📅 ${r.borrower_name} asks to keep *${r.book_title}* one more week, until ${fmtDate(renewedDue(r))}. Answer in the app.`,
      link: requestLink(r.id),
      template: { name: 'request_update', params: [r.book_title, `${r.borrower_name} asks to keep it one more week`], url: String(r.id) },
    });
    return store.requestById(r.id);
  }

  async function answerRenewal(owner, requestId, yes) {
    const r = getRequest(requestId, owner);
    if (r.owner_id !== owner.id) throw new LibraryError(`Only ${r.owner_name} can answer this.`);
    if (r.status !== 'accepted' || !r.renewal_asked_at) throw new LibraryError('There’s no request for more time to answer.');
    if (yes) {
      const due = renewedDue(r);
      store.updateRequest(r.id, { due_at: due, renewals: r.renewals + 1, renewal_asked_at: null, reminders: 0, owner_late_at: null, escalated_at: null });
      await notifier.notify(r.borrower_id, { requestId: r.id, text: `📅 ${owner.name} said yes: keep *${r.book_title}* until ${fmtDate(due)}.`, link: requestLink(r.id) });
    } else {
      store.updateRequest(r.id, { renewal_asked_at: null });
      await notifier.notify(r.borrower_id, { requestId: r.id, text: `${owner.name} needs *${r.book_title}* back by ${fmtDate(r.due_at)}.`, link: requestLink(r.id) });
    }
    return store.requestById(r.id);
  }

  /** Joins the queue for a book that's lent out (or kept for someone else). */
  async function joinQueue(member, bookId) {
    const book = store.bookById(Number(bookId));
    if (!book || book.lost_at) throw new LibraryError("That book isn't in the catalogue any more.");
    if (book.owner_id === member.id) throw new LibraryError('That one is your own copy 🙂');
    if (!agreedToTerms(member)) throw new LibraryError('Please agree to the Terms first.');
    if (store.isBlocked(member.id, book.owner_id) || store.isBlocked(book.owner_id, member.id)) throw new LibraryError("You can't request this book.");
    if (book.never_overdue_only && !badgesFor(member).includes('neverOverdue')) {
      throw new LibraryError(`*${book.title}* is lent only to 📗 Never overdue readers.`);
    }
    const block = borrowingBlock(member);
    if (block) throw new LibraryError(block);
    if (store.openRequestFor(member.id, book.id)) throw new LibraryError(`You've already asked for *${book.title}*.`);
    const holds = store.holdsFor(book.id);
    if (!holds.some((h) => h.member_id === member.id)) {
      if (book.status === 'available' && !holds.length) throw new LibraryError(`*${book.title}* is available now: just tap Request.`);
      if (store.countHolds(member.id) >= MAX_QUEUES) {
        throw new LibraryError(`You're already waiting for ${MAX_QUEUES} books. Leave a queue before joining another.`);
      }
      store.addHold(book.id, member.id);
    }
    return queueView(book.id, member);
  }

  async function leaveQueue(member, bookId) {
    store.removeHold(Number(bookId), member.id);
    await offerToQueue(Number(bookId)); // if it was being kept for them, the next person's turn
    return queueView(Number(bookId), member);
  }

  /** How many are waiting for a book, and this member's place (1 = next). */
  function queueView(bookId, member) {
    const holds = store.holdsFor(bookId);
    const place = holds.findIndex((h) => h.member_id === member.id) + 1;
    return { waiting: holds.length, place: place || null, keptForMe: place === 1 && Boolean(holds[0].offered_at) };
  }

  /** A book that's available again goes to the first person waiting: told, and kept for them a while. */
  async function offerToQueue(bookId) {
    const book = store.bookById(bookId);
    if (!book || book.status !== 'available' || book.lost_at) return false;
    const [first] = store.holdsFor(bookId);
    if (!first || first.offered_at) return false;
    const at = clock();
    store.updateHold(first.id, { offered_at: at.toISOString() });
    const owner = store.memberById(book.owner_id);
    await notifier.notify(first.member_id, {
      text:
        `📗 *${book.title}* is back with ${who(owner)}, and you're first in the queue. It's kept for you until ` +
        `${fmtWhen(at.getTime() + KEEP_HOURS * HOUR)}: open the app and tap *Request*.`,
      link: appLink(`/?q=${encodeURIComponent(book.title)}`, 'Ask for it'),
      template: { name: 'wishlist_alert', params: [book.title, who(owner)], url: encodeURIComponent(book.title) },
    });
    return true;
  }

  /** Moves queues along: a turn that wasn't taken in time passes to the next person. Run periodically. */
  async function runQueues(at = clock()) {
    for (const bookId of store.booksWithHolds()) {
      const [first] = store.holdsFor(bookId);
      if (first?.offered_at && at.getTime() - Date.parse(first.offered_at) >= KEEP_HOURS * HOUR) {
        store.removeHold(bookId, first.member_id);
        await notifier.notify(first.member_id, {
          text: `Your turn for *${store.bookById(bookId)?.title}* has passed, so it's gone to the next person waiting. You can join the queue again.`,
          optional: true,
        });
      }
      await offerToQueue(bookId);
    }
  }

  /** Thirty days after the due date, the owner may mark a book lost: the loan closes, the borrower settles up. */
  async function markLost(owner, requestId) {
    const r = getRequest(requestId, owner);
    if (r.owner_id !== owner.id) throw new LibraryError(`Only ${r.owner_name} can do this.`);
    if (r.status !== 'accepted') throw new LibraryError(`Request #${r.id} isn't an active loan.`);
    const from = Date.parse(r.due_at) + LOST_AFTER_DAYS * DAY;
    if (clock().getTime() < from) throw new LibraryError(`You can mark it lost from ${fmtDate(from)}, ${LOST_AFTER_DAYS} days after it was due.`);
    const at = clock().toISOString();
    store.updateRequest(r.id, { status: 'lost', closed_at: at, renewal_asked_at: null });
    store.setBookLost(r.book_id, at);
    for (const memberId of store.clearHolds(r.book_id)) {
      await notifier.notify(memberId, { text: `*${r.book_title}* isn't coming back, so its queue has closed.`, optional: true });
    }
    await notifier.notify(r.borrower_id, {
      requestId: r.id,
      text:
        `📕 ${owner.name} has marked *${r.book_title}* as lost, more than ${LOST_AFTER_DAYS} days after it was due. ` +
        `Please replace it, or agree a price with ${owner.name}; you can message them in the app. Until it's settled you can't borrow other books.`,
      link: requestLink(r.id),
      template: { name: 'request_update', params: [r.book_title, `${owner.name} marked it as lost`], url: String(r.id) },
    });
    const borrower = store.memberById(r.borrower_id);
    for (const admin of admins()) {
      if (admin.id === owner.id || admin.id === r.borrower_id) continue;
      await notifier.notify(admin.id, { text: `📕 *${r.book_title}*, lent by ${who(owner)}, was marked lost. It was with ${who(borrower)}.` });
    }
    return store.requestById(r.id);
  }

  /** The owner says a lost book was replaced or paid for. */
  async function markSettled(owner, requestId) {
    const r = getRequest(requestId, owner);
    if (r.owner_id !== owner.id) throw new LibraryError(`Only ${r.owner_name} can do this.`);
    if (r.status !== 'lost' || r.settled_at) throw new LibraryError('There’s nothing to settle here.');
    store.updateRequest(r.id, { settled_at: clock().toISOString() });
    await notifier.notify(r.borrower_id, { requestId: r.id, text: `🤝 ${owner.name} marked *${r.book_title}* as settled. Thank you!`, optional: true });
    return store.requestById(r.id);
  }

  /** A book marked lost is back on the owner's shelf (the same copy turned up, or it was replaced). */
  async function relist(owner, bookId) {
    const book = store.bookById(Number(bookId));
    if (!book || book.owner_id !== owner.id) return null;
    const lostLoan = store.requestsFor(owner.id).find((r) => r.book_id === book.id && r.status === 'lost' && !r.settled_at);
    if (lostLoan) await markSettled(owner, lostLoan.id);
    store.setBookLost(book.id, null);
    return store.setStatus(owner.id, book.id, 'available');
  }

  /** The parts of a loan the app shows besides the basics: renewals, the queue, losing it. */
  function loanView(r, viewer) {
    const iOwn = r.owner_id === viewer.id;
    const waiting = store.holdsFor(r.book_id).length;
    const lostFrom = r.due_at ? Date.parse(r.due_at) + LOST_AFTER_DAYS * DAY : null;
    const active = r.status === 'accepted' && Boolean(r.handed_over_at);
    return {
      waiting,
      renewals: r.renewals,
      maxRenewals: maxRenewals(),
      renewalAsked: Boolean(r.renewal_asked_at),
      canRenew: !iOwn && active && !r.renewal_asked_at && r.renewals < maxRenewals() && !waiting,
      canMarkLost: iOwn && r.status === 'accepted' && lostFrom !== null && clock().getTime() >= lostFrom,
      settled: Boolean(r.settled_at),
    };
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
    if (r.status !== 'accepted' && !(r.status === 'lost' && !r.settled_at)) {
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
    if (!agreedToTerms(member)) throw new LibraryError('Please agree to the Terms first.');
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

  /**
   * Due-soon and overdue reminders. Run periodically (hourly). The borrower is reminded 2 days before
   * the due date, 3 days after it, then weekly while it's still out. The owner is told once when it's
   * overdue; after two weeks the admins and whoever invited the borrower are told too.
   */
  async function runReminders(at = clock()) {
    let sent = 0;
    for (const r of store.activeLoans()) {
      // Nobody confirmed the hand-over: the loan counts as started PICKUP_DAYS after it was accepted.
      if (!r.handed_over_at && r.decided_at && at.getTime() - Date.parse(r.decided_at) >= PICKUP_DAYS * DAY) {
        store.updateRequest(r.id, { handed_over_at: new Date(Date.parse(r.decided_at) + PICKUP_DAYS * DAY).toISOString() });
      }
      const due = Date.parse(r.due_at);
      const overdue = at.getTime() > due;
      const next = due + (r.reminders === 0 ? -2 : 3 + (r.reminders - 1) * 7) * DAY;
      if (at.getTime() >= next) {
        store.updateRequest(r.id, { reminders: r.reminders + 1 });
        await notifier.notify(r.borrower_id, {
          requestId: r.id,
          text:
            (overdue
              ? `⏰ *${r.book_title}* from ${r.owner_name} was due back on ${fmtDate(r.due_at)}. Please return it soon, or message them in the app.`
              : `⏰ Reminder: *${r.book_title}* from ${r.owner_name} is due back on ${fmtDate(r.due_at)}.`) +
            waitingLine(store.holdsFor(r.book_id).length),
          link: requestLink(r.id),
          template: { name: 'return_reminder', params: [r.book_title, r.owner_name, fmtDate(r.due_at)], url: String(r.id) },
        });
        sent++;
        if (overdue && !r.owner_late_at) {
          store.updateRequest(r.id, { owner_late_at: at.toISOString() });
          await notifier.notify(r.owner_id, {
            requestId: r.id,
            text:
              `⏰ ${r.borrower_name} hasn't returned *${r.book_title}* yet (it was due ${fmtDate(r.due_at)}). ` +
              'We’ve reminded them and will keep doing so each week. You can message them in the app; ' +
              'once you have it back, tap *Got it back*.',
            link: requestLink(r.id),
            template: { name: 'request_update', params: [r.book_title, `${r.borrower_name} hasn't returned it yet`], url: String(r.id) },
          });
        }
      }
      if (!r.escalated_at && at.getTime() - due >= ESCALATE_AFTER_DAYS * DAY) {
        store.updateRequest(r.id, { escalated_at: at.toISOString() });
        await escalate(r);
      }
    }
    return sent;
  }

  /** A book two weeks overdue: tells the admins, and the person who invited the borrower. */
  async function escalate(r) {
    const borrower = store.memberById(r.borrower_id);
    const owner = store.memberById(r.owner_id);
    if (!borrower || !owner) return;
    const inviter = borrower.referred_by ? store.memberById(borrower.referred_by) : null;
    const told = new Set([borrower.id, owner.id]);
    for (const admin of admins()) {
      if (told.has(admin.id)) continue;
      told.add(admin.id);
      await notifier.notify(admin.id, {
        text:
          `📕 *${r.book_title}*, lent by ${who(owner)}, is ${ESCALATE_AFTER_DAYS} days overdue with ${who(borrower)}` +
          `${inviter ? `, who was invited by ${inviter.name}` : ''}. They've been reminded every week. ` +
          'You may want to have a word.',
      });
    }
    if (inviter && inviter.status === 'active' && !told.has(inviter.id)) {
      await notifier.notify(inviter.id, {
        text:
          `📕 ${borrower.name}, whom you invited, has had ${owner.name}'s book *${r.book_title}* for ` +
          `${ESCALATE_AFTER_DAYS} days past its return date. A friendly reminder from you might help.`,
      });
    }
  }

  /** Refuses while they still hold someone's book, so nobody can borrow and then vanish. */
  function canDeleteAccount(member) {
    const holding = store.borrowedBy(member.id);
    if (holding.length) {
      throw new LibraryError(
        `You still have ${listLoans(holding)}. Please return ${holding.length > 1 ? 'them' : 'it'} first. ` +
          'Once the owner taps *Got it back*, you can delete your account.',
      );
    }
    const [lost] = store.unsettledLostBy(member.id);
    if (lost) {
      throw new LibraryError(`You haven't settled *${lost.book_title}* with ${lost.owner_name} yet (it was marked lost). Please do that first.`);
    }
  }

  function deleteAccount(member) {
    canDeleteAccount(member);
    store.deleteMember(member.id);
  }

  return {
    want,
    decide,
    cancel,
    markReturned,
    handOver,
    askRenewal,
    answerRenewal,
    joinQueue,
    leaveQueue,
    queueView,
    runQueues,
    markLost,
    markSettled,
    relist,
    loanView,
    borrowerRecord,
    badgesFor,
    profileOf,
    canDeleteAccount,
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
