import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadRuntimeEnv } from '../lib/runtime-env.mjs';
import { createPostgresPool } from '../lib/postgres.mjs';
import { diagnosticCodes } from '../lib/upstream-http.mjs';

const environment = await loadRuntimeEnv(fileURLToPath(new URL('../', import.meta.url)));
const scope = environment.VERCEL_ENV || (environment.VERCEL ? 'production' : 'development');
let pool;
try {
  const action = process.argv[2];
  if (!['setup', 'check'].includes(action)) throw Object.assign(new Error(), { code: 'USAGE' });
  pool = createPostgresPool(environment.DATABASE_URL);
  if (!pool) throw Object.assign(new Error(), { code: 'NO_DATABASE_URL' });
  if (action === 'setup') {
    await pool.query(await readFile(new URL('../db/migrations/002_weather_cache.sql', import.meta.url), 'utf8'));
    console.log('주간 예보 저장 테이블 준비 완료');
  }
  const { rows } = await pool.query(`SELECT count(*)::integer AS entries,
    count(*) FILTER (WHERE expires_at > statement_timestamp())::integer AS fresh_entries,
    count(*) FILTER (WHERE stale_until > statement_timestamp())::integer AS usable_entries,
    max(fetched_at) AS latest_fetched_at,
    pg_total_relation_size('runcast_weather.forecast_cache')::bigint AS table_bytes
    FROM runcast_weather.forecast_cache WHERE scope = $1`, [scope]);
  console.log(JSON.stringify({ scope, ...rows[0] }, null, 2));
} catch (error) {
  const code = diagnosticCodes(error)[0] || 'DB_CONNECTION_FAILED';
  console.error(`주간 예보 DB 준비/확인 실패 (${code}). docs/weather-cache-setup.md를 확인해 주세요.`);
  process.exitCode = 1;
} finally { if (pool) await pool.end(); }
