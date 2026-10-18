// WhatsApp transports. Two options, use whichever you set up:
//  - Meta WhatsApp Cloud API: GET/POST /webhooks/whatsapp
//  - Twilio WhatsApp:         POST     /webhooks/twilio
import crypto from 'node:crypto';
import express from 'express';
import { normalizePhone } from './phone.js';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const MEDIA_TIMEOUT_MS = 20000;

export function whatsappRouter({ bot, config }) {
  const router = express.Router();
  const wa = config.whatsapp;
  const tw = config.twilio;

  const runBot = (msg, send) =>
    bot.handle(msg, send).catch((err) => {
      console.error('WhatsApp bot error:', err);
      return send('⚠️ Something went wrong. Please try again.').catch(() => {});
    });

  // ---------- Meta WhatsApp Cloud API ----------

  const graph = (p) => `https://graph.facebook.com/${wa.graphVersion}/${p}`;

  async function cloudSend(to, body) {
    const res = await fetch(graph(`${wa.phoneNumberId}/messages`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${wa.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body, preview_url: false } }),
    });
    if (!res.ok) console.error('WhatsApp send failed:', res.status, await res.text());
  }

  async function cloudMedia(mediaId) {
    const auth = { Authorization: `Bearer ${wa.token}` };
    const meta = await fetch(graph(mediaId), { headers: auth, signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
    if (!meta.ok) throw new Error('Could not download the photo.');
    const { url, mime_type } = await meta.json();
    const file = await fetch(url, { headers: auth, signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
    if (!file.ok) throw new Error('Could not download the photo.');
    return { buffer: Buffer.from(await file.arrayBuffer()), mediaType: mime_type };
  }

  // Webhook verification handshake (Meta calls this once when you register the webhook).
  router.get('/webhooks/whatsapp', (req, res) => {
    if (wa.verifyToken && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === wa.verifyToken) {
      return res.send(String(req.query['hub.challenge'] || ''));
    }
    res.sendStatus(403);
  });

  router.post('/webhooks/whatsapp', (req, res) => {
    if (!wa.token || !wa.phoneNumberId) return res.sendStatus(404);
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
          const phone = normalizePhone(m.from, '');
          if (!phone) continue;
          const msg = { phone, profileName: names[m.from] };
          if (m.type === 'text') msg.text = m.text?.body;
          else if (m.type === 'image') msg.image = () => cloudMedia(m.image.id);
          else if (m.type === 'interactive') msg.text = m.interactive?.button_reply?.title;
          else continue;
          runBot(msg, (body) => cloudSend(m.from, body));
        }
      }
    }
  });

  // ---------- Twilio ----------

  function validTwilioSignature(req) {
    if (!tw.authToken) return true;
    if (!config.publicUrl) {
      console.warn('Set PUBLIC_URL so Twilio signatures can be verified.');
      return false;
    }
    const url = config.publicUrl + req.originalUrl;
    const params = req.body || {};
    const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
    const expected = crypto.createHmac('sha1', tw.authToken).update(data).digest('base64');
    return safeEqual(expected, req.get('x-twilio-signature') || '');
  }

  const twilioAuth = () => 'Basic ' + Buffer.from(`${tw.accountSid}:${tw.authToken}`).toString('base64');

  async function twilioSend(to, body) {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${tw.accountSid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: twilioAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: tw.from, To: to, Body: body.slice(0, 1600) }),
    });
    if (!res.ok) console.error('Twilio send failed:', res.status, await res.text());
  }

  async function twilioMedia(url) {
    const res = await fetch(url, { headers: { Authorization: twilioAuth() }, signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
    if (!res.ok) throw new Error('Could not download the photo.');
    return { buffer: Buffer.from(await res.arrayBuffer()), mediaType: res.headers.get('content-type') };
  }

  router.post('/webhooks/twilio', express.urlencoded({ extended: false }), (req, res) => {
    if (!tw.accountSid || !tw.authToken || !tw.from) return res.sendStatus(404);
    if (!validTwilioSignature(req)) return res.sendStatus(401);
    res.type('text/xml').send('<Response></Response>');

    const b = req.body;
    const phone = normalizePhone(b.From);
    if (!phone) return;
    const msg = { phone, profileName: b.ProfileName, text: b.Body };
    if (Number(b.NumMedia) > 0 && /^image\//.test(b.MediaContentType0 || '')) {
      msg.image = () => twilioMedia(b.MediaUrl0);
      msg.text = '';
    }
    runBot(msg, (body) => twilioSend(b.From, body));
  });

  return router;
}
