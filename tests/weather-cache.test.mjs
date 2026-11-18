import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { createPostgresWeatherStore } from '../lib/weather-cache-db.mjs';
import { kstDay } from '../assets/weather-domain.mjs';

process.env.VERCEL = '1';
process.env.VERCEL_ENV = 'production';
process.env.DATABASE_URL = 'postgresql://cache-test:private-db-password@localhost/cache-test';
const { requestHandler, resetRawCacheForTest, cachedRawLoad } = await import('../server.mjs');
const db = new PGlite();
const migration = await readFile(new URL('../db/migrations/002_weather_cache.sql', import.meta.url), 'utf8');
await db.exec(migration);
after(() => db.close());

function fixture(t) {
  resetRawCacheForTest();
  t.after(resetRawCacheForTest);
  let clock = Date.parse('2026-11-18T12:00:00+09:00'), mode = 'healthy', calls = 0;
  const warnings = [];
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(console, 'warn', line => warnings.push(line));
  t.mock.method(pg.Pool.prototype, 'query', (sql, values) => db.query(sql, values));
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (mode === 'down') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    if (mode === 'rate-limited') return new Response('private-upstream-body', { status: 429, headers: { 'Retry-After': '120' } });
    if (mode === 'malformed') return new Response('{"hourly":{},"daily":{}}');
    const today = kstDay(new Date(clock));
    const start = Date.parse(`${today}T00:00:00Z`) - 86400000;
    const time = Array.from({ length: 9 * 24 }, (_, i) => new Date(start + i * 3600000).toISOString().slice(0, 16));
    const days = Array.from({ length: 9 }, (_, i) => time[i * 24].slice(0, 10));
    return new Response(JSON.stringify({
      hourly: { time, temperature_2m: time.map(() => 10), apparent_temperature: time.map(() => 9) },
      daily: { time: days, temperature_2m_min: days.map(() => 5), temperature_2m_max: days.map(() => 12),
        sunrise: days.map(day => `${day}T07:00`), sunset: days.map(day => `${day}T17:00`) },
    }));
  });
  return { now: () => clock, tick(ms) { clock += ms; }, setMode(value) { mode = value; }, calls: () => calls, warnings };
}

async function weekly(route = 'olympic') {
  let status, body;
  await requestHandler({ url: '/api/weekly-forecast', method: 'POST', headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ route })); } },
  { writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } });
  return { status, body };
}

test('a new instance restores fresh PostgreSQL weather without calling the failed provider', async t => {
  const f = fixture(t);
  await db.exec('TRUNCATE runcast_weather.forecast_cache');
  const first = await weekly();
  assert.equal(first.status, 200);
  await db.exec(migration); // Setup is safe to repeat with saved weather present.
  resetRawCacheForTest();
  f.setMode('down');
  const restored = await weekly();
  assert.equal(restored.status, 200);
  assert.equal(restored.body.fetchedAt, first.body.fetchedAt);
  assert.equal(restored.body.expiresAt, first.body.expiresAt);
  assert.deepEqual(restored.body.refresh, { stale: false, retryAt: null });
  assert.equal(f.calls(), 1);
  assert.equal(f.warnings.length, 0);
});

test('cold outage fallback retains source timestamps, retries with backoff and recovers cleanly', async t => {
  const f = fixture(t);
  await db.exec('TRUNCATE runcast_weather.forecast_cache');
  const first = await weekly();
  f.tick(30 * 60000 + 1);
  resetRawCacheForTest();
  f.setMode('down');
  const stale = await weekly();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.refresh.stale, true);
  assert.equal(stale.body.fetchedAt, first.body.fetchedAt);
  assert.equal(stale.body.expiresAt, first.body.expiresAt);
  assert.equal(stale.body.refresh.retryAt, new Date(f.now() + 30000).toISOString());
  assert.equal(f.calls(), 2);
  assert.deepEqual((await weekly()).body.refresh, stale.body.refresh);
  assert.equal(f.calls(), 2);
  f.tick(30001);
  f.setMode('healthy');
  const recovered = await weekly();
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.body.refresh, { stale: false, retryAt: null });
  assert.deepEqual(recovered.body.cache, { stale: false, retryAt: null });
  assert.equal(recovered.body.fetchedAt, new Date(f.now()).toISOString());
  resetRawCacheForTest();
  f.setMode('down');
  assert.deepEqual((await weekly()).body.refresh, { stale: false, retryAt: null });
  assert.equal(f.calls(), 3);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /UND_ERR_CONNECT_TIMEOUT/);
});

test('a fresh DB restore releases its in-flight task so the next TTL can refresh', async t => {
  const f = fixture(t);
  await db.exec('TRUNCATE runcast_weather.forecast_cache');
  const first = await weekly();
  resetRawCacheForTest();
  assert.equal((await weekly()).body.fetchedAt, first.body.fetchedAt);
  assert.equal(f.calls(), 1);
  f.tick(30 * 60000 + 1);
  const next = await weekly();
  assert.equal(next.status, 200);
  assert.equal(next.body.fetchedAt, new Date(f.now()).toISOString());
  assert.deepEqual(next.body.refresh, { stale: false, retryAt: null });
  assert.equal(f.calls(), 2);
});

test('fallback rolls forward over Korean midnight and refuses forecasts beyond their coverage', async t => {
  const f = fixture(t);
  await db.exec('TRUNCATE runcast_weather.forecast_cache');
  const first = await weekly();
  f.tick(2 * 86400000);
  resetRawCacheForTest();
  f.setMode('down');
  const stale = await weekly();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.baseDate, '2026-11-20');
  assert.equal(stale.body.daily[0].date, '2026-11-20');
  assert.equal(stale.body.daily.length, 6); // Return only dates actually covered.
  assert.equal(stale.body.pastDaily[0].date, '2026-11-19');
  assert.equal(stale.body.fetchedAt, first.body.fetchedAt);
  f.tick(6 * 86400000);
  resetRawCacheForTest();
  assert.equal((await weekly()).status, 500);
});

test('empty/malformed provider results cannot overwrite the last successful forecast', async t => {
  const f = fixture(t);
  await db.exec('TRUNCATE runcast_weather.forecast_cache');
  const first = await weekly();
  f.tick(30 * 60000 + 1);
  f.setMode('malformed');
  resetRawCacheForTest();
  const stale = await weekly();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.refresh.stale, true);
  assert.equal(stale.body.fetchedAt, first.body.fetchedAt);
  const saved = await db.query('SELECT fetched_at FROM runcast_weather.forecast_cache');
  assert.equal(new Date(saved.rows[0].fetched_at).toISOString(), first.body.fetchedAt);
});

test('missing schema/unavailable DB cannot turn a healthy provider response into an error', async t => {
  const f = fixture(t);
  t.mock.method(pg.Pool.prototype, 'query', async () => {
    throw Object.assign(new Error(process.env.DATABASE_URL), { code: '42P01' });
  });
  const response = await weekly();
  assert.equal(response.status, 200);
  assert.equal(response.body.refresh.stale, false);
  assert.equal(f.calls(), 1);
  assert.equal(f.warnings.length, 2);
  assert.ok(f.warnings.every(line => line.startsWith('[WEATHER_CACHE] ')));
  assert.match(f.warnings[0], /"operation":"read"/);
  assert.match(f.warnings[1], /"operation":"write"/);
  assert.doesNotMatch(f.warnings.join(''), /postgresql|private-db-password|37\.5207|127\.1215/);
});

test('a DB outage still permits an existing memory fallback when the provider is down', async t => {
  const f = fixture(t);
  await db.exec('TRUNCATE runcast_weather.forecast_cache');
  const first = await weekly();
  f.tick(30 * 60000 + 1);
  f.setMode('down');
  t.mock.method(pg.Pool.prototype, 'query', async () => { throw Object.assign(new Error('private-db-error'), { code: 'ECONNREFUSED' }); });
  const stale = await weekly();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.fetchedAt, first.body.fetchedAt);
  assert.equal(stale.body.refresh.stale, true);
  assert.equal(f.warnings.length, 2);
});

test('a first-time outage preserves rate-limit metadata and does not store an error as weather', async t => {
  const f = fixture(t);
  await db.exec('TRUNCATE runcast_weather.forecast_cache');
  f.setMode('rate-limited');
  const response = await weekly();
  assert.equal(response.status, 429);
  assert.equal(response.body.refresh.retryAt, new Date(f.now() + 120000).toISOString());
  assert.equal((await db.query('SELECT count(*)::int AS n FROM runcast_weather.forecast_cache')).rows[0].n, 0);
  await weekly();
  assert.equal(f.calls(), 1);
  assert.equal(f.warnings.length, 1);
});

test('concurrent requests share the DB restore and provider call, while locations stay separate', async t => {
  const f = fixture(t);
  await db.exec('TRUNCATE runcast_weather.forecast_cache');
  let reads = 0, writes = 0;
  t.mock.method(pg.Pool.prototype, 'query', (sql, values) => {
    if (sql.startsWith('SELECT payload')) reads++;
    else writes++;
    return db.query(sql, values);
  });
  const responses = await Promise.all(Array.from({ length: 5 }, () => weekly()));
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(f.calls(), 1);
  assert.equal(reads, 1);
  assert.equal(writes, 1);
  assert.equal((await weekly('seokchon')).body.location.id, 'seokchon');
  assert.equal(f.calls(), 2);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM runcast_weather.forecast_cache')).rows[0].n, 2);
});

test('PostgreSQL protects newer success, isolates environments, and bounds retained locations', async () => {
  await db.exec('TRUNCATE runcast_weather.forecast_cache');
  const clock = Date.parse('2026-11-18T03:00:00Z');
  const store = scope => createPostgresWeatherStore({ query: (sql, values) => db.query(sql, values), scope, now: () => clock });
  const production = store('production'), preview = store('preview');
  const entry = (fetchedAt, value) => ({ value, fetchedAt, expiresAt: fetchedAt + 30 * 60000, staleUntil: fetchedAt + 7 * 86400000 });
  await production.write('same-location', entry(clock, { marker: 'new' }));
  await production.write('same-location', entry(clock - 1000, { marker: 'old' }));
  assert.equal((await production.read('same-location')).value.marker, 'new');
  assert.equal(await preview.read('same-location'), null);
  await preview.write('same-location', entry(clock, { marker: 'preview' }));
  for (let i = 0; i < 125; i++) await production.write(`place-${i}`, entry(clock + i, { i }));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM runcast_weather.forecast_cache WHERE scope=$1', ['production'])).rows[0].n, 120);
  assert.equal((await preview.read('same-location')).value.marker, 'preview');
  await production.write('expired', entry(clock - 8 * 86400000, { marker: 'expired' }));
  assert.equal(await production.read('expired'), null);
});

test('invalid stored weather is ignored and a live result remains usable', async t => {
  fixture(t);
  let written = false;
  const value = await cachedRawLoad('invalid-db-fixture', async () => ({ valid: true }), {
    persistence: { configured: true, read: async () => ({ value: {}, fetchedAt: NaN }), write: async () => { written = true; } },
  });
  assert.deepEqual(value, { valid: true });
  assert.equal(written, true);
});

test('structurally invalid stored provider data is rejected before a fresh restore', async t => {
  const f = fixture(t);
  await db.exec('TRUNCATE runcast_weather.forecast_cache');
  await weekly();
  await db.query('UPDATE runcast_weather.forecast_cache SET payload=$1::jsonb', [JSON.stringify({ hourly: {}, daily: {} })]);
  resetRawCacheForTest();
  const response = await weekly();
  assert.equal(response.status, 200);
  assert.equal(f.calls(), 2);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /CACHE_PAYLOAD_INVALID/);
});
