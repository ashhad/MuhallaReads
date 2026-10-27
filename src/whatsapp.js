// WhatsApp Cloud API (Meta): sending messages, and the webhook that receives them.
import crypto from 'node:crypto';
import express from 'express';
import { normalizePhone } from './phone.js';

const SEND_TIMEOUT_MS = 15000;
const BODY_LIMIT = 1024; // interactive message body limit

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Template parameters can't contain newlines, tabs or long runs of spaces, and can't be empty.
const templateParam = (s) =>
  String(s ?? '').replace(/[\n\r\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 300) || '-';

/**
 * The library's own contact: its name and WhatsApp number, or null when the number isn't configured.
 * Until Meta approves the number's display name, WhatsApp shows members the bare number; once they
 * save this contact, it shows the name instead.
 */
export function libraryContact(settings) {
  const phone = settings.whatsapp?.displayNumber;
  return phone ? { name: settings.communityName, phone, url: settings.publicUrl || '' } : null;
}

/** The same contact as a vCard file, for the website ("Save the library's number"). */
export function vCard({ name, phone, url }) {
  const esc = (s) => String(s).replace(/[\\,;]/g, (c) => `\\${c}`).replace(/\r?\n/g, ' ');
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${esc(name)}`,
    `N:;${esc(name)};;;`,
    `ORG:${esc(name)}`,
    `TEL;TYPE=CELL;waid=${phone}:+${phone}`, // waid: WhatsApp's own field, so it links to the chat
    ...(url ? [`URL:${url}`] : []),
    'END:VCARD',
    '',
  ].join('\r\n');
}

export function createMetaTransport({ token, phoneNumberId, graphVersion, templateLang }) {
  const graph = (p) => `https://graph.facebook.com/${graphVersion}/${p}`;
  const auth = { Authorization: `Bearer ${token}` };

  async function post(payload) {
    const res = await fetch(graph(`${phoneNumberId}/messages`), {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = data.error || {};
      throw new Error(`WhatsApp API ${res.status} (code ${e.code ?? '?'}): ${e.message || 'unknown error'}`);
    }
    console.log(`WhatsApp: sent ${payload.type}${payload.template ? ` "${payload.template.name}"` : ''}`);
    return data.messages?.[0]?.id;
  }

  /**
   * Sends a normal message (only allowed within 24h of the member's last message). Returns its id.
   * `buttons` are reply buttons (max 3); `link` is a single button that opens a web page; `contact`
   * (see libraryContact) follows the text as a contact card the member can save.
   */
  async function send(to, { text, buttons, link, contact }) {
    let interactive;
    if (contact) {
      const id = text ? await post({ to, type: 'text', text: { body: text, preview_url: false } }) : undefined;
      const card = await post({
        to,
        type: 'contacts',
        contacts: [
          {
            name: { formatted_name: contact.name, first_name: contact.name },
            org: { company: contact.name },
            phones: [{ phone: `+${contact.phone}`, type: 'WORK', wa_id: contact.phone }],
            ...(contact.url ? { urls: [{ url: contact.url, type: 'WORK' }] } : {}),
          },
        ],
      });
      return id ?? card;
    }
    if (link) {
      interactive = (body) => ({
        type: 'cta_url',
        body: { text: body },
        action: { name: 'cta_url', parameters: { display_text: link.label.slice(0, 20), url: link.url } },
      });
    } else if (buttons?.length) {
      const action = {
        buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) } })),
      };
      interactive = (body) => ({ type: 'button', body: { text: body }, action });
    } else {
      return post({ to, type: 'text', text: { body: text, preview_url: false } });
    }
    if (text.length <= BODY_LIMIT) return post({ to, type: 'interactive', interactive: interactive(text) });
    const id = await post({ to, type: 'text', text: { body: text, preview_url: false } });
    await post({ to, type: 'interactive', interactive: interactive('👇') });
    return id;
  }

  /** Sends a pre-approved template (allowed any time; paid). `url` fills the template's URL button. */
  async function sendTemplate(to, { name, params = [], url }) {
    const components = [];
    if (params.length) {
      components.push({ type: 'body', parameters: params.map((p) => ({ type: 'text', text: templateParam(p) })) });
    }
    if (url) components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: url }] });
    return post({ to, type: 'template', template: { name, language: { code: templateLang }, components } });
  }

  return { send, sendTemplate };
}

/** Turns one webhook message into what the bot understands, or null if it's a type we ignore. */
export function parseIncoming(m, profileName) {
  const phone = normalizePhone(m.from, '');
  if (!phone) return null;
  const msg = { phone, profileName, waId: m.id };
  switch (m.type) {
    case 'text':
      msg.text = m.text?.body || '';
      break;
    case 'interactive':
      msg.payload = m.interactive?.button_reply?.id || m.interactive?.list_reply?.id;
      break;
    case 'button': // quick-reply button on a template
      msg.payload = m.button?.payload || m.button?.text;
      break;
    case 'reaction':
    case 'system':
    case 'unsupported':
      return null;
    default: // photos, voice notes, stickers…: the bot points them to the app
      msg.other = m.type;
  }
  return msg;
}

export function whatsappRouter({ bot, transport, config }) {
  const router = express.Router();
  const wa = config.whatsapp;
  const seen = new Set(); // Meta sometimes delivers the same message twice

  router.get('/webhooks/whatsapp', (req, res) => {
    if (wa.verifyToken && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === wa.verifyToken) {
      console.log('WhatsApp webhook: verified by Meta');
      return res.send(String(req.query['hub.challenge'] || ''));
    }
    console.warn('WhatsApp webhook: verification refused (verify token does not match WHATSAPP_VERIFY_TOKEN)');
    res.sendStatus(403);
  });

  router.post('/webhooks/whatsapp', (req, res) => {
    if (!transport) {
      console.warn('WhatsApp webhook: delivery ignored because WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID are not set');
      return res.sendStatus(404);
    }
    // Without the app secret anyone could post a fake message "from" any number (an admin's, say), so
    // unsigned deliveries are never accepted.
    if (!wa.appSecret) {
      console.error('WhatsApp webhook: delivery refused because WHATSAPP_APP_SECRET is not set');
      return res.sendStatus(503);
    }
    const expected = 'sha256=' + crypto.createHmac('sha256', wa.appSecret).update(req.rawBody || '').digest('hex');
    if (!safeEqual(expected, req.get('x-hub-signature-256') || '')) {
      console.warn('WhatsApp webhook: signature mismatch, delivery rejected (check WHATSAPP_APP_SECRET)');
      return res.sendStatus(401);
    }
    res.sendStatus(200); // acknowledge immediately; replies are sent asynchronously

    // Counts only: phone numbers and message text are never logged.
    const changes = (req.body?.entry || []).flatMap((e) => e.changes || []);
    const count = (key) => changes.reduce((n, c) => n + (c.value?.[key]?.length || 0), 0);
    console.log(`WhatsApp webhook: ${count('messages')} message(s), ${count('statuses')} status update(s)`);
    for (const st of changes.flatMap((c) => c.value?.statuses || [])) {
      if (st.status === 'failed') {
        const e = st.errors?.[0] || {};
        console.warn(`WhatsApp: a message from the bot failed to deliver: ${e.code} ${e.title || ''} ${e.error_data?.details || ''}`);
      }
    }

    for (const entry of req.body?.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
        for (const m of value.messages || []) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          if (seen.size > 2000) seen.delete(seen.values().next().value);

          const msg = parseIncoming(m, names[m.from]);
          console.log(`WhatsApp: incoming ${m.type}${msg ? '' : ' (ignored)'}`);
          if (!msg) continue;
          const reply = (text, opts) => transport.send(m.from, { text, ...opts });
          bot.handle(msg, reply).catch((err) => {
            console.error('WhatsApp bot error:', err);
            reply('⚠️ Something went wrong. Please try again.').catch(() => {});
          });
        }
      }
    }
  });

  return router;
}
