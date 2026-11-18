import pg from 'pg';

export function createPostgresPool(connectionString, options = {}) {
  if (!connectionString) return null;
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid database URL');
  // Keep certificate/hostname verification explicit across pg driver versions.
  if (['prefer', 'require', 'verify-ca'].includes(url.searchParams.get('sslmode')) && !url.searchParams.has('uselibpqcompat')) url.searchParams.set('sslmode', 'verify-full');
  const pool = new pg.Pool({
    connectionString: url.toString(), max: 2, connectionTimeoutMillis: 6_000,
    idleTimeoutMillis: 1_000, allowExitOnIdle: true,
    statement_timeout: 5_000, query_timeout: 7_000,
    application_name: 'runcast-visit-stats', ...options,
  });
  // Failed idle connections must not crash the weather API or log credentials.
  pool.on('error', () => {});
  return pool;
}
