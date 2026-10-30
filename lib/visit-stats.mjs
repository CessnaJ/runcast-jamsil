import { phoneOs, VISITOR_ID_PATTERN } from '../assets/visit-tracker.mjs';

const DAY_MS = 24 * 60 * 60_000;
const KST_OFFSET = 9 * 60 * 60_000;
const dayAt = time => new Date(time + KST_OFFSET).toISOString().slice(0, 10);

export function createVisitStats({ now = Date.now } = {}) {
  let date = '', startedAt = 0;
  const devices = new Map();

  function rotate(time) {
    const current = dayAt(time);
    if (date !== current) {
      devices.clear();
      date = current;
      startedAt = time;
    }
  }

  function summary(time) {
    const breakdown = { ios: { web: 0, pwa: 0 }, android: { web: 0, pwa: 0 } };
    for (const { os, mode } of devices.values()) breakdown[os][mode]++;
    return {
      date,
      timeZone: 'Asia/Seoul',
      startedAt: new Date(startedAt).toISOString(),
      asOf: new Date(time).toISOString(),
      resetsAt: new Date((Math.floor((time + KST_OFFSET) / DAY_MS) + 1) * DAY_MS - KST_OFFSET).toISOString(),
      total: devices.size,
      byOs: { ios: breakdown.ios.web + breakdown.ios.pwa, android: breakdown.android.web + breakdown.android.pwa },
      byMode: { web: breakdown.ios.web + breakdown.android.web, pwa: breakdown.ios.pwa + breakdown.android.pwa },
      breakdown,
    };
  }

  function read() {
    const time = now();
    rotate(time);
    return summary(time);
  }

  function record(body, userAgent) {
    const time = now();
    rotate(time);
    const os = phoneOs(userAgent);
    if (!os) return { ...summary(time), registered: false };
    if (typeof body?.id !== 'string' || !VISITOR_ID_PATTERN.test(body.id) || !['web', 'pwa'].includes(body?.mode)) {
      throw Object.assign(new Error('올바른 집계 정보가 필요해요.'), { statusCode: 400 });
    }
    const id = body.id.toLowerCase();
    const registered = !devices.has(id);
    if (registered) devices.set(id, { os, mode: body.mode });
    return { ...summary(time), registered };
  }

  return { read, record };
}
