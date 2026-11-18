import { randomUUID } from 'node:crypto';

export function diagnosticContext() {
  return {
    region: /^[a-z]{3}\d$/.test(process.env.VERCEL_REGION || '') ? process.env.VERCEL_REGION : process.env.VERCEL ? 'vercel-unknown' : 'local',
    commit: /^[a-f0-9]{7,40}$/i.test(process.env.VERCEL_GIT_COMMIT_SHA || '') ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 12) : null,
    node: process.version,
  };
}

// Never serialize Error objects/messages: Node and database errors can contain
// credentials, request queries, response bodies, or selected coordinates.
export function diagnosticCodes(error) {
  const codes = new Set(), visited = new Set();
  const pending = [error];
  for (let i = 0; i < pending.length && i < 12; i++) {
    const item = pending[i];
    if (!item || visited.has(item)) continue;
    visited.add(item);
    if (typeof item.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(item.code)) codes.add(item.code);
    if (item.cause) pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 4));
  }
  return [...codes];
}

export async function fetchJson(url, options = {}) {
  const { timeout = 18_000, dataset = null, ...requestOptions } = options;
  const requestId = randomUUID(), startedAt = performance.now();
  const target = new URL(url);
  const hosts = {
    'api.open-meteo.com': 'open-meteo', 'apis.data.go.kr': 'kma', 'aviationweather.gov': 'aviationweather',
  };
  let phase = 'headers', statusCode = null;
  const signal = AbortSignal.timeout(timeout);
  try {
    const response = await fetch(url, {
      ...requestOptions, signal,
      headers: { 'User-Agent': 'RunCast-Jamsil/0.1 local-dashboard', Accept: 'application/json', ...(requestOptions.headers || {}) },
    });
    statusCode = response.status;
    if (!response.ok) {
      const error = new Error(`외부 자료 요청 실패 (${response.status})`);
      error.statusCode = response.status;
      const retryAfter = response.headers.get('Retry-After');
      if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds)) error.retryAfterMs = Math.max(0, seconds * 1000);
        else {
          const retryAt = Date.parse(retryAfter);
          if (Number.isFinite(retryAt)) error.retryAt = retryAt;
        }
      }
      // Release an error response without consuming/logging its body.
      if (response.body) await response.body.cancel().catch(() => {});
      throw error;
    }
    phase = 'body';
    return await response.json();
  } catch (error) {
    const causeCodes = diagnosticCodes(error);
    const failure = statusCode != null && statusCode >= 400 ? 'http'
      : causeCodes.includes('UND_ERR_CONNECT_TIMEOUT') ? 'connect-timeout'
      : causeCodes.some(code => ['ENOTFOUND', 'EAI_AGAIN'].includes(code)) ? 'dns'
      : causeCodes.some(code => /TLS|CERT|SSL/.test(code)) ? 'tls'
      : signal.aborted || error?.name === 'TimeoutError' ? 'deadline'
      : error?.name === 'SyntaxError' ? 'invalid-json' : 'network';
    console.warn(`[UPSTREAM_HTTP] ${JSON.stringify({
      version: 'upstream-http-v1', requestId, ...diagnosticContext(),
      provider: hosts[target.hostname] || 'other', host: hosts[target.hostname] ? target.hostname : 'other',
      dataset: ['weekly', 'multi-model'].includes(dataset) ? dataset : null,
      phase, failure, statusCode, durationMs: Math.round(performance.now() - startedAt),
      configuredTimeoutMs: timeout, errorCode: causeCodes[0] || null, causeCodes,
    })}`);
    throw error;
  }
}
