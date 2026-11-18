import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshScheduler } from '../assets/refresh-scheduler.mjs';
import { kstDay } from '../assets/weather-domain.mjs';

process.env.VERCEL = '1';
const { requestHandler, resetRawCacheForTest } = await import('../server.mjs');

async function weekly() {
  let status, body;
  await requestHandler({ url: '/api/weekly-forecast', method: 'POST', headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); } },
  { writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } });
  return { status, body };
}

function providerFixture(t) {
  resetRawCacheForTest();
  t.after(resetRawCacheForTest);
  let clock = Date.now(), failed = false, calls = 0;
  const today = kstDay(new Date(clock));
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (failed) return new Response('{}', { status: 503 });
    return new Response(JSON.stringify({
      hourly: { time: [`${today}T00:00`, `${today}T01:00`], temperature_2m: [10, 11] },
      daily: { time: [today], temperature_2m_min: [10], temperature_2m_max: [11],
        sunrise: [`${today}T07:00`], sunset: [`${today}T17:00`] },
    }));
  });
  return { now: () => clock, tick(ms) { clock += ms; }, fail(value) { failed = value; }, calls: () => calls };
}

function assertRecovered(body, clock) {
  assert.deepEqual(body.refresh, { stale: false, retryAt: null });
  assert.deepEqual(body.cache, { stale: false, retryAt: null });
  assert.equal(body.fetchedAt, new Date(clock.now()).toISOString());
}

test('weekly recovery clears the previous failed request retry time', async t => {
  const clock = providerFixture(t);
  clock.fail(true);
  assert.equal((await weekly()).status, 503);
  clock.tick(30_001);
  clock.fail(false);
  const recovered = await weekly();
  assert.equal(recovered.status, 200);
  assertRecovered(recovered.body, clock);
  const scheduler = createRefreshScheduler({ now: clock.now, storage: { read: () => null, write() {} } });
  const outcome = await scheduler.request('weekly', 'fixture', { fetcher: async () => recovered.body });
  assert.equal(outcome.stale, false);
  assert.equal(outcome.meta.lastOutcome, 'success');
});

test('weekly fallback stays stale during failure and clears stale state after recovery', async t => {
  const clock = providerFixture(t);
  const first = await weekly();
  assert.equal(first.status, 200);
  clock.tick(30 * 60_000 + 1);
  clock.fail(true);
  const stale = await weekly();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.refresh.stale, true);
  assert.ok(stale.body.refresh.retryAt);
  assert.equal(stale.body.fetchedAt, first.body.fetchedAt);
  assert.deepEqual((await weekly()).body.refresh, stale.body.refresh);
  assert.equal(clock.calls(), 2);
  clock.tick(30_001);
  clock.fail(false);
  const recovered = await weekly();
  assert.equal(recovered.status, 200);
  assertRecovered(recovered.body, clock);
  assert.equal(clock.calls(), 3);
  assertRecovered((await weekly()).body, clock);
  assert.equal(clock.calls(), 3);
});
