import { createPostgresPool } from './postgres.mjs';
import { diagnosticCodes, diagnosticContext } from './upstream-http.mjs';

export function logWeatherCache(operation, error) {
  console.warn(`[WEATHER_CACHE] ${JSON.stringify({
    version: 'weather-cache-v1', operation, ...diagnosticContext(), errorCodes: diagnosticCodes(error),
  })}`);
}

export function createPostgresWeatherStore({ connectionString = '', query, scope = 'development', now = Date.now } = {}) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(scope)) throw new Error('Invalid weather cache scope');
  let pool;
  function run(sql, values) {
    if (query) return query(sql, values);
    if (!connectionString) throw Object.assign(new Error('Weather database is not configured'), { code: 'DB_NOT_CONFIGURED' });
    pool ??= createPostgresPool(connectionString, {
      application_name: 'runcast-weather-cache',
      connectionTimeoutMillis: 2_000, statement_timeout: 2_000, query_timeout: 2_000,
    });
    return pool.query(sql, values);
  }
  return {
    configured: Boolean(connectionString || query),
    async read(key) {
      const { rows } = await run(`SELECT payload, fetched_at, expires_at, stale_until
        FROM runcast_weather.forecast_cache
        WHERE scope = $1 AND cache_key = $2 AND stale_until > $3::timestamptz`, [scope, key, new Date(now()).toISOString()]);
      const row = rows[0];
      return row ? { value: row.payload, fetchedAt: +new Date(row.fetched_at), expiresAt: +new Date(row.expires_at), staleUntil: +new Date(row.stale_until) } : null;
    },
    async write(key, entry) {
      // Cleanup and upsert are one bounded statement. Other keys are pruned
      // best-effort to 119, leaving room for this key (120 per environment).
      // A late request from another instance cannot replace newer weather.
      await run(`WITH cleanup AS (
        DELETE FROM runcast_weather.forecast_cache
        WHERE scope = $1 AND cache_key <> $2 AND (stale_until <= $7::timestamptz OR cache_key IN (
          SELECT cache_key FROM runcast_weather.forecast_cache
          WHERE scope = $1 AND cache_key <> $2
          ORDER BY fetched_at DESC, cache_key OFFSET 119
        ))
      )
      INSERT INTO runcast_weather.forecast_cache AS current (scope, cache_key, payload, fetched_at, expires_at, stale_until)
      VALUES ($1, $2, $3::jsonb, $4::timestamptz, $5::timestamptz, $6::timestamptz)
      ON CONFLICT (scope, cache_key) DO UPDATE SET
        payload = EXCLUDED.payload, fetched_at = EXCLUDED.fetched_at,
        expires_at = EXCLUDED.expires_at, stale_until = EXCLUDED.stale_until
      WHERE EXCLUDED.fetched_at > current.fetched_at`, [
        scope, key, JSON.stringify(entry.value), new Date(entry.fetchedAt).toISOString(),
        new Date(entry.expiresAt).toISOString(), new Date(entry.staleUntil).toISOString(), new Date(now()).toISOString(),
      ]);
    },
    async close() { if (pool) await pool.end(); },
  };
}
