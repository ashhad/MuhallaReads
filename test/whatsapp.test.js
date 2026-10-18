import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';

test('Cloud API webhook: verifies signature, runs the bot and replies', async () => {
  const store = openDb(':memory:');
  const app = createApp({
    store,
    settings: {
      communityName: 'Test',
      joinCode: '',
      whatsapp: { token: 'tok', phoneNumberId: '555', verifyToken: 'vt', appSecret: 'secret', graphVersion: 'v23.0' },
      twilio: {},
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
      return new Response('{}');
    }
    return realFetch(url, opts);
  };

  const post = (text) => {
    const body = JSON.stringify({
      entry: [{ changes: [{ value: {
        contacts: [{ wa_id: '919800000001', profile: { name: 'Ayesha' } }],
        messages: [{ from: '919800000001', type: 'text', text: { body: text } }],
      } }] }],
    });
    const sig = 'sha256=' + crypto.createHmac('sha256', 'secret').update(body).digest('hex');
    return realFetch(`${base}/webhooks/whatsapp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body,
    });
  };
  const waitForSends = async (n) => {
    for (let i = 0; i < 50 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 20));
  };

  try {
    const verify = await realFetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42`);
    assert.equal(await verify.text(), '42');

    const bad = await realFetch(`${base}/webhooks/whatsapp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=00' }, body: '{}',
    });
    assert.equal(bad.status, 401);

    assert.equal((await post('add Dune by Frank Herbert')).status, 200);
    await waitForSends(2);
    assert.equal(sent[0].url, 'https://graph.facebook.com/v23.0/555/messages');
    assert.equal(sent[0].auth, 'Bearer tok');
    assert.equal(sent[0].body.to, '919800000001');
    assert.match(sent[0].body.text.body, /You're in, Ayesha/);
    assert.match(sent[1].body.text.body, /Added 1 book/);
    assert.equal(store.search('dune')[0].copies[0].owner.name, 'Ayesha');
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});
