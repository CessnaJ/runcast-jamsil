import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
import { createPostgresVisitStore, READ_VISITS_SQL } from '../lib/visit-db.mjs';
import { createVisitStats } from '../lib/visit-stats.mjs';
import { loadRuntimeEnv, visitStatsScope } from '../lib/runtime-env.mjs';
import { createVisitTracker, phoneOs } from '../assets/visit-tracker.mjs';

const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const android = 'Mozilla/5.0 (Linux; Android 16; SM-S938N) AppleWebKit/537.36 SamsungBrowser/29.0 Chrome/140.0.0.0 Mobile Safari/537.36';
const desktop = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const memoryStorage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};
const db = new PGlite();
const migration = await readFile(new URL('../db/migrations/001_visit_stats.sql', import.meta.url), 'utf8');
await db.exec(migration);
after(() => db.close());
let nextScope = 0;
function fixture(start = '2026-10-30T03:00:00Z') {
  let time = Date.parse(start);
  const scope = `test_${++nextScope}`;
  const options = { query: (sql, values) => db.query(sql, values), now: () => time };
  const store = createPostgresVisitStore(options);
  const stats = createVisitStats({ store, scope });
  return { stats, store, scope, now: () => time, tick: ms => { time += ms; }, restart: () => createVisitStats({ store: createPostgresVisitStore(options), scope }) };
}

test('migration is repeatable and concurrent/retried visits increment once in PostgreSQL', async () => {
  await db.exec(migration);
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 12 }, () => f.stats.record({ id: id(1), mode: 'web' }, iphone)));
  assert.equal(results.filter(result => result.registered).length, 1);
  for (const [number, ua, mode] of [[2, iphone, 'pwa'], [3, android, 'web'], [4, android, 'pwa']]) {
    await f.stats.record({ id: id(number), mode }, ua);
  }
  await f.stats.record({ id: id(1), mode: 'pwa' }, iphone);
  const result = await f.restart().read();
  assert.equal(result.total, 4);
  assert.deepEqual(result.byOs, { ios: 2, android: 2 });
  assert.deepEqual(result.byMode, { web: 2, pwa: 2 });
  assert.deepEqual(result.breakdown, { ios: { web: 1, pwa: 1 }, android: { web: 1, pwa: 1 } });
  assert.equal(result.history.length, 14);
  assert.ok(!JSON.stringify(result).includes(id(1)));
  assert.equal((await f.restart().record({ id: id(1), mode: 'web' }, iphone)).registered, false);
});

test('Korean noon does not reset; midnight, month/year changes retain previous summaries', async () => {
  const f = fixture('2026-12-31T02:59:59Z');
  await f.stats.record({ id: id(1), mode: 'pwa' }, iphone);
  f.tick(1_000);
  assert.equal((await f.stats.read()).total, 1);
  f.tick(12 * 60 * 60_000);
  const midnight = await f.stats.read();
  assert.equal(midnight.date, '2027-01-01');
  assert.equal(midnight.total, 0);
  assert.equal(midnight.resetsAt, '2027-01-01T15:00:00.000Z');
  assert.equal(midnight.history.at(-2).total, 1);
  assert.equal((await f.stats.record({ id: id(1), mode: 'web' }, iphone)).total, 1);
  f.tick(3 * 24 * 60 * 60_000);
  const later = await f.stats.read();
  assert.equal(later.total, 0);
  assert.equal(later.history.find(day => day.date === '2027-01-01').total, 1);
});

test('first successful write cleans only IDs outside the 14-day window; daily counts survive', async () => {
  const f = fixture();
  await f.stats.record({ id: id(1), mode: 'web' }, iphone);
  f.tick(13 * 24 * 60 * 60_000);
  await f.stats.record({ id: id(1), mode: 'web' }, iphone);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM runcast_stats.visit_daily_devices WHERE scope=$1', [f.scope])).rows[0].n, 2);
  f.tick(24 * 60 * 60_000);
  await Promise.all([1, 2, 3].map(number => f.stats.record({ id: id(number), mode: 'pwa' }, android)));
  const devices = await db.query('SELECT day::text FROM runcast_stats.visit_daily_devices WHERE scope=$1 ORDER BY day', [f.scope]);
  assert.equal(devices.rows.length, 4);
  assert.equal(devices.rows[0].day, '2026-11-12');
  assert.equal((await db.query('SELECT sum(ios_web+ios_pwa+android_web+android_pwa)::int AS n FROM runcast_stats.visit_daily_counts WHERE scope=$1', [f.scope])).rows[0].n, 5);
});

test('a counter failure rolls back the ID and cleanup state, allowing a safe retry', async () => {
  const f = fixture();
  await f.stats.record({ id: id(1), mode: 'web' }, iphone);
  f.tick(14 * 24 * 60 * 60_000);
  await db.exec('ALTER TABLE runcast_stats.visit_daily_counts ADD CONSTRAINT simulated_failure CHECK (android_pwa=0) NOT VALID');
  await assert.rejects(f.stats.record({ id: id(2), mode: 'pwa' }, android), { statusCode: 503 });
  const old = (await db.query('SELECT day::text FROM runcast_stats.visit_daily_devices WHERE scope=$1', [f.scope])).rows;
  assert.deepEqual(old, [{ day: '2026-10-30' }]);
  await db.exec('ALTER TABLE runcast_stats.visit_daily_counts DROP CONSTRAINT simulated_failure');
  assert.equal((await f.stats.record({ id: id(2), mode: 'pwa' }, android)).total, 1);
});

test('unknown days, real zero days and environment scopes are distinguished', async () => {
  const f = fixture();
  assert.equal((await f.stats.read()).total, null);
  await f.stats.record({ id: id(1), mode: 'pwa' }, iphone);
  const sameDbPreview = createVisitStats({ store: f.store, scope: `${f.scope}_preview` });
  assert.equal((await sameDbPreview.read()).total, null);
  const result = await f.stats.read();
  assert.equal(result.history[0].total, null);
  assert.equal(result.history.at(-1).partial, true);
  f.tick(24 * 60 * 60_000);
  assert.equal((await f.stats.read()).total, 0);
});

test('desktop/tablets are excluded and invalid phone submissions cannot write', async () => {
  const f = fixture();
  for (const ua of [desktop, 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1', 'Mozilla/5.0 (Linux; Android 16; SM-X900) Chrome/140 Safari/537.36']) {
    assert.equal(phoneOs(ua), null);
    assert.equal((await f.stats.record({ id: id(1), mode: 'web' }, ua)).registered, false);
  }
  assert.equal(phoneOs(iphone.replace('Safari/604.1', 'CriOS/140.0.0.0 Mobile/15E148 Safari/604.1')), 'ios');
  assert.equal(phoneOs(`${android} KAKAOTALK/26.0`), 'android');
  for (const body of [null, {}, { id: [id(1)], mode: 'web' }, { id: 'invalid', mode: 'web' }, { id: id(1), mode: 'unknown' }]) {
    await assert.rejects(f.stats.record(body, iphone), { statusCode: 400 });
  }
  for (const days of [0, -1, 15, 1.5, NaN]) await assert.rejects(f.stats.read({ days }), { statusCode: 400 });
  assert.equal((await f.stats.read()).total, null);
});

test('20 years of aggregates plus 100 devices/day occupy little space and use the day index', async t => {
  const scope = 'capacity';
  await db.query(`INSERT INTO runcast_stats.visit_stats_state VALUES ($1, '2006-11-07T00:00:00Z', NULL)`, [scope]);
  await db.query(`INSERT INTO runcast_stats.visit_daily_counts(scope,day,ios_web,ios_pwa,android_web,android_pwa)
    SELECT $1, d::date, 25,25,25,25 FROM generate_series('2006-11-07'::date,'2026-11-07'::date,'1 day') AS d`, [scope]);
  await db.query(`INSERT INTO runcast_stats.visit_daily_devices(scope,day,visitor_id,category)
    SELECT $1,d::date,('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,(n%4)::smallint
    FROM generate_series('2026-10-25'::date,'2026-11-07'::date,'1 day') AS d CROSS JOIN generate_series(1,100) AS n`, [scope]);
  await db.exec('VACUUM ANALYZE runcast_stats.visit_daily_counts');
  await db.exec('VACUUM ANALYZE runcast_stats.visit_daily_devices');
  const bytes = Number((await db.query(`SELECT sum(pg_total_relation_size(format('%I.%I',schemaname,tablename)::regclass)) AS bytes FROM pg_tables WHERE schemaname='runcast_stats'`)).rows[0].bytes);
  t.diagnostic(`All stats tables and indexes including test fixtures: ${bytes} bytes`);
  assert.ok(bytes < 5 * 1024 * 1024);
  const queryPlan = await db.query(`EXPLAIN ${READ_VISITS_SQL}`, [scope, 14, '2026-11-07T03:00:00Z']);
  assert.match(JSON.stringify(queryPlan.rows), /Index.*visit_daily_counts|visit_daily_counts_pkey/);
  assert.equal((await db.query(READ_VISITS_SQL, [scope, 14, '2026-11-07T03:00:00Z'])).rows.length, 14);
});

function clientFixture({ storage = memoryStorage(), ua = iphone, standalone = false, canReport = () => true, fetchImpl } = {}) {
  const f = fixture();
  const calls = [];
  const options = {
    userAgent: ua, storage, now: f.now, canReport, isStandalone: () => standalone, makeId: () => id(101),
    fetchImpl: fetchImpl || (async (url, options) => {
      calls.push({ url, options });
      const value = options.method === 'POST' ? await f.stats.record(JSON.parse(options.body), ua) : await f.stats.read();
      return new Response(JSON.stringify(value));
    }),
  };
  return { ...f, calls, options, tracker: createVisitTracker(options) };
}

test('durable daily acknowledgment avoids writes across relaunches and concurrent calls', async () => {
  const f = clientFixture({ standalone: true });
  await Promise.all([f.tracker.track(), f.tracker.track(), f.tracker.readStats()]);
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal((await f.stats.read()).byMode.pwa, 1);
  await createVisitTracker(f.options).track();
  await f.tracker.track({ force: true });
  assert.equal(f.calls.length, 2);
  await f.tracker.readStats();
  assert.equal(f.calls.at(-1).url, '/api/visit-stats?days=14');
  assert.equal(f.calls.at(-1).options.method, 'GET');
  assert.equal(f.calls[0].options.cache, 'no-store');
  assert.deepEqual(Object.keys(JSON.parse(f.calls[0].options.body)), ['id', 'mode']);
});

test('midnight registration uses server-relative time even with a wrong phone clock and relaunch', async () => {
  const f = fixture('2026-12-31T14:59:59Z');
  const storage = memoryStorage();
  let calls = 0;
  const options = {
    userAgent: iphone, storage, makeId: () => id(1),
    now: () => f.now() + 2 * 60 * 60_000, canReport: () => true, isStandalone: () => true,
    fetchImpl: async (_url, options) => { calls++; return new Response(JSON.stringify(await f.stats.record(JSON.parse(options.body), iphone))); },
  };
  await createVisitTracker(options).track();
  await createVisitTracker(options).track();
  assert.equal(calls, 1);
  f.tick(1_000);
  await createVisitTracker(options).track();
  assert.equal(calls, 2);
  assert.equal((await f.stats.read()).date, '2027-01-01');
  assert.equal((await f.stats.read()).total, 1);
});

test('legacy in-memory acknowledgments never suppress database registration', async () => {
  const f = clientFixture();
  let legacy = true;
  const tracker = createVisitTracker({ ...f.options, fetchImpl: async (...args) => {
    const response = await f.options.fetchImpl(...args);
    const data = await response.json();
    if (legacy) delete data.ackVersion;
    return new Response(JSON.stringify(data));
  } });
  await tracker.track();
  f.tick(60_000);
  legacy = false;
  await tracker.track();
  await tracker.track();
  assert.equal(f.calls.length, 2);
  assert.equal((await f.stats.read()).total, 1);
});

test('offline/hidden pages skip reports; errors back off and restricted storage keeps session ID', async () => {
  let visible = false, fail = true;
  const f = clientFixture({ canReport: () => visible, storage: { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } } });
  const tracker = createVisitTracker({ ...f.options, fetchImpl: async (...args) => {
    if (fail) throw Error('network unavailable');
    return f.options.fetchImpl(...args);
  } });
  await tracker.track(); assert.equal(f.calls.length, 0);
  visible = true;
  await tracker.track(); fail = false;
  await tracker.track(); assert.equal(f.calls.length, 0);
  f.tick(60_000);
  await tracker.track();
  await tracker.track(); assert.equal(f.calls.length, 1);
  f.tick(24 * 60 * 60_000);
  await tracker.track();
  assert.equal(JSON.parse(f.calls[0].options.body).id, JSON.parse(f.calls[1].options.body).id);
  const pc = clientFixture({ ua: desktop });
  await pc.tracker.track(); assert.equal(pc.calls.length, 0);
  await pc.tracker.readStats(); assert.equal(pc.calls[0].options.method, 'GET');
});

test('missing/failed DB returns safe unavailability without memory fallback or credential leaks', async () => {
  await assert.rejects(createVisitStats().read(), { statusCode: 503, publicCode: 'STATS_DB_NOT_CONFIGURED' });
  const store = createPostgresVisitStore({ query: () => { throw Error('postgres://user:secret@host/db'); } });
  await assert.rejects(createVisitStats({ store }).read(), error => error.statusCode === 503 && !error.message.includes('secret'));
  const broken = clientFixture({ fetchImpl: async () => new Response(JSON.stringify({ code: 'STATS_DB_NOT_CONFIGURED' }), { status: 503 }) });
  await assert.rejects(broken.tracker.readStats(), { code: 'STATS_DB_NOT_CONFIGURED' });
});

test('runtime env keeps DB private and defaults scopes to Vercel environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runcast-stats-env-'));
  try {
    await writeFile(join(root, '.env'), 'DATABASE_URL=base\n');
    await writeFile(join(root, '.env.local'), 'DATABASE_URL="local"\n');
    assert.equal((await loadRuntimeEnv(root, {})).DATABASE_URL, 'local');
    assert.equal((await loadRuntimeEnv(root, { DATABASE_URL: 'process' })).DATABASE_URL, 'process');
    assert.equal((await loadRuntimeEnv(root, { VERCEL: '1' })).DATABASE_URL, undefined);
    assert.equal(visitStatsScope({ VERCEL: '1', VERCEL_ENV: 'preview' }), 'preview');
    assert.equal(visitStatsScope({ VERCEL: '1' }), 'production');
    assert.equal(visitStatsScope({}), 'development');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('deployed API handles unconfigured DB safely while config/static/weather routes still work', async () => {
  process.env.VERCEL = '1';
  delete process.env.DATABASE_URL;
  const { default: handler } = await import('../api/[...path].mjs');
  async function call(method, body, url = '/api/visit-stats') {
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { method, url, headers: { 'user-agent': iphone } });
    let status, headers, data;
    await handler(req, { writeHead(code, value) { status = code; headers = value; }, end(value) { data = value; } });
    return { status, headers, data };
  }
  const read = await call('GET');
  assert.equal(read.status, 503);
  assert.equal(read.headers['Cache-Control'], 'no-store');
  assert.equal(JSON.parse(read.data).code, 'STATS_DB_NOT_CONFIGURED');
  assert.equal((await call('GET', null, '/api/visit-stats?days=999')).status, 400);
  assert.equal((await call('POST', { id: 'bad', mode: 'web' })).status, 400);
  assert.equal((await call('DELETE')).status, 405);
  assert.equal((await call('GET', null, '/api/config')).status, 200);
  assert.equal((await call('GET', null, '/assets/visit-tracker.mjs')).status, 200);
  assert.equal((await call('GET', null, '/db/migrations/001_visit_stats.sql')).status, 404);
  assert.equal((await call('GET', null, '/.env.local')).status, 404);
});
