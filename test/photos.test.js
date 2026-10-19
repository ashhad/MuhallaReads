import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoLimits, PhotoLimitError } from '../src/photos.js';
import { costUsd, photoRequest } from '../src/vision.js';
import { makeWorld, AYESHA, BILAL } from './helpers.js';

async function world(settings) {
  const w = makeWorld({ settings });
  await w.join(AYESHA, 'Ayesha'); // an admin in the test settings
  await w.join(BILAL, 'Bilal');
  const photos = createPhotoLimits({ store: w.store, notifier: w.notifier, settings: w.settings, clock: w.clock });
  const read = (cost) => () => Promise.resolve({ books: [{ title: 'Dune' }], costUsd: cost });
  return { w, photos, read };
}

test('prices photos from the tokens Claude reports, erring high for unknown models', () => {
  const usage = { input_tokens: 4000, output_tokens: 1500 };
  assert.equal(costUsd(['claude-haiku-5-5'], usage).toFixed(5), '0.00115');
  assert.equal(costUsd(['claude-opus-5-5'], usage).toFixed(3), '0.046');
  assert.equal(costUsd(['claude-haiku-5-5', 'claude-opus-5-5'], usage).toFixed(3), '0.046'); // after a fallback
  assert.equal(costUsd(['some-new-model'], usage).toFixed(3), '0.115');
});

test('only models that support it ask for a refusal fallback', () => {
  assert.equal(photoRequest('claude-haiku-5-5', 'image/jpeg', 'eA==').fallbacks, undefined);
  assert.equal(photoRequest('claude-opus-5-5', 'image/jpeg', 'eA==').fallbacks, 'default');
});

test('each member gets a daily limit, one photo at a time', async () => {
  const { w, photos, read } = await world({ photoDailyLimit: 2 });
  const bilal = w.member(BILAL);

  let finish;
  const slow = photos.scan(bilal, () => new Promise((r) => (finish = r)));
  await assert.rejects(photos.scan(bilal, read(0.001)), /Still reading your last photo/);
  finish({ books: [], costUsd: 0.001 });
  await slow;

  await photos.scan(bilal, read(0.001));
  await assert.rejects(photos.scan(bilal, read(0.001)), PhotoLimitError);
  await photos.scan(w.member(AYESHA), read(0.001)); // others are unaffected

  w.time.now += 86400_000 + 1000;
  await photos.scan(bilal, read(0.001));
});

test('the monthly budget pauses scanning for everyone and alerts admins at 50, 80 and 100%', async () => {
  const { w, photos, read } = await world({ photoMonthlyBudgetUsd: 0.1 });
  const bilal = w.member(BILAL);
  w.transport.clear();

  await photos.scan(bilal, read(0.04));
  assert.equal(w.transport.to(AYESHA).length, 0);
  await photos.scan(bilal, read(0.02)); // 60%
  assert.match(w.transport.to(AYESHA).at(-1).text, /used 50% of this month's limit: \$0\.06 of the \$0\.10 budget, 2 of 300 photos/);
  await photos.scan(bilal, read(0.025)); // 85%
  assert.match(w.transport.to(AYESHA).at(-1).text, /used 80%/);
  await photos.scan(bilal, read(0.02)); // 105%: the call already ran, so it's recorded, then scanning stops
  assert.match(w.transport.to(AYESHA).at(-1).text, /paused for everyone/);
  assert.equal(w.transport.to(AYESHA).length, 3);
  assert.equal(w.transport.to(BILAL).length, 0); // only admins are told

  await assert.rejects(photos.scan(w.member(AYESHA), read(0.01)), /paused until next month/);
  assert.match(await w.say(AYESHA, 'stats'), /Photo scans this month: 4\/300 photos, \$0\.1\d of the \$0\.10 budget/);

  w.time.now += 32 * 86400_000; // next month
  await photos.scan(bilal, read(0.01));
});

test('the monthly photo count is a limit too', async () => {
  const { w, photos, read } = await world({ photoMonthlyLimit: 2 });
  await photos.scan(w.member(BILAL), read(0));
  await photos.scan(w.member(AYESHA), read(0));
  await assert.rejects(photos.scan(w.member(BILAL), read(0)), /paused until next month/);
});

test('admins get a weekly summary on Monday mornings, only in weeks with photos', async () => {
  const { w, photos, read } = await world();
  w.time.now = Date.parse('2026-10-19T03:00:00Z'); // Monday 08:30 in India: too early
  w.store.touchInbound(w.member(AYESHA).id, new Date(w.time.now).toISOString());
  assert.equal(await photos.weeklySummary(), false);

  w.time.now = Date.parse('2026-10-19T05:00:00Z'); // 10:30: no photos this week, so nothing is sent
  assert.equal(await photos.weeklySummary(), false);

  await photos.scan(w.member(BILAL), read(0.002));
  w.time.now = Date.parse('2026-10-26T05:00:00Z'); // next Monday
  w.store.touchInbound(w.member(AYESHA).id, new Date(w.time.now).toISOString());
  assert.equal(await photos.weeklySummary(), true);
  assert.match(w.transport.to(AYESHA).at(-1).text, /Weekly photo scanning check: 1 photos last week, costing \$0\.00/);
  assert.equal(await photos.weeklySummary(), false); // once a week
});

test('budget settings accept currency signs; unreadable values fall back to the default', async () => {
  const load = async (value) => {
    process.env.PHOTO_MONTHLY_BUDGET_USD = value;
    const { config } = await import(`../src/config.js?${encodeURIComponent(value)}`);
    return config.photoMonthlyBudgetUsd;
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await load('4$'), 4);
    assert.equal(await load('$ 2.5'), 2.5);
    assert.equal(await load('four'), 1);
  } finally {
    console.warn = warn;
    delete process.env.PHOTO_MONTHLY_BUDGET_USD;
  }
});

test('a budget that is not a number pauses scanning instead of removing the cap', async () => {
  const { w, photos, read } = await world({ photoMonthlyBudgetUsd: NaN });
  await assert.rejects(photos.scan(w.member(BILAL), read(0)), /paused until next month/);
});
