import test from "node:test";
import assert from "node:assert/strict";
import { createRefreshScheduler } from "../assets/refresh-scheduler.mjs";
process.env.VERCEL = "1";
const { cachedRawLoad, resetRawCacheForTest } = await import("../server.mjs");

function fakeClock(start = 0) {
  let time = start;
  return {
    now: () => time,
    tick(ms) { time += ms; },
  };
}

function memoryStorage(seed = null) {
  let value = seed;
  return {
    read(_key, fallback = null) { return value ?? fallback; },
    write(_key, next) { value = next; return true; },
    value() { return value; },
  };
}

const base = (clock, storage = memoryStorage()) => createRefreshScheduler({ now: clock.now, random: () => 0, storage });

test("scheduler uses one request per key, keeps independent keys, and respects the 5 minute interval", async () => {
  const clock = fakeClock(), scheduler = base(clock);
  let calls = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const first = scheduler.request("core", "37,127", { fetcher: async () => { calls += 1; return pending; } });
  const duplicate = scheduler.request("core", "37,127", { manual: true, fetcher: async () => { calls += 1; return { duplicate: true }; } });
  const other = scheduler.request("weekly", "37,127", { intervalMs: 30 * 60_000, fetcher: async () => { calls += 1; return { weekly: true }; } });
  assert.strictEqual(first, duplicate);
  release({ dataUpdatedAt: new Date(clock.now()).toISOString() });
  assert.equal((await first).status, "success");
  assert.equal((await other).status, "success");
  assert.equal(calls, 2);
  assert.ok(["interval", "backoff"].includes((await scheduler.request("core", "37,127", { fetcher: async () => { calls += 1; return {}; } })).reason));
  clock.tick(5 * 60_000);
  assert.equal((await scheduler.request("core", "37,127", { fetcher: async () => { calls += 1; return {}; } })).status, "success");
  assert.equal(calls, 3);
});

test("scheduler applies 1/2/4 minute retries, then a 30 minute cooldown with bounded jitter", async () => {
  const clock = fakeClock(), scheduler = base(clock);
  const fail = async () => { throw Error("offline"); };
  for (const expected of [60_000, 120_000, 240_000]) {
    const outcome = await scheduler.request("core", "retry", { fetcher: fail });
    assert.equal(outcome.status, "error");
    assert.equal(outcome.meta.consecutiveFailures, expected === 60_000 ? 1 : expected === 120_000 ? 2 : 3);
    assert.equal(outcome.meta.nextEligibleAt, clock.now() + expected);
    assert.equal((await scheduler.request("core", "retry", { fetcher: fail })).reason, "backoff");
    clock.tick(expected);
  }
  const fourth = await scheduler.request("core", "retry", { fetcher: fail });
  assert.equal(fourth.meta.consecutiveFailures, 4);
  assert.equal(fourth.meta.nextEligibleAt, clock.now() + 30 * 60_000);
});

test("manual refresh skips automatic backoff but keeps the 10 second rate and server retry gate", async () => {
  const clock = fakeClock(), scheduler = base(clock);
  const fail = async () => { throw Error("offline"); };
  await scheduler.request("core", "manual", { fetcher: fail });
  assert.equal((await scheduler.request("core", "manual", { manual: true, fetcher: async () => ({}) })).reason, "manual-rate");
  clock.tick(10_000);
  const manual = await scheduler.request("core", "manual", { manual: true, fetcher: async () => ({}) });
  assert.equal(manual.status, "success");
  const retryAt = clock.now() + 120_000;
  const gated = await scheduler.request("core", "server", { fetcher: async () => ({ refresh: { retryAt: new Date(retryAt).toISOString(), stale: true } }) });
  assert.equal(gated.status, "success");
  assert.equal((await scheduler.request("core", "server", { manual: true, fetcher: async () => ({}) })).reason, "server-retry");

  const staleClock = fakeClock(), staleScheduler = base(staleClock);
  const staleFirst = await staleScheduler.request("core", "stale-retry", { fetcher: async () => ({ refresh: { stale: true } }) });
  assert.equal(staleFirst.stale, true);
  staleClock.tick(60_000);
  assert.equal((await staleScheduler.request("core", "stale-retry", { fetcher: async () => ({}) })).status, "success");
});

test("metadata restores after a restart and timeout/intentional abort release the shared request", async () => {
  const clock = fakeClock(), storage = memoryStorage(), scheduler = base(clock, storage);
  await scheduler.request("weekly", "restore", { fetcher: async () => ({}) });
  const restarted = base(clock, storage);
  assert.ok(["interval", "backoff"].includes((await restarted.request("weekly", "restore", { fetcher: async () => ({}) })).reason));

  let aborted = false;
  const timeout = restarted.request("core", "timeout", { fetcher: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
  }) });
  clock.tick(30_000);
  assert.equal(restarted.cleanupExpired(), 1);
  const timeoutOutcome = await timeout;
  assert.equal(aborted, true);
  assert.equal(timeoutOutcome.status, "error");
  assert.equal(timeoutOutcome.meta.lastOutcome, "timeout");

  const abort = restarted.request("core", "abort", { fetcher: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }) });
  assert.equal(restarted.cancel("core", "abort", { intentional: true }), true);
  const abortOutcome = await abort;
  assert.equal(abortOutcome.status, "error");
  assert.equal(abortOutcome.meta.consecutiveFailures, 0);
});

test("composed core requests can use a finite 45 second deadline", async () => {
  const clock = fakeClock(), scheduler = base(clock);
  let aborted = false;
  const pending = scheduler.request("core", "composed", {
    timeoutMs: 45_000,
    fetcher: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
    }),
  });
  clock.tick(30_000);
  assert.equal(scheduler.cleanupExpired(), 0);
  clock.tick(15_000);
  assert.equal(scheduler.cleanupExpired(), 1);
  assert.equal((await pending).status, "error");
  assert.equal(aborted, true);
});

test("pending leases and failed backoff survive a scheduler restart without a persistent lock", async () => {
  const clock = fakeClock(), storage = memoryStorage(), scheduler = base(clock, storage);
  const pending = scheduler.request("core", "pending-restore", { fetcher: ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }) });
  await Promise.resolve();
  const saved = storage.value().entries.find(entry => entry.key === "core:pending-restore");
  assert.equal(saved.startedAt, 0);
  assert.equal(saved.lastAttemptAt, 0);
  assert.equal(saved.nextEligibleAt, 30_000);
  const restarted = base(clock, storage);
  assert.equal((await restarted.request("core", "pending-restore", { fetcher: async () => ({}) })).reason, "backoff");
  scheduler.cancel("core", "pending-restore");
  await pending;

  const failureStorage = memoryStorage(), failed = base(clock, failureStorage);
  await failed.request("core", "failed-restore", { fetcher: async () => { throw Error("offline"); } });
  const failedRestart = base(clock, failureStorage);
  assert.equal((await failedRestart.request("core", "failed-restore", { fetcher: async () => ({}) })).reason, "backoff");
  assert.equal(failedRestart.getMeta("core", "failed-restore").consecutiveFailures, 1);
});

test("numeric Retry-After becomes an absolute server gate for manual refresh", async () => {
  const clock = fakeClock(), scheduler = base(clock);
  const error = Error("busy"); error.retryAfterMs = 120_000;
  const outcome = await scheduler.request("core", "numeric-retry", { fetcher: async () => { throw error; } });
  assert.equal(outcome.status, "error");
  assert.equal(scheduler.getMeta("core", "numeric-retry").serverRetryAt, 120_000);
  clock.tick(10_000);
  const manual = await scheduler.request("core", "numeric-retry", { manual: true, fetcher: async () => ({}) });
  assert.equal(manual.status, "skipped");
  assert.equal(manual.reason, "server-retry");
});

test("map radar refresh shares an in-flight frame load and keeps the 10 second manual gate", async () => {
  const clock = fakeClock(), scheduler = base(clock), key = "37,127:0";
  let calls = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const first = scheduler.request("radar", key, { intervalMs: 10_000, fetcher: async () => { calls += 1; return pending; } });
  const duplicate = scheduler.request("radar", key, { manual: true, intervalMs: 10_000, fetcher: async () => { calls += 1; return { duplicate: true }; } });
  assert.strictEqual(first, duplicate);
  release({ frame: 0 });
  assert.equal((await first).status, "success");
  assert.equal(calls, 1);
  clock.tick(9_999);
  assert.equal((await scheduler.request("radar", key, { manual: true, intervalMs: 10_000, fetcher: async () => ({}) })).reason, "manual-rate");
  clock.tick(1);
  assert.equal((await scheduler.request("radar", key, { manual: true, intervalMs: 10_000, fetcher: async () => { calls += 1; return { frame: 1 }; } })).status, "success");
  assert.equal(calls, 2);
});

test("timeout settles an abort-ignoring fetcher and a later generation owns metadata", async () => {
  const clock = fakeClock();
  let resolveLate;
  const scheduler = base(clock);
  const old = scheduler.request("core", "hung", { timeoutMs: 1_000, fetcher: () => new Promise(resolve => { resolveLate = resolve; }) });
  await Promise.resolve();
  clock.tick(1_000);
  assert.equal(scheduler.cleanupExpired(), 1);
  const timedOut = await old;
  assert.equal(timedOut.status, "error");
  assert.equal(timedOut.error.timeout, true);
  clock.tick(10_000);
  const fresh = await scheduler.request("core", "hung", { manual: true, fetcher: async () => ({ dataUpdatedAt: new Date(clock.now()).toISOString() }) });
  assert.equal(fresh.status, "success");
  const afterFresh = scheduler.getMeta("core", "hung");
  resolveLate({ dataUpdatedAt: new Date(0).toISOString() });
  await Promise.resolve();
  assert.equal(scheduler.getMeta("core", "hung").lastSuccessAt, afterFresh.lastSuccessAt);
});

test("server stale fallback records retryAt, keeps fetchedAt, coalesces cooldown calls, and retries after cooldown", async () => {
  resetRawCacheForTest();
  const key = "v1|fixture|weather|place|cycle|stale-policy";
  const trace = [];
  let loads = 0;
  const first = await cachedRawLoad(key, async () => { loads += 1; return { value: "old" }; }, { freshMs: -1, staleMs: 10_000, failureMs: 30_000, trace });
  const fetchedAt = trace.at(-1).fetchedAt;
  const stale = await cachedRawLoad(key, async () => { loads += 1; throw Error("upstream"); }, { freshMs: -1, staleMs: 10_000, failureMs: 30_000, trace });
  assert.deepEqual(stale, first);
  assert.equal(loads, 2);
  const staleEvent = trace.at(-1);
  assert.equal(staleEvent.state, "stale-if-error");
  assert.equal(staleEvent.fetchedAt, fetchedAt);
  assert.ok(staleEvent.retryAt);
  const cooldownTrace = [];
  const cooldown = await cachedRawLoad(key, async () => { loads += 1; throw Error("must not call"); }, { freshMs: -1, staleMs: 10_000, failureMs: 30_000, trace: cooldownTrace });
  assert.deepEqual(cooldown, first);
  assert.equal(loads, 2);
  assert.equal(cooldownTrace.at(-1).state, "stale-cooldown");
  await new Promise(resolve => setTimeout(resolve, 31));
  // The fixture uses a short failure window to avoid sleeping for production's
  // 30 seconds; the original fetched timestamp remains independently tracked.
  resetRawCacheForTest();
  let secondLoads = 0;
  const shortKey = "v1|fixture|weather|place|cycle|stale-policy-short";
  await cachedRawLoad(shortKey, async () => { secondLoads += 1; return { value: "old" }; }, { freshMs: -1, staleMs: 1_000, failureMs: 5, trace: [] });
  await cachedRawLoad(shortKey, async () => { secondLoads += 1; throw Error("upstream"); }, { freshMs: -1, staleMs: 1_000, failureMs: 5, trace: [] });
  await new Promise(resolve => setTimeout(resolve, 8));
  const recovered = await cachedRawLoad(shortKey, async () => { secondLoads += 1; return { value: "new" }; }, { freshMs: 10_000, staleMs: 1_000, failureMs: 5, trace: [] });
  assert.deepEqual(recovered, { value: "new" });
  assert.equal(secondLoads, 3);

  resetRawCacheForTest();
  let expiredLoads = 0;
  const expiredKey = "v1|fixture|weather|place|cycle|stale-expired";
  await cachedRawLoad(expiredKey, async () => { expiredLoads += 1; return { value: "old" }; }, { freshMs: -1, staleMs: 5, failureMs: 30, trace: [] });
  await cachedRawLoad(expiredKey, async () => { expiredLoads += 1; throw Error("upstream"); }, { freshMs: -1, staleMs: 5, failureMs: 30, trace: [] });
  await new Promise(resolve => setTimeout(resolve, 8));
  await assert.rejects(cachedRawLoad(expiredKey, async () => { expiredLoads += 1; return { value: "must-not-call" }; }, { freshMs: -1, staleMs: 5, failureMs: 30, trace: [] }), /upstream/);
  assert.equal(expiredLoads, 2);
});
