// WhatsApp Cloud API (Meta): sending messages, and the webhook that receives them.
import crypto from 'node:crypto';
import express from 'express';
import { normalizePhone } from './phone.js';

const MEDIA_TIMEOUT_MS = 20000;
const BODY_LIMIT = 1024; // interactive message body limit

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Template parameters can't contain newlines, tabs or long runs of spaces, and can't be empty.
const templateParam = (s) =>
  String(s ?? '').replace(/[\n\r\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 300) || '-';

export function createMetaTransport({ token, phoneNumberId, graphVersion, templateLang }) {
  const graph = (p) => `https://graph.facebook.com/${graphVersion}/${p}`;
  const auth = { Authorization: `Bearer ${token}` };

  async function post(payload) {
    const res = await fetch(graph(`${phoneNumberId}/messages`), {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${data.error?.message || 'unknown error'}`);
    return data.messages?.[0]?.id;
  }

  /** Sends a normal message (only allowed within 24h of the member's last message). Returns its id. */
  async function send(to, { text, buttons }) {
    if (!buttons?.length) {
      return post({ to, type: 'text', text: { body: text, preview_url: false } });
    }
    const action = {
      buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) } })),
    };
    if (text.length <= BODY_LIMIT) {
      return post({ to, type: 'interactive', interactive: { type: 'button', body: { text }, action } });
    }
    const id = await post({ to, type: 'text', text: { body: text, preview_url: false } });
    await post({ to, type: 'interactive', interactive: { type: 'button', body: { text: '👇' }, action } });
    return id;
  }

  /** Sends a pre-approved template (allowed any time; paid). */
  async function sendTemplate(to, { name, params = [], buttons = [] }) {
    const components = [];
    if (params.length) {
      components.push({ type: 'body', parameters: params.map((p) => ({ type: 'text', text: templateParam(p) })) });
    }
    buttons.forEach((payload, i) =>
      components.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload }] }),
    );
    return post({ to, type: 'template', template: { name, language: { code: templateLang }, components } });
  }

  async function downloadMedia(mediaId) {
    const meta = await fetch(graph(mediaId), { headers: auth, signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
    if (!meta.ok) throw new Error('Could not download the photo.');
    const { url, mime_type } = await meta.json();
    const file = await fetch(url, { headers: auth, signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
    if (!file.ok) throw new Error('Could not download the photo.');
    return { buffer: Buffer.from(await file.arrayBuffer()), mediaType: mime_type };
  }

  return { send, sendTemplate, downloadMedia };
}

/** Turns one webhook message into what the bot understands, or null if it's a type we ignore. */
export function parseIncoming(m, profileName, transport) {
  const phone = normalizePhone(m.from, '');
  if (!phone) return null;
  const msg = { phone, profileName, waId: m.id, contextId: m.context?.id };
  switch (m.type) {
    case 'text':
      msg.text = m.text?.body || '';
      break;
    case 'image':
      msg.text = m.image?.caption || '';
      msg.image = () => transport.downloadMedia(m.image.id);
      break;
    case 'interactive':
      msg.payload = m.interactive?.button_reply?.id || m.interactive?.list_reply?.id;
      break;
    case 'button': // quick-reply button on a template
      msg.payload = m.button?.payload || m.button?.text;
      break;
    default:
      return null;
  }
  return msg;
}

export function whatsappRouter({ bot, transport, config }) {
  const router = express.Router();
  const wa = config.whatsapp;
  const seen = new Set(); // Meta sometimes delivers the same message twice

  router.get('/webhooks/whatsapp', (req, res) => {
    if (wa.verifyToken && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === wa.verifyToken) {
      return res.send(String(req.query['hub.challenge'] || ''));
    }
    res.sendStatus(403);
  });

  router.post('/webhooks/whatsapp', (req, res) => {
    if (!transport) return res.sendStatus(404);
    if (wa.appSecret) {
      const expected = 'sha256=' + crypto.createHmac('sha256', wa.appSecret).update(req.rawBody || '').digest('hex');
      if (!safeEqual(expected, req.get('x-hub-signature-256') || '')) return res.sendStatus(401);
    }
    res.sendStatus(200); // acknowledge immediately; replies are sent asynchronously

    for (const entry of req.body?.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
        for (const m of value.messages || []) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          if (seen.size > 2000) seen.delete(seen.values().next().value);

          const msg = parseIncoming(m, names[m.from], transport);
          if (!msg) continue;
          const reply = (text, buttons) => transport.send(m.from, { text, buttons });
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
