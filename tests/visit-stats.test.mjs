import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createVisitStats } from '../lib/visit-stats.mjs';
import { createVisitTracker, phoneOs } from '../assets/visit-tracker.mjs';

const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const android = 'Mozilla/5.0 (Linux; Android 16; SM-S938N) AppleWebKit/537.36 SamsungBrowser/29.0 Chrome/140.0.0.0 Mobile Safari/537.36';
const desktop = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const memoryStorage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};
function fixture(start = '2026-10-30T03:00:00Z') {
  let time = Date.parse(start);
  const stats = createVisitStats({ now: () => time });
  return { stats, now: () => time, tick: ms => { time += ms; } };
}

test('daily unique phones are partitioned by OS and first launch mode; IDs are not exposed', () => {
  const { stats } = fixture();
  for (const [number, ua, mode] of [[1, iphone, 'web'], [2, iphone, 'pwa'], [3, android, 'web'], [4, android, 'pwa']]) {
    assert.equal(stats.record({ id: id(number), mode }, ua).registered, true);
    assert.equal(stats.record({ id: id(number), mode }, ua).registered, false);
  }
  stats.record({ id: id(1), mode: 'pwa' }, iphone);
  const result = stats.read();
  assert.equal(result.total, 4);
  assert.deepEqual(result.byOs, { ios: 2, android: 2 });
  assert.deepEqual(result.byMode, { web: 2, pwa: 2 });
  assert.deepEqual(result.breakdown, { ios: { web: 1, pwa: 1 }, android: { web: 1, pwa: 1 } });
  assert.ok(!JSON.stringify(result).includes(id(1)));
});

test('read and write both clear the previous day at Korean midnight, including after idle days', () => {
  const f = fixture('2026-10-30T14:59:59Z');
  const first = f.stats.record({ id: id(1), mode: 'pwa' }, iphone);
  assert.equal(first.date, '2026-10-30');
  assert.equal(first.resetsAt, '2026-10-30T15:00:00.000Z');
  f.tick(1_000);
  const midnight = f.stats.read();
  assert.equal(midnight.date, '2026-10-31');
  assert.equal(midnight.total, 0);
  assert.equal(midnight.startedAt, '2026-10-30T15:00:00.000Z');
  assert.equal(f.stats.record({ id: id(1), mode: 'pwa' }, iphone).total, 1);
  f.tick(3 * 24 * 60 * 60_000);
  const later = f.stats.record({ id: id(1), mode: 'web' }, iphone);
  assert.equal(later.date, '2026-11-03');
  assert.equal(later.total, 1);
  assert.equal(later.byMode.pwa, 0);
});

test('desktop and tablets are excluded; invalid phone submissions cannot change counts', () => {
  const { stats } = fixture();
  for (const ua of [desktop, 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1', 'Mozilla/5.0 (Linux; Android 16; SM-X900) Chrome/140 Safari/537.36']) {
    assert.equal(phoneOs(ua), null);
    assert.equal(stats.record({ id: id(1), mode: 'web' }, ua).total, 0);
  }
  assert.equal(phoneOs(iphone.replace('Safari/604.1', 'CriOS/140.0.0.0 Mobile/15E148 Safari/604.1')), 'ios');
  assert.equal(phoneOs(`${android} KAKAOTALK/26.0`), 'android');
  for (const body of [null, {}, { id: [id(1)], mode: 'web' }, { id: 'invalid', mode: 'web' }, { id: id(1), mode: 'unknown' }]) {
    assert.throws(() => stats.record(body, iphone), { statusCode: 400 });
  }
  assert.equal(stats.read().total, 0);
});

function clientFixture({ storage = memoryStorage(), ua = iphone, standalone = false, canReport = () => true, fetchImpl } = {}) {
  const f = fixture();
  const calls = [];
  let nextId = 0;
  const options = {
    userAgent: ua, storage, now: f.now, canReport, isStandalone: () => standalone, makeId: () => id(++nextId),
    fetchImpl: fetchImpl || (async (url, options) => {
      calls.push({ url, options });
      const value = options.method === 'POST' ? f.stats.record(JSON.parse(options.body), ua) : f.stats.read();
      return new Response(JSON.stringify(value));
    }),
  };
  return { ...f, calls, options, tracker: createVisitTracker(options) };
}

test('relaunches reuse localStorage ID; simultaneous reports share a request and remain unique', async () => {
  const f = clientFixture({ standalone: true });
  await Promise.all([f.tracker.track(), f.tracker.track(), f.tracker.readStats()]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.stats.read().total, 1);
  assert.equal(f.stats.read().byMode.pwa, 1);
  const reopened = createVisitTracker(f.options);
  await reopened.track();
  assert.equal(f.calls.length, 2);
  assert.equal(f.stats.read().total, 1);
  assert.equal(JSON.parse(f.calls[0].options.body).id, JSON.parse(f.calls[1].options.body).id);
  assert.equal(f.calls[0].options.cache, 'no-store');
});

test('reports throttle to five minutes, foreground can re-register, and desktop only reads', async () => {
  const f = clientFixture();
  await f.tracker.track();
  await f.tracker.track();
  assert.equal(f.calls.length, 1);
  f.tick(5 * 60_000);
  await f.tracker.track();
  assert.equal(f.calls.length, 2);
  await f.tracker.track({ force: true });
  assert.equal(f.calls.length, 3);
  const pc = clientFixture({ ua: desktop });
  await pc.tracker.track();
  assert.equal(pc.calls.length, 0);
  assert.equal((await pc.tracker.readStats()).total, 0);
  assert.equal(pc.calls[0].options.method, 'GET');
});

test('the midnight retry uses server time even when the phone clock differs', async () => {
  const f = fixture('2026-10-30T14:59:59Z');
  let calls = 0;
  const tracker = createVisitTracker({
    userAgent: iphone, storage: memoryStorage(), makeId: () => id(1),
    now: () => f.now() + 2 * 60 * 60_000, canReport: () => true, isStandalone: () => true,
    fetchImpl: async (_url, options) => { calls++; return new Response(JSON.stringify(f.stats.record(JSON.parse(options.body), iphone))); },
  });
  await tracker.track();
  f.tick(1_000);
  await tracker.track();
  assert.equal(calls, 2);
  assert.equal(f.stats.read().date, '2026-10-31');
  assert.equal(f.stats.read().total, 1);
});

test('a returning phone re-registers the same ID after server memory is lost', async () => {
  let stats = createVisitStats();
  const tracker = createVisitTracker({
    userAgent: iphone, storage: memoryStorage(), makeId: () => id(1),
    canReport: () => true, isStandalone: () => true,
    fetchImpl: async (_url, options) => new Response(JSON.stringify(stats.record(JSON.parse(options.body), iphone))),
  });
  await tracker.track();
  assert.equal(stats.read().total, 1);
  stats = createVisitStats();
  assert.equal(stats.read().total, 0);
  await tracker.track({ force: true });
  assert.equal(stats.read().total, 1);
});

test('offline and hidden pages do not report; failures back off without losing the ID', async () => {
  let visible = false, fail = true;
  const f = clientFixture({ canReport: () => visible });
  const tracker = createVisitTracker({ ...f.options, fetchImpl: async (...args) => {
    if (fail) throw Error('network unavailable');
    return f.options.fetchImpl(...args);
  } });
  await tracker.track();
  assert.equal(f.calls.length, 0);
  visible = true;
  assert.equal(await tracker.track(), null);
  fail = false;
  await tracker.track();
  assert.equal(f.calls.length, 0);
  f.tick(60_000);
  await tracker.track();
  assert.equal(f.stats.read().total, 1);
});

test('restricted localStorage keeps a session ID and HTTP failures remain retryable', async () => {
  const f = clientFixture({ storage: { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } } });
  await f.tracker.track();
  await f.tracker.track({ force: true });
  assert.equal(f.stats.read().total, 1);
  assert.equal(JSON.parse(f.calls[0].options.body).id, JSON.parse(f.calls[1].options.body).id);
  const failed = clientFixture({ fetchImpl: async () => new Response('{}', { status: 503 }) });
  await assert.rejects(failed.tracker.readStats(), /통계를 불러오지 못했어요/);
  assert.equal(await failed.tracker.track(), null);
});

test('deployed API records and reads the same no-store snapshot and serves the new PWA module', async () => {
  process.env.VERCEL = '1';
  const { default: handler } = await import('../api/[...path].mjs');
  async function call(method, body, ua = iphone, url = '/api/visit-stats') {
    const request = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { method, url, headers: { 'user-agent': ua } });
    let status, headers, data;
    await handler(request, { writeHead(code, value) { status = code; headers = value; }, end(value) { data = value; } });
    return { status, headers, data };
  }
  const before = JSON.parse((await call('GET')).data).total;
  const first = await call('POST', { id: id(99), mode: 'pwa' });
  assert.equal(first.status, 200);
  assert.equal(first.headers['Cache-Control'], 'no-store');
  assert.equal(JSON.parse(first.data).total, before + 1);
  assert.equal(JSON.parse((await call('POST', { id: id(99), mode: 'pwa' })).data).total, before + 1);
  assert.equal(JSON.parse((await call('GET')).data).total, before + 1);
  assert.equal((await call('POST', { id: 'bad', mode: 'web' })).status, 400);
  assert.equal((await call('DELETE')).status, 405);
  const asset = await call('GET', null, desktop, '/assets/visit-tracker.mjs');
  assert.equal(asset.status, 200);
  assert.match(String(asset.data), /createVisitTracker/);
});
