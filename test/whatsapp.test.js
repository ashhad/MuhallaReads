import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { parseIncoming } from '../src/whatsapp.js';
import { baseSettings, AYESHA, BILAL } from './helpers.js';

test('parses text, button taps and other message types', () => {
  assert.deepEqual(parseIncoming({ from: AYESHA, id: 'w1', type: 'text', text: { body: 'dune' } }, 'Ayesha'), {
    phone: AYESHA, profileName: 'Ayesha', waId: 'w1', text: 'dune',
  });
  const tap = parseIncoming({ from: AYESHA, id: 'w2', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'skip', title: 'Skip' } } });
  assert.equal(tap.payload, 'skip');
  assert.equal(parseIncoming({ from: AYESHA, id: 'w3', type: 'image', image: { id: 'm1' } }).other, 'image');
  assert.equal(parseIncoming({ from: AYESHA, id: 'w4', type: 'reaction' }), null);
});

test('Cloud API webhook end to end: signature, setup, sign-in button and a paid template', async () => {
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

    // Each message is answered before the next is sent, as on a phone.
    const chat = async (from, name, text, replies) => {
      const before = sent.length;
      await post(from, name, text);
      await settle(before + replies);
      return sent.slice(before);
    };
    const welcome = await chat(AYESHA, 'Ayesha', 'hi', 2);
    assert.equal(welcome[0].url, 'https://graph.facebook.com/v23.0/555/messages');
    assert.equal(welcome[0].auth, 'Bearer tok');
    assert.match(welcome[0].body.text.body, /Welcome, Ayesha/);
    assert.equal(welcome[1].body.type, 'interactive'); // building question with a Skip button
    assert.equal(welcome[1].body.interactive.action.buttons[0].reply.id, 'skip');
    await chat(AYESHA, 'Ayesha', 'Green Park Tower', 1);
    const [done] = await chat(AYESHA, 'Ayesha', 'Saket', 1);
    assert.equal(done.body.interactive.type, 'cta_url'); // "Open MohallaReads" button with a sign-in link
    assert.match(done.body.interactive.body.text, /All set/);
    assert.match(done.body.interactive.action.parameters.url, /^https:\/\/books\.example\.org\/#login=/);
    const [other] = await chat(AYESHA, 'Ayesha', 'add Dune by Frank Herbert', 1);
    assert.match(other.body.interactive.body.text, /happen in the app/);

    // Bilal requests Ayesha's book in the app while her window is closed, so Meta gets a template.
    const ayesha = store.memberByPhone(AYESHA);
    const { added } = await app.locals.library.addBooks(ayesha, [{ title: 'Dune' }]);
    store.touchInbound(ayesha.id, new Date(Date.now() - 2 * 86400_000).toISOString());
    await chat(BILAL, 'Bilal', 'hi', 2);
    await chat(BILAL, 'Bilal', 'skip', 1);
    await chat(BILAL, 'Bilal', 'Saket', 1);
    const before = sent.length;
    const r = await app.locals.library.want(store.memberByPhone(BILAL), added[0].id);
    const tpl = sent.slice(before).find((s) => s.body.type === 'template');
    assert.equal(tpl.body.to, AYESHA);
    assert.equal(tpl.body.template.name, 'book_request');
    assert.equal(tpl.body.template.language.code, 'en');
    const [bodyComp, urlButton] = tpl.body.template.components;
    assert.deepEqual(bodyComp.parameters.map((p) => p.text), ['Bilal (Saket)', 'Dune', '-']);
    assert.deepEqual(urlButton, { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(r.id) }] });
    assert.equal(store.usageFor().templates, 1);
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});
