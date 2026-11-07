import { phoneOs, VISITOR_ID_PATTERN } from '../assets/visit-tracker.mjs';
import { createPostgresVisitStore } from './visit-db.mjs';

export const VISIT_ACK_VERSION = 'postgres-v1';
const iso = value => value ? new Date(value).toISOString() : null;
const badRequest = () => Object.assign(new Error('올바른 집계 정보가 필요해요.'), { statusCode: 400 });

export function createVisitStats({ store = createPostgresVisitStore(), scope = 'development' } = {}) {
  async function database(operation) {
    try {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(scope)) throw new Error('Invalid scope');
      return await operation();
    } catch (error) {
      const missing = error.publicCode === 'STATS_DB_NOT_CONFIGURED';
      throw Object.assign(new Error(missing ? '통계를 준비하고 있어요.' : '통계를 불러오지 못했어요. 잠시 후 다시 눌러 주세요.'), {
        statusCode: 503, publicCode: missing ? 'STATS_DB_NOT_CONFIGURED' : 'STATS_UNAVAILABLE',
      });
    }
  }

  async function read({ days = 14, asOf } = {}) {
    if (!Number.isInteger(days) || days < 1 || days > 14) throw badRequest();
    return database(async () => {
      const rows = await store.read({ scope, days, asOf });
      const history = rows.map(row => {
        const count = name => row.collected ? Number(row[name]) : null;
        const sum = (...values) => row.collected ? values.reduce((a, b) => a + b, 0) : null;
        const breakdown = { ios: { web: count('ios_web'), pwa: count('ios_pwa') }, android: { web: count('android_web'), pwa: count('android_pwa') } };
        return {
          date: row.date, collected: Boolean(row.collected),
          partial: Boolean(row.collected && row.date === new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(row.collection_started_at))),
          total: sum(breakdown.ios.web, breakdown.ios.pwa, breakdown.android.web, breakdown.android.pwa),
          byOs: { ios: sum(breakdown.ios.web, breakdown.ios.pwa), android: sum(breakdown.android.web, breakdown.android.pwa) },
          byMode: { web: sum(breakdown.ios.web, breakdown.android.web), pwa: sum(breakdown.ios.pwa, breakdown.android.pwa) }, breakdown,
        };
      });
      const today = rows.at(-1);
      return {
        ...history.at(-1), schemaVersion: 2, storage: 'postgres', ackVersion: VISIT_ACK_VERSION,
        timeZone: 'Asia/Seoul', retentionDays: 14,
        startedAt: iso(today.collection_started_at), asOf: iso(today.as_of), resetsAt: iso(today.resets_at), history,
      };
    });
  }

  async function record(body, userAgent) {
    const os = phoneOs(userAgent);
    if (!os) return { ...await read(), registered: false };
    if (typeof body?.id !== 'string' || !VISITOR_ID_PATTERN.test(body.id) || !['web', 'pwa'].includes(body?.mode)) throw badRequest();
    const { registered, asOf } = await database(() => store.record({
      scope, id: body.id.toLowerCase(), category: (os === 'android' ? 2 : 0) + (body.mode === 'pwa' ? 1 : 0),
    }));
    // Read after the write commits so previous PWA versions still receive today's totals.
    return { ...await read({ days: 1, asOf }), registered };
  }
  return { read, record, configured: store.configured };
}
