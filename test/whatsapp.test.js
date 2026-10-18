import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { parseIncoming } from '../src/whatsapp.js';
import { baseSettings, AYESHA, BILAL } from './helpers.js';

test('parses text, button taps, template buttons and swipe-replies', () => {
  assert.deepEqual(parseIncoming({ from: AYESHA, id: 'w1', type: 'text', text: { body: 'dune' } }, 'Ayesha', null), {
    phone: AYESHA, profileName: 'Ayesha', waId: 'w1', contextId: undefined, text: 'dune',
  });
  const tap = parseIncoming({ from: AYESHA, id: 'w2', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'accept:3', title: 'Accept' } } });
  assert.equal(tap.payload, 'accept:3');
  const tpl = parseIncoming({ from: AYESHA, id: 'w3', type: 'button', button: { payload: 'decline:3', text: 'Decline' } });
  assert.equal(tpl.payload, 'decline:3');
  const swipe = parseIncoming({ from: AYESHA, id: 'w4', type: 'text', text: { body: 'ok' }, context: { id: 'wamid.9' } });
  assert.equal(swipe.contextId, 'wamid.9');
  assert.equal(parseIncoming({ from: AYESHA, id: 'w5', type: 'sticker' }), null);
});

test('Cloud API webhook end to end: signature, replies and a paid template with buttons', async () => {
  const store = openDb(':memory:');
  const app = createApp({
    store,
    settings: {
      ...baseSettings,
      whatsapp: { token: 'tok', phoneNumberId: '555', verifyToken: 'vt', appSecret: 'secret', graphVersion: 'v23.0', templateLang: 'en' },
    },
    deps: { enrichAll: async (b) => b, identifyBooks: async () => [], lookupIsbn: async () => null, searchBooks: async () => [] },
  });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://graph.facebook.com/')) {
      sent.push({ url: String(url), auth: opts.headers.Authorization, body: JSON.parse(opts.body) });
      return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }] }));
    }
    return realFetch(url, opts);
  };

  let n = 0;
  const post = (from, name, text) => {
    const body = JSON.stringify({
      entry: [{ changes: [{ value: {
        contacts: [{ wa_id: from, profile: { name } }],
        messages: [{ from, id: `in.${++n}`, type: 'text', text: { body: text } }],
      } }] }],
    });
    const sig = 'sha256=' + crypto.createHmac('sha256', 'secret').update(body).digest('hex');
    return realFetch(`${base}/webhooks/whatsapp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body,
    });
  };
  const settle = async (count) => {
    for (let i = 0; i < 100 && sent.length < count; i++) await new Promise((r) => setTimeout(r, 10));
  };

  try {
    const verify = await realFetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42`);
    assert.equal(await verify.text(), '42');
    const bad = await realFetch(`${base}/webhooks/whatsapp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=00' }, body: '{}',
    });
    assert.equal(bad.status, 401);

    await post(AYESHA, 'Ayesha', 'add Dune by Frank Herbert');
    await settle(2);
    assert.equal(sent[0].url, 'https://graph.facebook.com/v23.0/555/messages');
    assert.equal(sent[0].auth, 'Bearer tok');
    assert.match(sent[0].body.text.body, /Welcome, Ayesha/);
    assert.match(sent[1].body.text.body, /Added 1 book/);

    // Ayesha's window is closed by the time Bilal asks, so Meta gets a template.
    const ayesha = store.memberByPhone(AYESHA);
    store.touchInbound(ayesha.id, new Date(Date.now() - 2 * 86400_000).toISOString());
    const bookId = store.booksOf(ayesha.id)[0].id;
    sent.length = 0;
    await post(BILAL, 'Bilal', `want ${bookId}`);
    await settle(3); // welcome to Bilal, template to Ayesha, confirmation to Bilal
    const tpl = sent.find((s) => s.body.type === 'template');
    assert.equal(tpl.body.to, AYESHA);
    assert.equal(tpl.body.template.name, 'book_request');
    assert.equal(tpl.body.template.language.code, 'en');
    const [bodyComp, accept, decline] = tpl.body.template.components;
    assert.deepEqual(bodyComp.parameters.map((p) => p.text), ['Bilal', 'Dune', '-']);
    assert.match(accept.parameters[0].payload, /^accept:\d+$/);
    assert.equal(decline.index, '1');
    assert.equal(store.usageFor().templates, 1);
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});
