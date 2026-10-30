const ID_KEY = 'runcast.visitor.v1';
const REPORT_INTERVAL = 5 * 60_000;
const RETRY_INTERVAL = 60_000;
export const VISITOR_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function phoneOs(userAgent = '') {
  if (/iPhone/i.test(userAgent)) return 'ios';
  if (/Android/i.test(userAgent) && /Mobile/i.test(userAgent)) return 'android';
  return null;
}

function randomId() {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createVisitTracker({
  userAgent = globalThis.navigator?.userAgent || '',
  fetchImpl = (...args) => globalThis.fetch(...args),
  storage,
  makeId = randomId,
  now = Date.now,
  canReport = () => globalThis.document?.visibilityState === 'visible' && globalThis.navigator?.onLine !== false,
  isStandalone = () => globalThis.navigator?.standalone === true || globalThis.matchMedia?.('(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui), (display-mode: window-controls-overlay)').matches === true,
} = {}) {
  const os = phoneOs(userAgent);
  let id, pending = null, nextAttemptAt = 0;

  function visitorId() {
    if (id) return id;
    try {
      const saved = (storage || globalThis.localStorage)?.getItem(ID_KEY);
      if (VISITOR_ID_PATTERN.test(saved || '')) id = saved.toLowerCase();
    } catch {}
    if (!id) {
      id = makeId();
      try { (storage || globalThis.localStorage)?.setItem(ID_KEY, id); } catch {}
    }
    return id;
  }

  async function request(options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetchImpl('/api/visit-stats', { ...options, cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('통계를 불러오지 못했어요.');
      return await response.json();
    } finally { clearTimeout(timeout); }
  }

  function readStats() {
    if (!os) return request({ method: 'GET' });
    if (pending) return pending;
    pending = Promise.resolve().then(() => request({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: visitorId(), mode: isStandalone() ? 'pwa' : 'web' }),
    })).then(stats => {
      const untilMidnight = Date.parse(stats.resetsAt) - Date.parse(stats.asOf);
      nextAttemptAt = now() + Math.min(REPORT_INTERVAL, Math.max(0, untilMidnight));
      return stats;
    }).catch(error => {
      nextAttemptAt = now() + RETRY_INTERVAL;
      throw error;
    }).finally(() => { pending = null; });
    return pending;
  }

  async function track({ force = false } = {}) {
    if (!os || !canReport() || (!force && now() < nextAttemptAt)) return null;
    try { return await readStats(); } catch { return null; }
  }

  // Keep only the ID across launches. A daily "sent" flag would suppress
  // re-registration after a serverless instance loses its in-memory cache.
  return { track, readStats };
}
