// The WhatsApp side of the library: joining, account settings, sign-in links and notifications.
// Everything else (finding, adding, requesting, chatting) happens in the web app; any other message
// gets a button that signs the member in there.
// Members only ever see each other's display names. Phone numbers stay on the server.
import fs from 'node:fs';
import { who, LibraryError, approvalTag } from './library.js';
import { placeOf } from './db.js';

const MAX_MESSAGE = 3900; // WhatsApp's limit is 4096 characters

/** Display names: no WhatsApp formatting characters, no line breaks, 2–40 characters. */
export function cleanName(s, max = 40) {
  const name = String(s || '').replace(/[*_~`\n\r\t]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  return name.length >= 2 ? name : '';
}

/** Building or locality: like a name, up to 60 characters. */
export const cleanPlace = (s) => cleanName(s, 60);

export function helpText(communityName, { admin = false, photos = false } = {}) {
  const adding = photos
    ? 'add yours (one photo of your whole shelf, a barcode scan, or the title)'
    : 'add yours (scan the barcode or type the title)';
  return [
    `📚 *${communityName}*: our neighbourhood library`,
    '',
    `Everything happens in the app: find books, ${adding}, requests and private chat.`,
    '🌐 `login`: get a sign-in link',
    '',
    'Here on WhatsApp you get notifications (requests, replies, reminders) and can manage your account:',
    '👤 `name Ayesha` · 🏢 `building Green Park Tower` · 📍 `locality Saket`',
    '💌 `invite`: your link for inviting a neighbour (an admin approves everyone)',
    '🔔 `alerts off` / `alerts on`: messages when neighbours add new books',
    '🔒 `logout everywhere`: sign out of the app on all devices (e.g. a lost phone)',
    '🗑️ `delete me`: delete your account and all your data',
    ...(admin ? ['', '🛠️ Admin: `pending` · `approve 12` · `decline 12` · `stats` · `members` · `remove member 12` · `security`'] : []),
    '',
    '🔒 Your number stays private unless you choose to share it.',
  ].join('\n');
}

const ASK_BUILDING =
  '🏢 What\'s your *building or society* name? e.g. _Green Park Tower_\n' +
  'Only this and your locality are shown next to your name, never your flat number or address.';
const ASK_LOCALITY = '📍 And your *locality or area*? e.g. _Saket_';
const SKIP = [{ id: 'skip', title: 'Skip' }];

const clip = (s) => (s.length > MAX_MESSAGE ? s.slice(0, MAX_MESSAGE - 20) + '\n…(more not shown)' : s);

/**
 * @param {object} deps
 * @param {import('./db.js').Store} deps.store
 * @param {ReturnType<import('./library.js').createLibrary>} deps.library
 * @param {ReturnType<import('./notifier.js').createNotifier>} deps.notifier
 * @param {object} deps.settings
 */
export function createBot({ store, library, notifier, settings }) {
  const confirmingDelete = new Set();
  const setupStep = new Map(); // member id -> 'building' | 'locality' while answering the setup questions
  const isAdminPhone = (phone) => Boolean(settings.adminPhones?.includes(phone));
  const isAdmin = (member) => isAdminPhone(member.phone) && member.status === 'active';

  /** A one-time sign-in button for the web app (works once, for 15 minutes). */
  const signInLink = (member) =>
    settings.publicUrl
      ? { url: `${settings.publicUrl}/#login=${store.createLoginCode(member.id)}`, label: 'Open MohallaReads' }
      : undefined;

  function openAppReply(member, reply, intro) {
    const link = signInLink(member);
    if (!link) return reply(`${intro}\n\nThe app's address isn't set up yet. Ask the admin.`);
    return reply(`${intro}\n\nTap below to open it (the button works once, for 15 minutes; send *login* for a new one).`, { link });
  }

  /** First-time setup: building, then locality. At least one is required. */
  async function setup(member, text, reply, { payload } = {}) {
    const step = setupStep.get(member.id);
    const skip = /^skip$/i.test(text);
    if (step && !skip && (payload || commands.some(([re]) => re.test(text)))) {
      // e.g. a button from an older message, or "login": finish setup first
      return reply(`Let's finish setting you up first.\n\n${step === 'building' ? ASK_BUILDING : ASK_LOCALITY}`, { buttons: SKIP });
    }
    if (!step) {
      setupStep.set(member.id, 'building');
      return reply(ASK_BUILDING, { buttons: SKIP });
    }
    if (step === 'building') {
      if (!skip) {
        const building = cleanPlace(text);
        if (!building) return reply('Please send your building or society name, or tap *Skip*.', { buttons: SKIP });
        store.setPlace(member.id, { building, locality: member.locality });
      }
      setupStep.set(member.id, 'locality');
      return reply(ASK_LOCALITY, store.memberById(member.id).building ? { buttons: SKIP } : undefined);
    }
    const locality = skip ? '' : cleanPlace(text);
    if (!locality && !member.building) {
      return reply('Please send at least your locality, so neighbours have a rough idea where you are. e.g. _Saket_');
    }
    if (locality) store.setPlace(member.id, { building: member.building, locality });
    setupStep.delete(member.id);
    let me = store.memberById(member.id);
    if (me.status === 'pending' && (await library.askApproval(me)) === 'asked') {
      return openAppReply(
        me,
        reply,
        `✅ Thanks, ${me.name}! Neighbours will see you as *${who(me)}* once an admin approves you. ` +
          "You'll get a message here, usually within a day.\n" +
          'Meanwhile you can look around the app and see which books are in the library.',
      );
    }
    me = store.memberById(member.id);
    return openAppReply(
      me,
      reply,
      `✅ All set! Neighbours will see you as *${who(me)}*.\n` +
        'Find books, add yours and manage requests in the app. You\'ll get notifications here.',
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

  // Each command: [pattern, handler(member, match, reply)].
  const commands = [
    [/^(help|menu|\?)\W*$/i, (m, _, reply) => reply(helpText(settings.communityName, { admin: isAdmin(m), photos: Boolean(settings.anthropicApiKey) }))],
    [/^join\b/i, (m, _, reply) => openAppReply(m, reply, `You're already a member, ${m.name}! 🙂`)],
    [/^(login|log in|sign in|website|web|link|app|open)$/i, (m, _, reply) => openAppReply(m, reply, '🌐 Here\'s your sign-in link.')],
    [
      /^name\s+([\s\S]+)$/i,
      (m, x, reply) => {
        const name = cleanName(x[1]);
        if (!name) return reply('Please give a name of 2–40 characters, e.g. `name Ayesha`');
        store.renameMember(m.id, name);
        return reply(`👤 Neighbours will now see you as *${who(store.memberById(m.id))}*.`);
      },
    ],
    [/^building\s+([\s\S]+)$/i, (m, x, reply) => changePlace(m, 'building', x[1], reply)],
    [/^(locality|area)\s+([\s\S]+)$/i, (m, x, reply) => changePlace(m, 'locality', x[2], reply)],
    [
      /^(log ?out|sign ?out) (everywhere|all|all devices)$/i,
      (m, _, reply) => {
        store.deleteSessionsOf(m.id);
        return reply('🔒 Signed out of the app on every device. Send *login* for a new sign-in button.');
      },
    ],
    [
      /^invite\b/i,
      (m, _, reply) => {
        if (m.status !== 'active') return reply("You can invite neighbours once an admin has approved you.");
        if (!settings.publicUrl) return reply("The app's address isn't set up yet. Ask the admin.");
        const url = `${settings.publicUrl}/?join=${store.refCodeFor(m.id)}`;
        return reply(
          `💌 Your invite link: ${url}\n\nForward it to a neighbour you know. When they join, an admin checks and ` +
            "approves them, and they'll show as invited by you.",
        );
      },
    ],
    [
      /^alerts?\s+(on|off)$/i,
      (m, x, reply) => {
        const on = x[1].toLowerCase() === 'on';
        store.setBookAlerts(m.id, on);
        return reply(on ? "🔔 You'll hear about new books again." : "🔕 OK, no more new-book messages. Send *alerts on* to get them back.");
      },
    ],
    [
      /^pending$/i,
      (m, _, reply) => {
        if (!isAdmin(m)) return false;
        const list = store.pendingMembers();
        if (!list.length) return reply('Nobody is waiting for approval.');
        return reply(
          clip(
            '🆕 Waiting for approval:\n' +
              list
                .map((p) => {
                  const by = p.referrer_name ? `invited by ${p.referrer_name}` : 'join code';
                  return `• ${p.name} (${placeOf(p)}), ${by}: *approve ${p.id}-${approvalTag(store.memberById(p.id))}*`;
                })
                .join('\n') +
              '\n\nReply with the *approve …* shown, or *decline* with the same number.',
          ),
        );
      },
    ],
    [
      /^(approve|decline)\s+#?(\d+)(?:-([0-9a-f]{4}))?$/i,
      async (m, x, reply) => {
        if (!isAdmin(m)) return false;
        try {
          if (x[1].toLowerCase() === 'approve') {
            const { member, already } = await library.approveMember(x[2], x[3]);
            return reply(already ? `${member.name} is already a member.` : `✅ Approved ${who(member)}. They've been told.`);
          }
          const gone = await library.declineMember(x[2], x[3]);
          return reply(`Declined ${gone.name}. Their details have been deleted.`);
        } catch (err) {
          if (err instanceof LibraryError) return reply(err.message);
          throw err;
        }
      },
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
    // ---- admin (others fall through to the "use the app" reply) ----
    [
      /^stats$/i,
      (m, _, reply) => {
        if (!isAdmin(m)) return false;
        const s = store.stats();
        const u = store.usageFor();
        return reply(
          `📊 ${s.members} members${s.pending ? ` (+${s.pending} waiting for approval)` : ''} · ${s.books} books · ${s.loans} active loans\n` +
            `WhatsApp this month: ${u.templates}/${settings.monthlyTemplateLimit} paid templates (≈ ₹${(u.templates * 0.136).toFixed(2)}), ${u.service} free replies\n` +
            `Photo scans this month: ${u.photos}/${settings.photoMonthlyLimit} photos, ₹${(u.photo_cost * settings.usdInrRate).toFixed(2)} of the ₹${settings.photoMonthlyBudgetInr.toFixed(2)} budget`,
        );
      },
    ],
    [
      /^security$/i,
      (m, _, reply) => {
        if (!isAdmin(m)) return false;
        let report = '';
        try {
          report = fs.readFileSync(settings.securityReportPath, 'utf8').trim();
        } catch {
          // no report yet
        }
        return reply(
          report
            ? clip(report)
            : "🛡️ No security report yet. Once the security monitor is on (deploy/oracle/soc-setup.sh), there's a new one every morning.",
        );
      },
    ],
    [
      /^members$/i,
      (m, _, reply) => {
        if (!isAdmin(m)) return false;
        return reply(
          clip(
            store
              .listMembers()
              .map((x) => `#${x.id} ${x.name}${x.status === 'pending' ? ' (waiting)' : ''}${x.referrer_name ? `, invited by ${x.referrer_name}` : ''}`)
              .join('\n'),
          ),
        );
      },
    ],
    [
      /^remove member\s+#?(\d+)$/i,
      (m, x, reply) => {
        if (!isAdmin(m)) return false;
        const target = store.memberById(Number(x[1]));
        if (!target) return reply('No such member.');
        store.deleteMember(target.id);
        return reply(`Removed ${target.name} and their books.`);
      },
    ],
  ];

  /**
   * Handles one incoming message.
   * @param {{phone: string, profileName?: string, text?: string, payload?: string, other?: string}} msg
   * @param {(text: string, opts?: {buttons?: {id: string, title: string}[], link?: {url: string, label: string}}) => Promise<unknown>} send
   */
  async function handle(msg, send) {
    const reply = async (text, opts) => {
      await send(text, opts);
      store.bumpUsage('service');
    };
    const text = (msg.payload ? String(msg.payload).replace(':', ' ') : msg.text || '').trim();
    let member = store.memberByPhone(msg.phone);

    if (!member) {
      const join = /^join\b\s*(.*)$/is.exec(text);
      const code = join?.[1]?.trim() || '';
      // A member's personal invite code, or the shared join code. Either way an admin approves them.
      const referrer = code ? store.memberByRefCode(code) : undefined;
      const usedCode = Boolean(settings.joinCode) && code.toLowerCase() === settings.joinCode.toLowerCase();
      if (settings.joinCode && !referrer && !usedCode) {
        return reply(
          `👋 Welcome to *${settings.communityName}*, our neighbourhood book-lending library!\n` +
            'To join, open the invite link a neighbour sent you, or reply: `join <code>`',
        );
      }
      const name = cleanName(msg.profileName) || 'Neighbour';
      member = store.createMember({
        name,
        phone: msg.phone,
        status: isAdminPhone(msg.phone) ? 'active' : 'pending',
        joinedVia: referrer ? 'referral' : usedCode ? 'code' : 'open',
        referredBy: referrer?.id ?? null,
      });
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
    if (setupStep.has(member.id) || !placeOf(member)) return setup(member, text, reply, msg);

    // Messaging the bot delivers any notifications that were waiting, plus news of books added meanwhile.
    const delivered = await notifier.flush(member);
    const caughtUp = !/^alerts?\b/i.test(text) && (await library.newsSummary(member, reply));

    for (const [re, fn] of commands) {
      const match = re.exec(text);
      if (match && (await fn(member, match, reply)) !== false) return;
    }

    if ((delivered || caughtUp) && !msg.other) return; // they were just catching up on notifications
    const intro = msg.other === 'image'
      ? settings.anthropicApiKey
        ? '📷 Thanks! Add books in the app instead: tap Add › Shelf photo and it reads your whole shelf at once.'
        : '📷 Thanks! Adding books works best in the app: scan the barcode or type the title.'
      : '📚 Searching, adding books, requests and chat all happen in the app.';
    const waiting = member.status === 'pending' ? "\n⏳ You're waiting for an admin to approve you; you'll get a message here." : '';
    return openAppReply(member, reply, `${intro}${waiting}\nSend *help* to see what you can do here.`);
  }

  return { handle };
}
