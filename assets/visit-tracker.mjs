const ID_KEY = 'runcast.visitor.v1';
const ACK_KEY = 'runcast.visit.ack.v2';
const ACK_VERSION = 'postgres-v1';
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
  let id, acknowledgment, pending = null, nextAttemptAt = 0;

  function acknowledged() {
    if (!acknowledgment) {
      try { acknowledgment = JSON.parse((storage || globalThis.localStorage)?.getItem(ACK_KEY) || 'null'); } catch {}
    }
    return acknowledgment?.version === ACK_VERSION && acknowledgment.id === visitorId()
      && now() >= acknowledgment.savedAt && now() < acknowledgment.expiresAt
      && acknowledgment.expiresAt - acknowledgment.savedAt <= 24 * 60 * 60_000;
  }

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

  async function request(options, history = false) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetchImpl(`/api/visit-stats${history ? '?days=14' : ''}`, { ...options, cache: 'no-store', signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error('통계를 불러오지 못했어요.'), { code: data.code });
      return data;
    } finally { clearTimeout(timeout); }
  }

  function report({ manual = false } = {}) {
    if (!os || !canReport() || acknowledged()) return Promise.resolve(null);
    if (pending) return pending;
    if (!manual && now() < nextAttemptAt) return Promise.resolve(null);
    const sentAt = now();
    pending = Promise.resolve().then(() => request({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: visitorId(), mode: isStandalone() ? 'pwa' : 'web' }),
    })).then(stats => {
      const untilMidnight = Date.parse(stats.resetsAt) - Date.parse(stats.asOf);
      if (stats.ackVersion === ACK_VERSION && Number.isFinite(untilMidnight) && untilMidnight > 0 && untilMidnight <= 24 * 60 * 60_000) {
        acknowledgment = { version: ACK_VERSION, id: visitorId(), savedAt: sentAt, expiresAt: sentAt + untilMidnight };
        try { (storage || globalThis.localStorage)?.setItem(ACK_KEY, JSON.stringify(acknowledgment)); } catch {}
      } else nextAttemptAt = now() + RETRY_INTERVAL;
      return stats;
    }).catch(error => {
      nextAttemptAt = now() + RETRY_INTERVAL;
      throw error;
    }).finally(() => { pending = null; });
    return pending;
  }

  async function track() {
    try { return await report(); } catch { return null; }
  }

  async function readStats() {
    try { await report({ manual: true }); } catch {}
    return request({ method: 'GET' }, true);
  }

  // The database is authoritative; the acknowledgment only reduces requests.
  return { track, readStats };
}
