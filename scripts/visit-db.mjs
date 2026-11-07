import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadRuntimeEnv, visitStatsScope } from '../lib/runtime-env.mjs';
import { createVisitPool } from '../lib/visit-db.mjs';

const environment = await loadRuntimeEnv(fileURLToPath(new URL('../', import.meta.url)));
const action = process.argv[2];
let pool;
try {
  if (!['setup', 'check'].includes(action)) throw Object.assign(new Error(), { code: 'USAGE' });
  const scope = visitStatsScope(environment);
  pool = createVisitPool(environment.DATABASE_URL);
  if (!pool) throw Object.assign(new Error(), { code: 'NO_DATABASE_URL' });
  if (action === 'setup') {
    await pool.query(await readFile(new URL('../db/migrations/001_visit_stats.sql', import.meta.url), 'utf8'));
    await pool.query(`INSERT INTO runcast_stats.visit_stats_state(scope, collection_started_at)
      VALUES ($1, statement_timestamp()) ON CONFLICT (scope) DO NOTHING`, [scope]);
    console.log(`통계 테이블 준비 완료 · 환경: ${scope}`);
  }
  const result = await pool.query(`SELECT
    (SELECT count(*)::integer FROM runcast_stats.visit_daily_counts WHERE scope = $1) AS summary_days,
    (SELECT count(*)::integer FROM runcast_stats.visit_daily_devices WHERE scope = $1) AS recent_devices,
    (SELECT collection_started_at FROM runcast_stats.visit_stats_state WHERE scope = $1) AS collection_started_at,
    (SELECT sum(pg_total_relation_size(format('%I.%I', schemaname, tablename)::regclass))::bigint
       FROM pg_tables WHERE schemaname = 'runcast_stats') AS table_bytes`, [scope]);
  console.log(JSON.stringify({ scope, ...result.rows[0] }, null, 2));
} catch (error) {
  const code = /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'DB_CONNECTION_FAILED';
  console.error(code === 'NO_DATABASE_URL'
    ? 'DATABASE_URL을 .env.local 또는 실행 환경변수에 설정해 주세요. 연결 주소를 공개 파일이나 채팅에 올리지 마세요.'
    : `통계 DB 준비/확인 실패 (${code}). docs/visit-db-setup.md의 연결 설정을 확인해 주세요.`);
  process.exitCode = 1;
} finally { if (pool) await pool.end(); }
