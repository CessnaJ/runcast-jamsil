import pg from 'pg';

export function createVisitPool(connectionString) {
  if (!connectionString) return null;
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid database URL');
  // Keep certificate/hostname verification explicit across pg driver versions.
  if (['prefer', 'require', 'verify-ca'].includes(url.searchParams.get('sslmode')) && !url.searchParams.has('uselibpqcompat')) url.searchParams.set('sslmode', 'verify-full');
  const pool = new pg.Pool({
    connectionString: url.toString(), max: 2, connectionTimeoutMillis: 6_000,
    idleTimeoutMillis: 1_000, allowExitOnIdle: true,
    statement_timeout: 5_000, query_timeout: 7_000,
    application_name: 'runcast-visit-stats',
  });
  // Failed idle connections must not crash the weather API or log credentials.
  pool.on('error', () => {});
  return pool;
}

export const READ_VISITS_SQL = `
  WITH clock AS (
    SELECT COALESCE($3::timestamptz, statement_timestamp()) AS as_of
  ), period AS (
    SELECT as_of, (as_of AT TIME ZONE 'Asia/Seoul')::date AS today FROM clock
  )
  SELECT (p.today - n.day_offset)::text AS date,
    p.as_of, s.collection_started_at,
    ((p.today + 1)::timestamp AT TIME ZONE 'Asia/Seoul') AS resets_at,
    s.collection_started_at IS NOT NULL
      AND p.today - n.day_offset >= (s.collection_started_at AT TIME ZONE 'Asia/Seoul')::date AS collected,
    COALESCE(c.ios_web, 0) AS ios_web, COALESCE(c.ios_pwa, 0) AS ios_pwa,
    COALESCE(c.android_web, 0) AS android_web, COALESCE(c.android_pwa, 0) AS android_pwa
  FROM period p CROSS JOIN generate_series(0, $2::integer - 1) AS n(day_offset)
  LEFT JOIN runcast_stats.visit_stats_state s ON s.scope = $1
  LEFT JOIN runcast_stats.visit_daily_counts c ON c.scope = $1 AND c.day = p.today - n.day_offset
  ORDER BY date`;

export function createPostgresVisitStore({ connectionString = '', query, now } = {}) {
  let pool;
  function run(sql, values) {
    if (query) return query(sql, values);
    if (!connectionString) throw Object.assign(new Error('Statistics database is not configured'), { publicCode: 'STATS_DB_NOT_CONFIGURED' });
    pool ??= createVisitPool(connectionString);
    return pool.query(sql, values);
  }
  const at = () => now ? new Date(now()).toISOString() : null;
  return {
    configured: Boolean(connectionString || query),
    async read({ scope, days, asOf = at() }) {
      return (await run(READ_VISITS_SQL, [scope, days, asOf])).rows;
    },
    async record({ scope, id, category }) {
      const { rows } = await run('SELECT * FROM runcast_stats.record_visit($1::text, $2::uuid, $3::smallint, $4::timestamptz)', [scope, id, category, at()]);
      return { registered: rows[0].registered, asOf: rows[0].as_of };
    },
    async close() { if (pool) await pool.end(); },
  };
}
