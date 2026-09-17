/*
 * Foreground refresh policy shared by the mobile weather views.
 *
 * This module deliberately has no DOM or timer loop. The page owns the one
 * minute eligibility check and calls request() from lifecycle events. Keeping
 * the policy here makes it possible to test it with a fake clock and keeps an
 * installed PWA from leaving a background polling loop behind.
 */

export const REFRESH_INTERVALS = Object.freeze({
  core: 5 * 60_000,
  weekly: 30 * 60_000,
  context: 25_000,
});

export const REFRESH_POLICY = Object.freeze({
  requestTimeoutMs: 30_000,
  manualMinIntervalMs: 10_000,
  retryDelaysMs: Object.freeze([60_000, 2 * 60_000, 4 * 60_000]),
  retryCooldownMs: 30 * 60_000,
  jitterRatio: 0.1,
  jitterCapMs: 30_000,
  storageKey: "runcast.refresh.v2",
  maxEntries: 24,
  maxFutureMs: 24 * 60 * 60_000,
});

// The core endpoint can spend up to the existing KMA/Open-Meteo provider
// budgets in sequence before its recent-observation and multi-model work
// finishes. Keep the scheduler default at 30s for ordinary requests, while
// allowing that one composed response a finite 45s browser deadline.
export const REFRESH_TIMEOUTS = Object.freeze({
  core: 45_000,
});

const finite = value => Number.isFinite(value) ? value : null;

function parseTime(value) {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(number) ? number : null;
}

function safeStorage(storage) {
  if (storage && typeof storage.read === "function" && typeof storage.write === "function") return storage;
  return {
    read(key, fallback = null) {
      try {
        const raw = globalThis.localStorage?.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    write(key, value) {
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
  };
}

function validMeta(raw, now, maxFutureMs) {
  if (!raw || typeof raw !== "object") return null;
  const key = typeof raw.key === "string" ? raw.key : "";
  if (!key || key.length > 180) return null;
  const times = ["startedAt", "lastAttemptAt", "lastSuccessAt", "nextEligibleAt", "serverRetryAt", "lastDataAt"];
  const meta = {
    key,
    startedAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextEligibleAt: null,
    serverRetryAt: null,
    lastDataAt: null,
    consecutiveFailures: Number.isInteger(raw.consecutiveFailures) && raw.consecutiveFailures >= 0 && raw.consecutiveFailures <= 100 ? raw.consecutiveFailures : 0,
    lastOutcome: typeof raw.lastOutcome === "string" && raw.lastOutcome.length < 40 ? raw.lastOutcome : null,
  };
  for (const field of times) {
    const value = parseTime(raw[field]);
    // A clock restored from an old PWA session can be ahead, but a date a day
    // in the future is almost certainly corrupt. Drop that field safely.
    meta[field] = value != null && value <= now + maxFutureMs ? value : null;
  }
  return meta;
}

function cloneMeta(meta) {
  return {
    key: meta.key,
    startedAt: meta.startedAt,
    lastAttemptAt: meta.lastAttemptAt,
    lastSuccessAt: meta.lastSuccessAt,
    nextEligibleAt: meta.nextEligibleAt,
    serverRetryAt: meta.serverRetryAt,
    lastDataAt: meta.lastDataAt,
    consecutiveFailures: meta.consecutiveFailures,
    lastOutcome: meta.lastOutcome,
  };
}

function makeAbortError(message = "요청이 취소되었습니다.") {
  const error = new Error(message);
  error.name = "AbortError";
  error.intentional = true;
  return error;
}

function makeTimeoutError() {
  const error = new Error("자료 요청 시간이 초과되었습니다.");
  error.name = "TimeoutError";
  error.code = "REQUEST_TIMEOUT";
  error.timeout = true;
  return error;
}

function retryAfterMs(error, current = Date.now()) {
  const explicit = finite(error?.retryAfterMs);
  if (explicit != null && explicit >= 0) return explicit;
  const retryAt = parseTime(error?.retryAt);
  if (retryAt != null) return Math.max(0, retryAt - current);
  return 0;
}

function staleFrom(value) {
  return Boolean(value?.refresh?.stale || value?.refresh?.failed || value?.refresh?.retryAt || value?.cache?.stale || value?.cache?.retryAt || value?.stale === true);
}

/**
 * Create a policy controller. All clocks and randomness are injectable so
 * tests can advance time without sleeping.
 */
export function createRefreshScheduler(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const random = typeof options.random === "function" ? options.random : Math.random;
  const policy = { ...REFRESH_POLICY, ...(options.policy || {}) };
  const retryDelays = Array.isArray(options.policy?.retryDelaysMs) ? options.policy.retryDelaysMs : REFRESH_POLICY.retryDelaysMs;
  const storage = safeStorage(options.storage);
  const records = new Map();
  const inflight = new Map();

  const jittered = base => {
    const jitter = Math.min(policy.jitterCapMs, base * policy.jitterRatio);
    return base + Math.max(0, Number(random()) || 0) * jitter;
  };

  function persist() {
    const values = [...records.values()].slice(-policy.maxEntries).map(cloneMeta);
    // Storage can be disabled or full. Metadata is an optimization; request
    // control remains safe for this execution if persistence fails.
    storage.write(policy.storageKey, { version: 2, entries: values });
  }

  function restore() {
    const saved = storage.read(policy.storageKey, null);
    const entries = Array.isArray(saved) ? saved : saved?.version === 2 ? saved.entries : [];
    if (!Array.isArray(entries)) return;
    for (const raw of entries) {
      const meta = validMeta(raw, now(), policy.maxFutureMs);
      if (meta) records.set(meta.key, meta);
    }
  }

  function metaFor(kind, key) {
    const composite = `${String(kind)}:${String(key)}`;
    let meta = records.get(composite);
    if (!meta) {
      meta = {
        key: composite,
        startedAt: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        nextEligibleAt: null,
        serverRetryAt: null,
        lastDataAt: null,
        consecutiveFailures: 0,
        lastOutcome: null,
      };
      records.set(composite, meta);
    }
    return meta;
  }

  function serverGate(meta, serverRetryAt) {
    const supplied = parseTime(serverRetryAt);
    if (supplied != null) meta.serverRetryAt = Math.max(meta.serverRetryAt || 0, supplied);
    return meta.serverRetryAt != null && now() < meta.serverRetryAt;
  }

  function eligibility(kind, key, options = {}) {
    const meta = metaFor(kind, key);
    const current = now();
    const manual = Boolean(options.manual);
    const intervalMs = finite(options.intervalMs) ?? REFRESH_INTERVALS[kind] ?? REFRESH_INTERVALS.core;
    const dataAt = parseTime(options.dataAt);
    const expiresAt = parseTime(options.expiresAt);
    const serverBlocked = serverGate(meta, options.serverRetryAt);
    if (serverBlocked) return { allowed: false, reason: "server-retry", meta: cloneMeta(meta) };
    if (inflight.has(meta.key)) return { allowed: true, shared: true, reason: "inflight", meta: cloneMeta(meta) };
    if (manual && meta.lastAttemptAt != null && current - meta.lastAttemptAt < policy.manualMinIntervalMs) {
      return { allowed: false, reason: "manual-rate", meta: cloneMeta(meta) };
    }
    if (!manual && meta.nextEligibleAt != null && current < meta.nextEligibleAt) {
      return { allowed: false, reason: "backoff", meta: cloneMeta(meta) };
    }
    if (!manual && expiresAt != null && current < expiresAt && meta.lastSuccessAt == null) {
      return { allowed: false, reason: "fresh", meta: cloneMeta(meta) };
    }
    if (!manual && meta.lastSuccessAt != null && current - meta.lastSuccessAt < intervalMs) {
      return { allowed: false, reason: "interval", meta: cloneMeta(meta) };
    }
    if (!manual && dataAt != null && current - dataAt < intervalMs && meta.lastAttemptAt == null) {
      return { allowed: false, reason: "data-fresh", meta: cloneMeta(meta) };
    }
    return { allowed: true, shared: false, reason: "eligible", meta: cloneMeta(meta) };
  }

  function recordSuccess(meta, value, intervalMs) {
    const current = now();
    const stale = staleFrom(value);
    meta.lastDataAt = parseTime(value?.dataUpdatedAt || value?.fetchedAt) || meta.lastDataAt;
    meta.lastOutcome = stale ? "stale" : "success";
    if (stale) {
      meta.consecutiveFailures += 1;
      const base = meta.consecutiveFailures <= retryDelays.length ? retryDelays[meta.consecutiveFailures - 1] : policy.retryCooldownMs;
      meta.nextEligibleAt = current + jittered(base);
      const retryAt = parseTime(value?.refresh?.retryAt || value?.cache?.retryAt);
      if (retryAt != null) meta.serverRetryAt = Math.max(meta.serverRetryAt || 0, retryAt);
    } else {
      meta.lastSuccessAt = current;
      meta.consecutiveFailures = 0;
      meta.nextEligibleAt = current + intervalMs;
      meta.serverRetryAt = null;
    }
    persist();
    return stale;
  }

  function recordFailure(meta, error) {
    if (error?.intentional || error?.name === "AbortError" && !error?.timeout) {
      meta.lastOutcome = "aborted";
      persist();
      return;
    }
    const current = now();
    meta.consecutiveFailures += 1;
    const base = meta.consecutiveFailures <= retryDelays.length ? retryDelays[meta.consecutiveFailures - 1] : policy.retryCooldownMs;
    const waitMs = Math.max(jittered(base), retryAfterMs(error, current));
    meta.nextEligibleAt = current + waitMs;
    const retryAt = parseTime(error?.retryAt) ?? (retryAfterMs(error, current) > 0 ? current + retryAfterMs(error, current) : null);
    meta.serverRetryAt = retryAt != null ? Math.max(meta.serverRetryAt || 0, retryAt) : meta.serverRetryAt;
    meta.lastOutcome = error?.timeout ? "timeout" : "error";
    persist();
  }

  function request(kind, key, options = {}) {
    const composite = `${String(kind)}:${String(key)}`;
    const check = eligibility(kind, key, options);
    if (check.shared) return inflight.get(composite).promise;
    if (!check.allowed) return Promise.resolve({ status: "skipped", reason: check.reason, meta: check.meta });
    if (typeof options.fetcher !== "function") return Promise.reject(new TypeError("refresh fetcher가 필요합니다."));

    const meta = metaFor(kind, key);
    const intervalMs = finite(options.intervalMs) ?? REFRESH_INTERVALS[kind] ?? REFRESH_INTERVALS.core;
    const timeoutMs = Math.max(0, finite(options.timeoutMs) ?? policy.requestTimeoutMs);
    const controller = new AbortController();
    const startedAt = now();
    const leaseMs = Math.max(policy.manualMinIntervalMs, timeoutMs);
    meta.startedAt = startedAt;
    meta.lastAttemptAt = startedAt;
    // A persisted, finite lease prevents a cold restart from immediately
    // duplicating a request whose Promise was lost with the old page.
    meta.nextEligibleAt = Math.max(meta.nextEligibleAt || 0, startedAt + leaseMs);
    meta.lastOutcome = "pending";
    persist();
    let timer = null;
    let rejectAbort;
    const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
    const entry = { controller, startedAt, timeoutMs, promise: null, intentional: false, expired: false, detached: false };
    controller.signal.addEventListener("abort", () => rejectAbort(controller.signal.reason || makeAbortError()), { once: true });
    let fetchPromise;
    try { fetchPromise = Promise.resolve(options.fetcher({ signal: controller.signal, controller })); }
    catch (error) { fetchPromise = Promise.reject(error); }
    // The fetcher may finish after the scheduler has already returned a
    // timeout/cancel result. Attach a handler so that late rejection is never
    // unhandled and can never mutate scheduler metadata.
    fetchPromise.catch(() => {});
    timer = setTimeout(() => controller.abort(makeTimeoutError()), timeoutMs);
    const task = (async () => {
      try {
        const value = await Promise.race([fetchPromise, abortPromise]);
        if (controller.signal.aborted) {
          const reason = controller.signal.reason;
          if (reason?.timeout || reason?.code === "REQUEST_TIMEOUT") throw reason;
          throw makeAbortError();
        }
        if (entry.detached || inflight.get(composite) !== entry) {
          const error = makeAbortError("이전 요청 결과가 만료되었습니다.");
          error.intentional = true;
          throw error;
        }
        const stale = recordSuccess(meta, value, intervalMs);
        return { status: "success", value, stale, meta: cloneMeta(meta) };
      } catch (error) {
        const signalReason = controller.signal.reason;
        const timeout = error?.timeout || error?.code === "REQUEST_TIMEOUT" || signalReason?.timeout || signalReason?.code === "REQUEST_TIMEOUT";
        if (timeout && signalReason?.timeout) error = signalReason;
        if (timeout && error.name === "AbortError") error = makeTimeoutError();
        if (entry.intentional) {
          error = error?.name === "AbortError" ? error : makeAbortError();
          error.intentional = true;
        }
        const superseded = entry.detached && inflight.get(composite) && inflight.get(composite) !== entry;
        if (!entry.expired || !superseded) {
          recordFailure(meta, error);
          return { status: "error", error, meta: cloneMeta(meta) };
        }
        const expiredMeta = cloneMeta(meta);
        expiredMeta.lastOutcome = error?.timeout ? "timeout" : "error";
        return { status: "error", error, meta: expiredMeta };
      } finally {
        clearTimeout(timer);
        if (inflight.get(composite) === entry) inflight.delete(composite);
      }
    })();
    entry.promise = task;
    inflight.set(composite, entry);
    return task;
  }

  function cancel(kind, key, options = {}) {
    const composite = `${String(kind)}:${String(key)}`;
    const entry = inflight.get(composite);
    if (!entry) return false;
    entry.intentional = options.intentional !== false;
    entry.controller.abort(makeAbortError(options.reason || "요청이 취소되었습니다."));
    return true;
  }

  function cleanupExpired() {
    const current = now();
    let count = 0;
    for (const [key, entry] of inflight) {
      if (current - entry.startedAt < entry.timeoutMs) continue;
      entry.expired = true;
      entry.detached = true;
      entry.controller.abort(makeTimeoutError());
      count += 1;
      // A fetch implementation may ignore AbortSignal. Remove the shared
      // promise immediately; the Promise.race above still settles the old
      // caller and the next lifecycle event can start a fresh generation.
      if (inflight.get(key) === entry) inflight.delete(key);
    }
    return count;
  }

  function getMeta(kind, key) {
    const meta = records.get(`${String(kind)}:${String(key)}`);
    return meta ? cloneMeta(meta) : null;
  }

  function reset(kind, key) {
    records.delete(`${String(kind)}:${String(key)}`);
    persist();
  }

  restore();
  return { request, cancel, cleanupExpired, eligibility, getMeta, reset, records, inflight, policy };
}
