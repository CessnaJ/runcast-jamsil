import { ROUTES, resolveLocation, normalizeWeekly, numberOrNull, evaluateRunWindow, runSampleMetrics } from './assets/weather-domain.mjs';
import http from "node:http";
import https from "node:https";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.RUNCAST_PORT || 4173);
const ROOT = resolve(new URL(".", import.meta.url).pathname);
const RUNTIME_MODE = process.env.VERCEL || process.env.RUNCAST_MODE === "public" ? "public" : "local";
const LOCAL_AI_ENABLED = RUNTIME_MODE === "local" && process.env.RUNCAST_AI_ENABLED !== "0";
const LOCAL_KEYS = await loadLocalKeys();
const knownCctvUrls = new Set();
let activeRadarKey = "";
const radarCache = new Map();
// UI 결과가 아닌 외부 원천 응답만 인스턴스 메모리에 둡니다.
// Vercel에서는 인스턴스별 best-effort cache이며, DB/Redis를 요구하지 않습니다.
const rawCache = new Map();
const inflightCache = new Map();
const RAW_CACHE_MAX_ENTRIES = 120;
const RAW_CACHE_FRESH_MS = 5 * 60_000;
const RAW_CACHE_STALE_MS = 15 * 60_000;
const RAW_CACHE_FAILURE_MS = 30_000;
const CODEX_COMMANDS = [...new Set([
  process.env.CODEX_BIN,
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "codex",
].filter(Boolean))];



function parseEnvFile(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[name] = value;
  }
  return values;
}

export async function loadLocalKeys(root = ROOT, environment = process.env) {
  let fileValues = {};
  // 로컬 테스트: .env < .env.local < 실행 환경변수 순서로 적용합니다.
  // Vercel 배포는 프로젝트에 설정한 환경변수만 사용합니다.
  if (!environment.VERCEL) {
    for (const filename of [".env", ".env.local"]) {
      try {
        const parsed = parseEnvFile(await readFile(join(root, filename), "utf8"));
        Object.assign(fileValues, Object.fromEntries(Object.entries(parsed).filter(([, value]) => value.trim())));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  const key = name => String(environment[name] || "").trim() || String(fileValues[name] || "").trim();
  return {
    naverKey: key("NAVER_MAP_CLIENT_ID"),
    kmaServiceKey: key("KMA_SERVICE_KEY"),
    kmaHubKey: key("KMA_HUB_KEY"),
    itsApiKey: key("ITS_API_KEY"),
  };
}

function effectiveKeys() {
  // 비밀 키는 실행 환경변수 또는 로컬 .env/.env.local에서 읽습니다.
  // 브라우저가 보낸 값은 로컬 모드에서도 신뢰하거나 사용하지 않습니다.
  return Object.fromEntries(Object.keys(LOCAL_KEYS).map((name) => [name, String(LOCAL_KEYS[name] || "").trim()]));
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1_000_000) throw new Error("요청이 너무 큽니다.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function timeoutSignal(ms) {
  return AbortSignal.timeout(ms);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: timeoutSignal(options.timeout || 18_000),
    headers: {
      "User-Agent": "RunCast-Jamsil/0.1 local-dashboard",
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const error = new Error(`외부 자료 요청 실패 (${response.status})`);
    error.statusCode = response.status;
    const retryAfter = response.headers.get("Retry-After");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) error.retryAfterMs = Math.max(0, seconds * 1000);
      else {
        const retryAt = Date.parse(retryAfter);
        if (Number.isFinite(retryAt)) error.retryAt = retryAt;
      }
    }
    throw error;
  }
  return response.json();
}

/** ITS의 비표준 HTTPS 9443 포트를 Node 소켓으로 직접 호출합니다. */
function httpsGetText(url, { headers = {}, timeout = 12_000, maxBytes = 2_000_000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const resolve = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const reject = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };

    const request = https.get(url, { headers, family: 4 }, (response) => {
      const chunks = [];
      let size = 0;

      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          const error = new Error("ITS CCTV 응답이 너무 큽니다.");
          error.code = "ITS_RESPONSE_TOO_LARGE";
          request.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      response.on("aborted", () => reject(new Error("ITS CCTV 응답이 중단되었습니다.")));
      response.on("error", reject);
      response.on("end", () => {
        const status = response.statusCode || 0;
        if (status < 200 || status >= 300) {
          const error = new Error(`ITS CCTV 요청 실패 (${status || "응답 없음"})`);
          error.statusCode = status || 502;
          const retryAfter = response.headers?.["retry-after"] || response.headers?.["Retry-After"];
          if (retryAfter) {
            const seconds = Number(retryAfter);
            if (Number.isFinite(seconds)) error.retryAfterMs = Math.max(0, seconds * 1000);
            else {
              const retryAt = Date.parse(retryAfter);
              if (Number.isFinite(retryAt)) error.retryAt = retryAt;
            }
          }
          reject(error);
          return;
        }
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });

    request.setTimeout(timeout, () => {
      const error = new Error("ITS CCTV 서버 연결 시간 초과");
      error.code = "ITS_CONNECT_TIMEOUT";
      request.destroy(error);
    });
    request.on("error", reject);
  });
}

function canonicalPart(value) {
  return String(value ?? "").trim().replace(/[|\s]+/g, "_");
}

/** 비밀키 없이 provider/dataset/location/cycle/variant를 고정 순서로 표현합니다. */
export function buildRawCacheKey({ provider, dataset, location, cycle, variant }) {
  return ["v1", canonicalPart(provider), canonicalPart(dataset), canonicalPart(location), canonicalPart(cycle), canonicalPart(variant)].join("|");
}

function cacheDiagnostic(trace, key, state, entry, extra = {}) {
  if (!trace) return;
  const [, provider, dataset, location, cycle, variant] = key.split("|");
  trace.push({
    provider, dataset, location, cycle, variant, state,
    ageSeconds: entry?.fetchedAt ? Math.max(0, Math.round((Date.now() - entry.fetchedAt) / 1000)) : null,
    fetchedAt: entry?.fetchedAt ? new Date(entry.fetchedAt).toISOString() : null,
    expiresAt: entry?.expiresAt ? new Date(entry.expiresAt).toISOString() : null,
    staleUntil: entry?.staleUntil ? new Date(entry.staleUntil).toISOString() : null,
    retryAt: entry?.retryAt ? new Date(entry.retryAt).toISOString() : null,
    stale: Boolean(entry?.stale || state === "stale-if-error" || state === "stale-cooldown"),
    sourceIssuedAt: entry?.sourceIssuedAt || null,
    ...extra,
  });
}

function touchRawCache(key, entry) {
  rawCache.delete(key);
  rawCache.set(key, entry);
}

function trimRawCache() {
  while (rawCache.size > RAW_CACHE_MAX_ENTRIES) rawCache.delete(rawCache.keys().next().value);
}

function cacheError(message, entry = null) {
  const error = new Error(message);
  error.cachedFailure = true;
  if (Number.isFinite(entry?.retryAt)) error.retryAt = entry.retryAt;
  return error;
}

function retryDelayFrom(error, fallbackMs) {
  if (Number.isFinite(error?.retryAfterMs)) return Math.max(fallbackMs, error.retryAfterMs);
  if (Number.isFinite(error?.retryAt)) return Math.max(fallbackMs, error.retryAt - Date.now());
  return fallbackMs;
}

/**
 * 신선한 원천 응답은 5분, 오류 시 마지막 성공 응답은 최대 15분까지 fallback 합니다.
 * stale fallback을 시도한 시각에는 retryAt을 별도로 기록해 failureMs 동안
 * 외부 원천을 다시 부르지 않습니다. fetchedAt/expiresAt/staleUntil은 원래
 * 자료 시각을 유지합니다. 동일 key 요청은 inflight promise 하나를 공유하며,
 * 키에 인증키/UI 모드는 절대 포함하지 않습니다.
 */
export async function cachedRawLoad(key, loader, options = {}) {
  const {
    trace = null, freshMs = RAW_CACHE_FRESH_MS, staleMs = RAW_CACHE_STALE_MS,
    failureMs = RAW_CACHE_FAILURE_MS, sourceIssuedAt = null,
  } = options;
  const now = Date.now();
  const existing = rawCache.get(key);
  if (existing?.value !== undefined && now < existing.expiresAt) {
    touchRawCache(key, existing);
    cacheDiagnostic(trace, key, "fresh-hit", existing);
    return existing.value;
  }
  if (existing?.retryAt && now < existing.retryAt) {
    touchRawCache(key, existing);
    if (existing.value !== undefined && now < existing.staleUntil) {
      cacheDiagnostic(trace, key, "stale-cooldown", existing, { upstreamError: true });
      return existing.value;
    }
    cacheDiagnostic(trace, key, "negative-hit", existing, { staleExpired: existing.value !== undefined });
    throw cacheError(existing.error || existing.lastError || "원천 자료 재시도 대기 중", existing);
  }
  if (existing?.error && now < existing.expiresAt) {
    touchRawCache(key, existing);
    cacheDiagnostic(trace, key, "negative-hit", existing);
    throw cacheError(existing.error, existing);
  }
  if (inflightCache.has(key)) {
    cacheDiagnostic(trace, key, "coalesced", existing);
    const value = await inflightCache.get(key);
    cacheDiagnostic(trace, key, "coalesced-result", rawCache.get(key));
    return value;
  }
  cacheDiagnostic(trace, key, existing?.value !== undefined ? "refresh" : "miss", existing);
  const staleEntry = existing?.value !== undefined && now < existing.staleUntil ? existing : null;
  const task = (async () => {
    try {
      const value = await loader();
      const fetchedAt = Date.now();
      const entry = {
        value, fetchedAt, expiresAt: fetchedAt + freshMs, staleUntil: fetchedAt + staleMs,
        sourceIssuedAt: typeof sourceIssuedAt === "function" ? sourceIssuedAt(value) : sourceIssuedAt,
      };
      // 만료된 기존 key를 갱신한 경우에도 Map의 마지막(MRU)으로 이동시킵니다.
      touchRawCache(key, entry); trimRawCache();
      cacheDiagnostic(trace, key, "stored", entry);
      return value;
    } catch (error) {
      if (staleEntry) {
        const failedAt = Date.now();
        const retryAt = failedAt + retryDelayFrom(error, failureMs);
        const entry = {
          ...staleEntry,
          stale: true,
          staleFailureAt: failedAt,
          retryAt,
          lastError: error?.message || "원천 자료 요청 실패",
        };
        touchRawCache(key, entry);
        cacheDiagnostic(trace, key, "stale-if-error", entry, { upstreamError: true });
        return staleEntry.value;
      }
      const failedAt = Date.now();
      const retryAt = failedAt + retryDelayFrom(error, failureMs);
      const entry = { error: error?.message || "원천 자료 요청 실패", fetchedAt: failedAt, expiresAt: retryAt, staleUntil: retryAt, retryAt, sourceIssuedAt: null };
      rawCache.set(key, entry); trimRawCache();
      throw error;
    } finally {
      inflightCache.delete(key);
    }
  })();
  inflightCache.set(key, task);
  return task;
}

function cacheSummary(trace = []) {
  const states = trace.reduce((summary, event) => ({ ...summary, [event.state]: (summary[event.state] || 0) + 1 }), {});
  return { schema: "v1", events: trace, states, entries: rawCache.size, inflight: inflightCache.size };
}

export function resetRawCacheForTest() {
  rawCache.clear();
  inflightCache.clear();
}

function kstParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return parts;
}

function kstDateKey(date) {
  const p = kstParts(date);
  return `${p.year}${p.month}${p.day}`;
}

/**
 * Asia/Seoul 기준으로 다음 도래하는 시각을 구합니다.
 * 오늘의 시각이 아직 지나지 않았다면 오늘, 지났다면 내일을 반환합니다.
 * 테스트에서는 now를 고정해 경계(05:xx/06:xx/19:xx/20:xx)를 검증할 수 있습니다.
 */
export function nextKstOccurrence(hour, now = new Date()) {
  const p = kstParts(now);
  const candidate = new Date(`${p.year}-${p.month}-${p.day}T${String(hour).padStart(2, "0")}:00:00+09:00`);
  return candidate.getTime() < now.getTime() ? new Date(candidate.getTime() + 86_400_000) : candidate;
}

function uniqueMinutes(values) {
  return [...new Set(values.map((value) => Math.max(0, Math.round(value))))].sort((a, b) => a - b);
}

function createRunModePlans(now = new Date()) {
  const immediate = now;
  const morning = nextKstOccurrence(6, now);
  const evening = nextKstOccurrence(20, now);
  return [
    { id: "now", label: "지금", detailLabel: "지금 출발", startAt: immediate, immediate: true },
    { id: "morning", label: "오전 6시", detailLabel: "다음 오전 러닝", startAt: morning, immediate: false },
    { id: "evening", label: "오후 8시", detailLabel: "다음 저녁 러닝", startAt: evening, immediate: false },
  ].map((plan) => {
    const startMinutes = Math.max(0, Math.round((plan.startAt.getTime() - now.getTime()) / 60_000));
    return {
      ...plan,
      startMinutes,
      endAt: new Date(plan.startAt.getTime() + 60 * 60_000),
      sampleMinutes: [startMinutes, startMinutes + 30, startMinutes + 60],
    };
  });
}

export function nextRunModeBoundary(now = new Date()) {
  return [nextKstOccurrence(6, now), nextKstOccurrence(20, now)]
    .sort((a, b) => a.getTime() - b.getTime())[0];
}

function latestRadarBase() {
  // 그래픽 생성 지연을 고려해 15분 전을 5분 단위로 내립니다.
  const delayed = new Date(Date.now() - 15 * 60_000);
  const p = kstParts(delayed);
  const roundedMinute = String(Math.floor(Number(p.minute) / 5) * 5).padStart(2, "0");
  return `${p.year}${p.month}${p.day}${p.hour}${roundedMinute}`;
}

function normalizeApiKey(key) {
  try { return decodeURIComponent(key); }
  catch { return key; }
}

function getKmaBaseTime(now = new Date()) {
  const p = kstParts(now);
  let base = new Date(now.getTime());
  // 초단기예보는 매시 30분 생산이며 안전하게 45분 이후 최신 회차를 사용합니다.
  if (Number(p.minute) < 45) base = new Date(now.getTime() - 60 * 60 * 1000);
  const bp = kstParts(base);
  return { baseDate: `${bp.year}${bp.month}${bp.day}`, baseTime: `${bp.hour}30` };
}

function latLonToKmaGrid(lat, lon) {
  const RE = 6371.00877, GRID = 5.0, SLAT1 = 30.0, SLAT2 = 60.0;
  const OLON = 126.0, OLAT = 38.0, XO = 43, YO = 136;
  const DEGRAD = Math.PI / 180.0;
  const re = RE / GRID;
  const slat1 = SLAT1 * DEGRAD, slat2 = SLAT2 * DEGRAD;
  const olon = OLON * DEGRAD, olat = OLAT * DEGRAD;
  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = Math.pow(sf, sn) * Math.cos(slat1) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = re * sf / Math.pow(ro, sn);
  let ra = Math.tan(Math.PI * 0.25 + lat * DEGRAD * 0.5);
  ra = re * sf / Math.pow(ra, sn);
  let theta = lon * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;
  return {
    nx: Math.floor(ra * Math.sin(theta) + XO + 0.5),
    ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5),
  };
}

function parseRainMm(value) {
  if (value == null || value === "") return null;
  const text = String(value);
  if (text.includes("강수없음")) return 0;
  if (text.includes("미만")) return 0.5;
  const match = text.match(/[\d.]+/);
  return match ? Number(match[0]) : null;
}

function rainLevel(mm, pty) {
  if (Number(pty) > 0 || mm >= 1) return mm >= 5 ? "heavy" : mm >= 1 ? "moderate" : "light";
  if (mm == null && (pty == null || pty === "")) return "unknown";
  if (mm > 0) return "light";
  return "none";
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function roundToFive(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value / 5) * 5)) : null;
}

function nearestForecast(groups, targetDate) {
  let best = null;
  let bestDiff = Infinity;
  for (const group of groups.values()) {
    const date = new Date(`${group.fcstDate.slice(0, 4)}-${group.fcstDate.slice(4, 6)}-${group.fcstDate.slice(6, 8)}T${group.fcstTime.slice(0, 2)}:${group.fcstTime.slice(2, 4)}:00+09:00`);
    const diff = Math.abs(date.getTime() - targetDate.getTime());
    if (diff < bestDiff) { bestDiff = diff; best = { ...group, date }; }
  }
  return best ? { ...best, targetDiffMinutes: Math.round(bestDiff / 60_000) } : null;
}

function forecastTimestamp(date, time) {
  return new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:00+09:00`);
}

async function getKmaForecast(serviceKey, route, requestedMinutes = [0, 30, 60, 180, 360, 540], now = new Date(), cacheTrace = []) {
  const { nx, ny } = latLonToKmaGrid(route.lat, route.lon);
  const { baseDate, baseTime } = getKmaBaseTime(now);
  const normalizedKey = normalizeApiKey(serviceKey);
  const params = new URLSearchParams({
    serviceKey: normalizedKey,
    pageNo: "1", numOfRows: "1000", dataType: "JSON",
    base_date: baseDate, base_time: baseTime,
    nx: String(nx), ny: String(ny),
  });
  const allMinutes = uniqueMinutes(requestedMinutes);
  // 단기예보와 초단기예보는 서로 의존하지 않으므로 동시에 요청합니다.
  const villageForecastPromise = getKmaVilageForecastSet(serviceKey, route, allMinutes, now, cacheTrace).catch(() => []);
  const url = `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtFcst?${params}`;
  let items = [];
  let ultraError = null;
  try {
    const payload = await cachedRawLoad(buildRawCacheKey({
      provider: "kma", dataset: "ultra-srt-fcst", location: `nx${nx}-ny${ny}`,
      cycle: `${baseDate}${baseTime}`, variant: "json-r1000",
    }), () => fetchJson(url), { trace: cacheTrace, sourceIssuedAt: forecastTimestamp(baseDate, baseTime).toISOString() });
    const header = payload?.response?.header;
    if (header?.resultCode !== "00") throw new Error(header?.resultMsg || "기상청 응답 오류");
    items = payload?.response?.body?.items?.item || [];
  } catch (error) {
    // 가까운 초단기예보만 빠져도, 예약 시간용 단기예보까지 버리지는 않습니다.
    ultraError = error;
  }
  const groups = new Map();
  for (const item of items) {
    const key = `${item.fcstDate}${item.fcstTime}`;
    if (!groups.has(key)) groups.set(key, { fcstDate: item.fcstDate, fcstTime: item.fcstTime });
    groups.get(key)[item.category] = item.fcstValue;
  }
  // 초단기예보는 가까운 시각에만 사용하고, 그 밖의 예약 러닝은 단기예보를
  // 해당 절대 시각에 맞춰 조회합니다. 9시간 값을 06시/20시에 억지로 쓰지 않습니다.
  const offsets = allMinutes.filter((minutes) => minutes <= 360);
  const issuedAt = forecastTimestamp(baseDate, baseTime);
  const ultraForecast = offsets.map((minutes) => {
    const target = new Date(now.getTime() + minutes * 60_000);
    const group = nearestForecast(groups, target);
    const previousGroup = nearestForecast(groups, new Date(target.getTime() - 60 * 60_000));
    const nextGroup = nearestForecast(groups, new Date(target.getTime() + 60 * 60_000));
    const mm = parseRainMm(group?.RN1);
    const level = rainLevel(mm, group?.PTY);
    return {
      minutes,
      rain: !["none", "unknown"].includes(level),
      level,
      mm, precipitationType: numberOrNull(group?.PTY), unavailable: mm == null || !group || group.targetDiffMinutes > 45,
      amountText: mm > 0 ? String(group?.RN1 || `${mm} mm`) : "0 mm",
      amountPeriod: "1시간 기준",
      temperature: numberOrNull(group?.T1H),
      humidity: numberOrNull(group?.REH),
      windSpeed: numberOrNull(group?.WSD),
      sourceTime: group?.date?.toISOString() || null,
      issuedAt: issuedAt.toISOString(),
      issueAgeMinutes: Math.max(0, Math.round((now.getTime() - issuedAt.getTime()) / 60_000)),
      targetDiffMinutes: group?.targetDiffMinutes ?? null,
      previousHourMm: parseRainMm(previousGroup?.RN1),
      nextHourMm: parseRainMm(nextGroup?.RN1),
      source: "ultra",
      sourceLabel: "초단기예보",
    };
  });
  const villageForecast = await villageForecastPromise;
  if (!items.length && !villageForecast.length) throw ultraError || new Error("사용 가능한 기상청 예보가 없습니다.");
  const villageByMinutes = new Map(villageForecast.map((item) => [item.minutes, item]));
  const ultraByMinutes = new Map(ultraForecast.map((item) => [item.minutes, item]));
  const forecast = allMinutes.map((minutes) => {
    const item = ultraByMinutes.get(minutes);
    if (!item) return villageByMinutes.get(minutes) || {
      minutes, rain: false, level: "unknown", mm: 0,
      temperature: null, humidity: null, windSpeed: null, probability: null,
      sourceTime: null, source: "village", sourceLabel: "단기예보 없음", unavailable: true,
    };
    const probabilityForecast = villageByMinutes.get(item.minutes);
    const probability = probabilityForecast?.probability;
    if (item.targetDiffMinutes != null && item.targetDiffMinutes <= 45) {
      return {
        ...item,
        probability: Number.isFinite(probability) ? probability : null,
        probabilitySource: Number.isFinite(probability) ? "단기예보" : null,
        probabilityRain: Boolean(probabilityForecast?.rain),
        probabilityLevel: probabilityForecast?.level || "none",
        probabilityAmountText: probabilityForecast?.amountText || null,
        villageMm: probabilityForecast?.mm ?? null,
        previousHourMm: probabilityForecast?.previousHourMm ?? item.previousHourMm,
        nextHourMm: probabilityForecast?.nextHourMm ?? item.nextHourMm,
        nextHourProbability: probabilityForecast?.nextHourProbability ?? null,
      };
    }
    return villageByMinutes.get(item.minutes) || { ...item, sourceLabel: "초단기예보 · 시각 차이", staleForTarget: true };
  });
  return forecast;
}

function shortForecastBaseCandidates(now = new Date()) {
  const slots = [23, 20, 17, 14, 11, 8, 5, 2];
  const candidates = [];
  for (let dayOffset = 0; dayOffset < 2; dayOffset += 1) {
    const date = new Date(now.getTime() - dayOffset * 86_400_000);
    const p = kstParts(date);
    for (const hour of slots) {
      const issuedAt = new Date(`${p.year}-${p.month}-${p.day}T${String(hour).padStart(2, "0")}:00:00+09:00`);
      if (issuedAt.getTime() <= now.getTime() - 20 * 60_000) {
        candidates.push({ baseDate: `${p.year}${p.month}${p.day}`, baseTime: `${String(hour).padStart(2, "0")}00` });
      }
    }
  }
  return candidates;
}

async function getKmaVilageForecastSet(serviceKey, route, minutesList, now = new Date(), cacheTrace = []) {
  const { nx, ny } = latLonToKmaGrid(route.lat, route.lon);
  const normalizedKey = normalizeApiKey(serviceKey);
  for (const { baseDate, baseTime } of shortForecastBaseCandidates(now).slice(0, 6)) {
    const params = new URLSearchParams({
      serviceKey: normalizedKey, pageNo: "1", numOfRows: "2000", dataType: "JSON",
      base_date: baseDate, base_time: baseTime, nx: String(nx), ny: String(ny),
    });
    let payload;
    try {
      payload = await cachedRawLoad(buildRawCacheKey({
        provider: "kma", dataset: "village-fcst", location: `nx${nx}-ny${ny}`,
        cycle: `${baseDate}${baseTime}`, variant: "json-r2000",
      }), () => fetchJson(`https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst?${params}`), {
        trace: cacheTrace, sourceIssuedAt: forecastTimestamp(baseDate, baseTime).toISOString(),
      });
    }
    catch { continue; }
    if (payload?.response?.header?.resultCode !== "00") continue;
    const items = payload?.response?.body?.items?.item || [];
    if (!items.some((item) => item.category === "PTY") || !items.some((item) => item.category === "PCP")) continue;
    const groups = new Map();
    for (const item of items) {
      const key = `${item.fcstDate}${item.fcstTime}`;
      if (!groups.has(key)) groups.set(key, { fcstDate: item.fcstDate, fcstTime: item.fcstTime });
      groups.get(key)[item.category] = item.fcstValue;
    }
    const issuedAt = forecastTimestamp(baseDate, baseTime);
    return minutesList.map((minutes) => {
      const target = new Date(now.getTime() + minutes * 60_000);
      const group = nearestForecast(groups, target);
      if (!group || group.targetDiffMinutes > 45) return null;
      const previousGroup = nearestForecast(groups, new Date(target.getTime() - 60 * 60_000));
      const nextGroup = nearestForecast(groups, new Date(target.getTime() + 60 * 60_000));
      const mm = parseRainMm(group.PCP);
      const level = rainLevel(mm, group.PTY);
      return {
        minutes, rain: !["none", "unknown"].includes(level), level, mm, precipitationType: numberOrNull(group.PTY), unavailable: mm == null,
        amountText: mm > 0 ? String(group.PCP || `${mm} mm`) : "0 mm",
        amountPeriod: "1시간 기준",
        temperature: numberOrNull(group.TMP), humidity: numberOrNull(group.REH), windSpeed: numberOrNull(group.WSD),
        probability: numberOrNull(group.POP), probabilitySource: "단기예보", sourceTime: group.date?.toISOString() || null,
        issuedAt: issuedAt.toISOString(),
        issueAgeMinutes: Math.max(0, Math.round((now.getTime() - issuedAt.getTime()) / 60_000)),
        targetDiffMinutes: group.targetDiffMinutes,
        previousHourMm: parseRainMm(previousGroup?.PCP),
        nextHourMm: parseRainMm(nextGroup?.PCP),
        nextHourProbability: Number.isFinite(Number(nextGroup?.POP)) ? Number(nextGroup.POP) : null,
        probabilityRain: level !== "none",
        probabilityLevel: level,
        probabilityAmountText: mm > 0 ? String(group.PCP || `${mm} mm`) : "0 mm",
        source: "village", sourceLabel: "단기예보",
      };
    }).filter(Boolean);
  }
  throw new Error("사용 가능한 단기예보 회차가 없습니다.");
}

function recentObservationBases(now = new Date(), count = 3) {
  const parts = kstParts(now);
  let latest = new Date(now.getTime());
  if (Number(parts.minute) < 45) latest = new Date(now.getTime() - 60 * 60_000);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(latest.getTime() - index * 60 * 60_000);
    const value = kstParts(date);
    return { baseDate: `${value.year}${value.month}${value.day}`, baseTime: `${value.hour}00` };
  });
}

async function getKmaRecentConditions(serviceKey, route, now = new Date(), cacheTrace = []) {
  const { nx, ny } = latLonToKmaGrid(route.lat, route.lon);
  const normalizedKey = normalizeApiKey(serviceKey);
  const results = await Promise.allSettled(recentObservationBases(now).map(async ({ baseDate, baseTime }) => {
    const params = new URLSearchParams({
      serviceKey: normalizedKey, pageNo: "1", numOfRows: "100", dataType: "JSON",
      base_date: baseDate, base_time: baseTime, nx: String(nx), ny: String(ny),
    });
    const payload = await cachedRawLoad(buildRawCacheKey({
      provider: "kma", dataset: "ultra-srt-ncst", location: `nx${nx}-ny${ny}`,
      cycle: `${baseDate}${baseTime}`, variant: "json-r100",
    }), () => fetchJson(`https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst?${params}`, { timeout: 8_000 }), {
      trace: cacheTrace, sourceIssuedAt: forecastTimestamp(baseDate, baseTime).toISOString(),
    });
    if (payload?.response?.header?.resultCode !== "00") throw new Error("기상청 실황 응답 오류");
    const values = Object.fromEntries((payload?.response?.body?.items?.item || []).map((item) => [item.category, item.obsrValue]));
    return {
      observedAt: forecastTimestamp(baseDate, baseTime).toISOString(),
      rainMm: parseRainMm(values.RN1),
      temperature: Number(values.T1H ?? NaN), humidity: Number(values.REH ?? NaN), windSpeed: Number(values.WSD ?? NaN),
    };
  }));
  const observations = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
  observations.sort((a, b) => new Date(a.observedAt) - new Date(b.observedAt));
  if (!observations.length) throw new Error("최근 초단기실황을 찾지 못했습니다.");
  const amounts = observations.map((item) => item.rainMm).filter(Number.isFinite);
  const latest = amounts.at(-1) ?? 0, previous = amounts.at(-2) ?? latest;
  const trend = latest >= previous + 0.5 ? "increasing" : latest + 0.5 <= previous ? "easing" : "steady";
  return {
    source: "기상청 초단기실황", observations,
    latestRainMm: latest,
    recentTotalMm: Math.round(amounts.reduce((sum, value) => sum + value, 0) * 10) / 10,
    recentMaxMm: Math.max(0, ...amounts), trend,
  };
}

async function getMultiModelForecast(route, minutesList, now = new Date(), cacheTrace = []) {
  const params = new URLSearchParams({
    latitude: String(route.lat), longitude: String(route.lon),
    hourly: "precipitation_probability,precipitation",
    models: "kma_seamless,ecmwf_ifs025,gfs_seamless,jma_seamless,icon_seamless",
    timezone: "Asia/Seoul", forecast_days: "2",
  });
  const modelSet = ["ecmwf_ifs025", "gfs_seamless", "icon_seamless", "jma_seamless", "kma_seamless"].join(",");
  const payload = await cachedRawLoad(buildRawCacheKey({
    provider: "open-meteo", dataset: "forecast", location: `lat${route.lat.toFixed(4)}-lon${route.lon.toFixed(4)}`,
    cycle: "rolling-2d", variant: `hourly-pop-precip-${modelSet}`,
  }), () => fetchJson(`https://api.open-meteo.com/v1/forecast?${params}`, { timeout: 15_000 }), { trace: cacheTrace });
  const hourly = payload?.hourly || {};
  const times = (hourly.time || []).map((value) => new Date(`${value}:00+09:00`));
  const models = [
    { id: "kma", label: "KMA", probability: "precipitation_probability_kma_seamless", amount: "precipitation_kma_seamless" },
    { id: "ecmwf", label: "ECMWF", probability: "precipitation_probability_ecmwf_ifs025", amount: "precipitation_ecmwf_ifs025" },
    { id: "gfs", label: "GFS", probability: "precipitation_probability_gfs_seamless", amount: "precipitation_gfs_seamless" },
    { id: "jma", label: "JMA", probability: "precipitation_probability_jma_seamless", amount: "precipitation_jma_seamless" },
    { id: "icon", label: "ICON", probability: "precipitation_probability_icon_seamless", amount: "precipitation_icon_seamless" },
  ];
  const nearestIndex = (target) => {
    let best = -1, bestDiff = Infinity;
    times.forEach((time, index) => {
      const diff = Math.abs(time.getTime() - target.getTime());
      if (diff < bestDiff) { best = index; bestDiff = diff; }
    });
    return best;
  };
  return minutesList.map((minutes) => {
    const target = new Date(now.getTime() + minutes * 60_000);
    const index = nearestIndex(target);
    if (index < 0 || Math.abs(times[index].getTime()-target.getTime()) > 45*60000) return null;
    const numeric = (value) => value == null || value === "" ? null : Number(value);
    const values = models.map((model) => {
      const probability = numeric(hourly[model.probability]?.[index]);
      const nextProbability = numeric(hourly[model.probability]?.[Math.min(times.length - 1, index + 1)]);
      const amount = numeric(hourly[model.amount]?.[index]);
      const previousAmount = numeric(hourly[model.amount]?.[Math.max(0, index - 1)]);
      const nextAmount = numeric(hourly[model.amount]?.[Math.min(times.length - 1, index + 1)]);
      return {
        id: model.id, label: model.label,
        probability: Number.isFinite(probability) ? probability : null,
        nextProbability: Number.isFinite(nextProbability) ? nextProbability : null,
        amount: Number.isFinite(amount) ? amount : null,
        previousAmount: Number.isFinite(previousAmount) ? previousAmount : null,
        nextAmount: Number.isFinite(nextAmount) ? nextAmount : null,
      };
    }).filter((model) => Number.isFinite(model.probability) || Number.isFinite(model.amount));
    const probabilities = values.flatMap((model) => [model.probability, model.nextProbability]).filter(Number.isFinite);
    const amounts = values.map((model) => model.amount).filter(Number.isFinite);
    const wetVotes = values.filter((model) =>
      (Number.isFinite(model.probability) && model.probability >= 50)
      || (Number.isFinite(model.nextProbability) && model.nextProbability >= 50)
      || (Number.isFinite(model.amount) && model.amount >= 0.2)
      || (Number.isFinite(model.nextAmount) && model.nextAmount >= 0.2)
    ).length;
    return {
      minutes, validAt: times[index]?.toISOString() || null, models: values,
      probabilityAverage: roundToFive(average(probabilities)),
      probabilityMin: probabilities.length ? Math.min(...probabilities) : null,
      probabilityMax: probabilities.length ? Math.max(...probabilities) : null,
      amountMedian: median(amounts), amountMax: amounts.length ? Math.max(...amounts) : null,
      previousAmountMedian: median(values.map((model) => model.previousAmount)),
      nextAmountMedian: median(values.map((model) => model.nextAmount)),
      wetVotes, availableModels: values.length,
    };
  }).filter(Boolean);
}

export function assessRunForecast(item, recentConditions) {
  if (item.unavailable || item.source === "demo") return {
    level: "unknown", reasonCode: "unavailable", headline: "자료가 부족해 판단하기 어려워요",
    label: "자료가 부족해 판단하기 어려워요", reason: "자료가 부족해 판단하기 어려워요",
    expectedAmount: null, combinedRisk: null, windowPeak: null, surface: "unknown",
  };
  const metrics = runSampleMetrics(item, recentConditions);
  // Keep the long-standing point API (go/caution/avoid) while deriving its
  // verdict from the same classifier used by full run windows.
  const evaluated = evaluateRunWindow([{ ...item, runAssessment: metrics }]);
  const decision = evaluated.decision;
  const level = decision.level === "red" ? "avoid" : decision.level === "yellow" ? "caution" : decision.level === "green" ? "go" : "unknown";
  return {
    ...metrics,
    level, label: decision.headline, headline: decision.headline, reasonCode: decision.reasonCode,
    reason: decision.reason, combinedRisk: metrics.chance, windowPeak: metrics.expectedAmount,
  };
}

function parseXmlTag(block, tag) {
  return (block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i")) || [])[1]?.trim() || "";
}

function normalizeCctv(item, target) {
  const lat = Number(item.coordy), lon = Number(item.coordx);
  const dy = lat - target.lat, dx = (lon - target.lon) * Math.cos(target.lat * Math.PI / 180);
  const angle = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  const sector = angle < 22.5 || angle >= 337.5 ? "북" : angle < 67.5 ? "북동" : angle < 112.5 ? "동" : angle < 157.5 ? "남동" : angle < 202.5 ? "남" : angle < 247.5 ? "남서" : angle < 292.5 ? "서" : "북서";
  const distance = haversine(target.lat, target.lon, lat, lon);
  return {
    id: `${lat.toFixed(5)}-${lon.toFixed(5)}`,
    name: item.cctvname || "이름 없는 CCTV",
    lat, lon, sector, distance: Math.round(distance * 10) / 10,
    url: item.cctvurl,
    format: item.cctvformat || "",
    cctvType: String(item.cctvtype || ""),
    rainNow: "unknown", intensity: "unknown", confidence: 0,
    evidence: "아직 확인하지 않음",
  };
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, p = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * p / 2) ** 2 + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin((lon2 - lon1) * p / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function chooseDirectionalCctv(cameras) {
  // 러닝 본문은 가까운 카메라부터 보여 줍니다. 동률은 API에서 정한 안정적인 좌표 ID로 정렬합니다.
  return cameras.slice().sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id)).slice(0, 8);
}

function itsResponseError(message = "ITS CCTV 응답 오류") {
  const error = new Error(message);
  error.code = "ITS_INVALID_RESPONSE";
  return error;
}

export function parseItsCctvResponse(text) {
  const source=String(text || "").trim();
  if (!source) throw itsResponseError("ITS CCTV 응답이 비어 있습니다.");
  try {
    const json=JSON.parse(source), response=json?.response;
    if (!response || typeof response !== "object") throw itsResponseError("ITS CCTV JSON 형식을 확인하지 못했습니다.");
    const errorMessage=response.error || response.errorMessage || response.message;
    if (errorMessage || String(response.resultCode || "") === "000") throw itsResponseError(`ITS CCTV 오류: ${errorMessage || response.resultMsg || "System error"}`);
    if (Array.isArray(response.data)) return response.data;
    if (String(response.datacount ?? "") === "0" && (response.data == null)) return [];
    throw itsResponseError("ITS CCTV 목록 형식을 확인하지 못했습니다.");
  } catch (error) {
    if (error?.code === "ITS_INVALID_RESPONSE") throw error;
  }
  if (!/<(?:\w+:)?response\b/i.test(source) || /<html\b|<title\b/i.test(source)) throw itsResponseError("ITS CCTV 응답 형식을 확인하지 못했습니다.");
  const resultCode=parseXmlTag(source,"resultCode"), resultMessage=parseXmlTag(source,"resultMsg") || parseXmlTag(source,"message");
  if (resultCode === "000" || /(?:error|인증|system)/i.test(resultMessage)) throw itsResponseError(`ITS CCTV 오류: ${resultMessage || "System error"}`);
  const raw=[...source.matchAll(/<data>([\s\S]*?)<\/data>/gi)].map((match) => ({
    cctvname: parseXmlTag(match[1], "cctvname"),
    coordx: parseXmlTag(match[1], "coordx"), coordy: parseXmlTag(match[1], "coordy"),
    cctvurl: parseXmlTag(match[1], "cctvurl"), cctvformat: parseXmlTag(match[1], "cctvformat"),
    cctvtype: parseXmlTag(match[1], "cctvtype"),
  }));
  if (raw.length) return raw;
  if (parseXmlTag(source,"datacount") === "0") return [];
  throw itsResponseError("ITS CCTV 목록 형식을 확인하지 못했습니다.");
}

async function getItsCctv(apiKey, target, cacheTrace = []) {
  const params = new URLSearchParams({
    apiKey, type: "all", cctvType: "3",
    minX: String(target.lon - 0.55), maxX: String(target.lon + 0.55),
    minY: String(target.lat - 0.42), maxY: String(target.lat + 0.42),
    getType: "json",
  });
  const location = `bbox${(target.lon - .55).toFixed(3)},${(target.lat - .42).toFixed(3)},${(target.lon + .55).toFixed(3)},${(target.lat + .42).toFixed(3)}`;
  const raw = await cachedRawLoad(buildRawCacheKey({
    provider: "its", dataset: "cctv-info", location, cycle: "live", variant: "type-all-cctv3-jsonxml",
  }), async () => parseItsCctvResponse(await httpsGetText(`https://openapi.its.go.kr:9443/cctvInfo?${params}`, {
    timeout: 12_000,
    headers: { "User-Agent": "RunCast-Jamsil/0.1 local-dashboard", Accept: "application/json, application/xml" },
  })), { trace: cacheTrace, freshMs: 25_000, staleMs: 45_000, failureMs: 20_000 });
  const cameras = raw.map((item) => normalizeCctv(item, target)).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon) && c.url && c.distance <= 15);
  const chosen = chooseDirectionalCctv(cameras);
  for (const camera of chosen) knownCctvUrls.add(camera.url);
  const event=cacheTrace.filter(item=>item.provider === "its" && item.dataset === "cctv-info" && (item.fetchedAt || item.retryAt)).at(-1);
  return { cameras: chosen, cache: event ? { fetchedAt:event.fetchedAt || null, usableUntil:event.staleUntil || null, retryAt:event.retryAt || null, stale:Boolean(event.stale || ["stale-if-error","stale-cooldown"].includes(event.state)) } : null };
}

async function getAviation(cacheTrace = []) {
  const headers = { "User-Agent": "RunCast-Jamsil/0.1 contact=local-user" };
  const stations = [
    { id: "RKSM", label: "성남 서울공항", role: "잠실 남쪽·가장 가까움" },
    { id: "RKSS", label: "김포공항", role: "서울 서쪽" },
    { id: "RKSI", label: "인천공항", role: "수도권 서쪽" },
  ];
  const stationIds = stations.map((station) => station.id).sort().join(",");
  const stationInfo = new Map(stations.map((station, index) => [station.id, { ...station, order: index }]));
  const byStationOrder = (a, b) => (stationInfo.get(a.icaoId)?.order ?? 99) - (stationInfo.get(b.icaoId)?.order ?? 99);
  const [metar, taf] = await Promise.allSettled([
    cachedRawLoad(buildRawCacheKey({ provider: "aviationweather", dataset: "metar", location: `stations-${stationIds}`, cycle: "latest", variant: "json" }),
      () => fetchJson(`https://aviationweather.gov/api/data/metar?ids=${stationIds}&format=json`, { headers, timeout: 12_000 }), { trace: cacheTrace }),
    cachedRawLoad(buildRawCacheKey({ provider: "aviationweather", dataset: "taf", location: `stations-${stationIds}`, cycle: "latest", variant: "json" }),
      () => fetchJson(`https://aviationweather.gov/api/data/taf?ids=${stationIds}&format=json`, { headers, timeout: 12_000 }), { trace: cacheTrace }),
  ]);
  const metars = metar.status === "fulfilled" ? metar.value : [];
  const tafs = taf.status === "fulfilled" ? taf.value : [];
  return {
    metar: metars.sort(byStationOrder).map((item) => ({ id: item.icaoId, label: stationInfo.get(item.icaoId)?.label || item.icaoId, role: stationInfo.get(item.icaoId)?.role || "", raw: item.rawOb || item.raw_text || "", obsTime: item.obsTime || null })),
    taf: tafs.sort(byStationOrder).map((item) => ({ id: item.icaoId, label: stationInfo.get(item.icaoId)?.label || item.icaoId, role: stationInfo.get(item.icaoId)?.role || "", raw: item.rawTAF || item.raw_text || "", issueTime: item.issueTime || null })),
  };
}

function makeDecisionForRunWindow(runWindow, cctvs = []) {
  return evaluateRunWindow(runWindow, cctvs).decision;
}

export function makeDecision(forecast, cctvs = []) {
  return makeDecisionForRunWindow(forecast.filter((f) => f.minutes <= 60), cctvs);
}

/**
 * 1시간 러닝 카드에 쓰는 창(window) 단위 요약입니다.
 * 각 점의 PCP/RN1은 시간당 값이므로, 시작·30분·복귀의 선형 보간으로
 * 1시간 동안의 예상 누적량을 보수적으로 근사하고 최대 시간당 강수량도 별도 제공합니다.
 */
export function summarizeRunWindow(samples = []) {
  return evaluateRunWindow(samples).summary;
}

function makeRunModes(plans, forecast, now = new Date()) {
  const byMinute = new Map(forecast.map((item) => [item.minutes, item]));
  return plans.map((plan) => {
    const samples = plan.sampleMinutes.map((minutes, index) => {
      const item = byMinute.get(minutes) || {
        minutes, unavailable: true, probability: null, mm: 0,
        sourceLabel: "해당 시각 예보 없음", runAssessment: { level: "caution", expectedAmount: null, surface: "dry" },
      };
      // 조회는 가장 가까운 분 단위로 하지만 화면 시간은 사용자가 고른 정확한 출발 시각을 씁니다.
      return { ...item, phase: index === 0 ? "출발" : index === 1 ? "30분" : "복귀", at: new Date(plan.startAt.getTime() + index * 30 * 60_000).toISOString() };
    });
    const evaluated = evaluateRunWindow(samples, [], { requireSamples: 3 });
    const decision = evaluated.decision;
    const summary = evaluated.summary;
    const withinMapHorizon = plan.startMinutes <= 540;
    return {
      id: plan.id, label: plan.label, detailLabel: plan.detailLabel, immediate: plan.immediate,
      departureAt: plan.startAt.toISOString(), endAt: plan.endAt.toISOString(),
      startMinutes: plan.startMinutes, withinMapHorizon,
      mapHorizonMinutes: withinMapHorizon ? Math.max(0, Math.round(plan.startMinutes / 5) * 5) : null,
      samples, summary, decision,
    };
  });
}

function radarSummary(keys, demo) {
  return {
    configured: Boolean(activeRadarKey),
    direction: "남서 → 북동",
    etaMinutes: null,
    imageUrl: activeRadarKey ? `/api/radar?minutes=30&v=${Date.now()}` : null,
    frameStepMinutes: 5,
    maxMapleMinutes: 60,
    blendFromMinutes: 180,
    maxBlendMinutes: 720,
    raster: { sourceX: 0, sourceY: 20, width: 700, height: 700 },
    lcc: {
      lat1: 30, lat2: 60, lat0: 0, lon0: 126,
      xMin: -440000.00000000227, yMin: 3797382.7212162036,
      xMax: 584000.0000000008, yMax: 4821382.721216239,
    },
    projectionNote: "KMA HR LCC 격자를 WGS84로 재투영 · 제주/울릉도 해안선 기준 1px 이내 검증",
    officialUrl: "https://www.weather.go.kr/w/weather/radar/radar.do",
  };
}

function oldestForecastFetch(trace) {
  const dates = trace.filter(t => t.provider === "kma" && ["ultra-srt-fcst", "village-fcst"].includes(t.dataset) && ["stored", "fresh-hit", "stale-if-error", "stale-cooldown", "coalesced-result"].includes(t.state)).map(t => t.fetchedAt).filter(Boolean).sort();
  return dates[0] || null;
}

function refreshMetadata(trace = []) {
  const retryStates = ["stale-if-error", "stale-cooldown", "negative-hit"];
  const relevant = trace.filter(event => event?.stale || retryStates.includes(event?.state) || event?.retryAt);
  const retryValues = relevant.map(event => Date.parse(event.retryAt || "")).filter(Number.isFinite);
  return {
    stale: relevant.some(event => event?.stale || ["stale-if-error", "stale-cooldown"].includes(event?.state)),
    retryAt: retryValues.length ? new Date(Math.max(...retryValues)).toISOString() : null,
  };
}

async function weeklyForecast(body) {
  const location = resolveLocation(body), trace = [];
  const params = new URLSearchParams({
    latitude: String(location.lat), longitude: String(location.lon), timezone: "Asia/Seoul", forecast_days: "8", wind_speed_unit: "ms",
    hourly: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,precipitation_probability,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code",
    daily: "temperature_2m_min,temperature_2m_max,weather_code,sunrise,sunset",
  });
  // Eighth day's midnight provides the return sample for day seven at 23:00.
  const payload = await cachedRawLoad(buildRawCacheKey({ provider: "open-meteo", dataset: "weekly", location: `${location.lat},${location.lon}`, cycle: kstDateKey(new Date()), variant: "v2-8d-ms-solar" }), async () => {
    const data = await fetchJson(`https://api.open-meteo.com/v1/forecast?${params}`, { timeout: 15000 });
    normalizeWeekly(data, location, new Date().toISOString());
    return data;
  }, { trace, freshMs: 30*60000, staleMs: 7*86400000 });
  const entry = trace.filter(t => t.fetchedAt).at(-1);
  if (!entry) throw new Error("예보 조회 시각을 확인하지 못했습니다.");
  const normalized = normalizeWeekly(payload, location, entry.fetchedAt);
  const refresh = refreshMetadata(trace);
  return { ...normalized, refresh, cache: { stale: refresh.stale, retryAt: refresh.retryAt } };
}

async function mobileForecast(body) {
  const route = resolveLocation(body);
  const keys = effectiveKeys(body.keys);
  activeRadarKey = String(keys.kmaHubKey || "").trim();
  if (!activeRadarKey) radarCache.clear();
  // 결과 payload는 매번 새로 조립합니다. 캐시되는 것은 아래 원천 API 응답뿐입니다.
  const cacheTrace = [];
  const errors = [];
  let demo = false;
  let forecast;
  const now = new Date();
  const mapMinutes = [0, 30, 60, 180, 360, 540];
  const runPlans = createRunModePlans(now);
  const requestedMinutes = uniqueMinutes([...mapMinutes, ...runPlans.flatMap((plan) => plan.sampleMinutes)]);
  if (keys.kmaServiceKey) {
    try { forecast = await getKmaForecast(keys.kmaServiceKey, route, requestedMinutes, now, cacheTrace); }
    catch (error) { errors.push(`기상청: ${error.message}`); }
  }
  if (!forecast) {
    forecast = requestedMinutes.map(minutes => ({
      minutes, rain: false, level: "unknown", mm: null, probability: null,
      temperature: null, humidity: null, windSpeed: null,
      amountText: "자료 없음", source: "unavailable", sourceLabel: "예보 없음", unavailable: true,
    }));
  }

  let recentConditions = null, multiModelForecast = [];
  const contextResults = await Promise.allSettled([
    keys.kmaServiceKey ? getKmaRecentConditions(keys.kmaServiceKey, route, now, cacheTrace) : Promise.resolve(null),
    forecast.some(item => !item.unavailable) ? getMultiModelForecast(route, forecast.map((item) => item.minutes), now, cacheTrace) : Promise.resolve([]),
  ]);
  if (contextResults[0].status === "fulfilled") recentConditions = contextResults[0].value;
  else errors.push(`최근 실황: ${contextResults[0].reason?.message || "조회 실패"}`);
  if (contextResults[1].status === "fulfilled") multiModelForecast = contextResults[1].value;
  else errors.push(`다중모델: ${contextResults[1].reason?.message || "조회 실패"}`);
  const multiByMinutes = new Map(multiModelForecast.map((item) => [item.minutes, item]));
  forecast = forecast.map((item) => {
    const enriched = { ...item, multiModel: multiByMinutes.get(item.minutes) || null };
    return { ...enriched, runAssessment: assessRunForecast(enriched, recentConditions) };
  });

  const runModes = makeRunModes(runPlans, forecast, now);
  // 기존 지도/데스크톱 계약은 현재 기준의 지도 시간축만 유지합니다.
  // 예약 러닝의 절대 시각 샘플은 runModes 아래로 별도 전달합니다.
  const mapForecast = mapMinutes.map((minutes) => forecast.find((item) => item.minutes === minutes)).filter(Boolean);
  const refresh = { ...refreshMetadata(cacheTrace), failed: !forecast.some(item => !item.unavailable) };
  const payload = {
    generatedAt: now.toISOString(), dataUpdatedAt: oldestForecastFetch(cacheTrace), route, forecast: mapForecast, runModes, recentConditions,
    cctvs: [], cctv: { configured: Boolean(keys.itsApiKey), available: false, included: false }, aviation: { metar: [], taf: [] },
    decision: makeDecision(mapForecast, []), demo, errors,
    radar: radarSummary(keys, demo),
    refresh,
    cache: { cached: false, ageSeconds: 0, scope: "ui-recomputed", stale: refresh.stale, failed: refresh.failed, retryAt: refresh.retryAt },
    cacheDiagnostics: cacheSummary(cacheTrace),
  };
  return payload;
}

async function mobileContext(body) {
  const route = resolveLocation(body);
  const keys = effectiveKeys(body.keys);
  const cacheTrace = [];
  const errors = [];
  // CCTV와 항공기상은 첫 판단과 독립적이므로 병렬·후속으로 조회합니다.
  const [cctvResult, aviationResult] = await Promise.allSettled([
    keys.itsApiKey ? getItsCctv(keys.itsApiKey, route, cacheTrace) : Promise.resolve({ cameras: [], cache: null }),
    haversine(route.lat, route.lon, 37.5082, 127.1001) <= 65 ? getAviation(cacheTrace) : Promise.resolve({ metar: [], taf: [] }),
  ]);
  const cctvEvent = cacheTrace.filter(item => item.provider === "its" && item.dataset === "cctv-info" && (item.fetchedAt || item.retryAt)).at(-1);
  const cctvPayload = cctvResult.status === "fulfilled" ? cctvResult.value : { cameras: [], cache: cctvEvent ? { fetchedAt: cctvEvent.fetchedAt || null, usableUntil: cctvEvent.staleUntil || null, retryAt: cctvEvent.retryAt || null, stale: Boolean(cctvEvent.stale || ["stale-if-error", "stale-cooldown"].includes(cctvEvent.state)) } : null };
  const cctvs = cctvPayload.cameras;
  if (cctvResult.status === "rejected") errors.push(`CCTV: ${cctvResult.reason?.message || "조회 실패"}`);
  const cctv = {
    configured: Boolean(keys.itsApiKey),
    available: cctvs.length > 0,
    // 목록이 존재해도 AI 관측 전에는 비가 없다는 근거가 아닙니다.
    included: cctvs.some((camera) => ["yes", "no", "uncertain"].includes(camera.rainNow)),
    fetchedAt: cctvPayload.cache?.fetchedAt || null,
    usableUntil: cctvPayload.cache?.usableUntil || null,
    retryAt: cctvPayload.cache?.retryAt || null,
    stale: Boolean(cctvPayload.cache?.stale),
  };
  const aviation = aviationResult.status === "fulfilled" ? aviationResult.value : { metar: [], taf: [] };
  if (aviationResult.status === "rejected") errors.push(`METAR/TAF: ${aviationResult.reason?.message || "조회 실패"}`);
  const refresh = refreshMetadata(cacheTrace);
  return { route, cctvs, cctv, aviation, errors, refresh: { ...refresh, stale: Boolean(cctv.stale || refresh.stale), retryAt: cctv.retryAt || refresh.retryAt, failed: Boolean(keys.itsApiKey && errors.some(error => String(error).startsWith("CCTV:"))) }, cacheDiagnostics: cacheSummary(cacheTrace) };
}

async function snapshot(body) {
  const core = await mobileForecast(body);
  const context = await mobileContext(body);
  return {
    ...core, ...context,
    errors: [...core.errors, ...context.errors],
    decision: makeDecision(core.forecast, context.cctvs),
    cacheDiagnostics: { core: core.cacheDiagnostics, context: context.cacheDiagnostics },
  };
}

async function fetchRadarGraphic(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 720 || minutes % 5 !== 0) {
    throw new Error("강수예측 시간은 0~720분 사이의 5분 단위여야 합니다.");
  }
  const radarKey = RUNTIME_MODE === "public" ? String(LOCAL_KEYS.kmaHubKey || "").trim() : activeRadarKey;
  if (!radarKey) throw new Error("기상청 API허브 키가 설정되지 않았습니다.");

  const tm = latestRadarBase();
  const qpf = minutes <= 60 ? "M" : "B";
  const cacheKey = `${tm}-${qpf}-${minutes}`;
  const cached = radarCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < 4 * 60_000) return cached;

  const params = new URLSearchParams({
    tm,
    qpf,
    eva: "1",
    option: "1",
    ef: String(minutes),
    map: "HR",
    grid: "2",
    legend: "1",
    size: "700",
    itv: qpf === "M" ? "5" : "10",
    zoom_level: "0",
    zoom_x: "0000000",
    zoom_y: "0000000",
    gov: "",
    authKey: normalizeApiKey(radarKey),
  });
  const url = `https://apihub.kma.go.kr/api/typ03/cgi/rdr/nph-qpf_ana_img?${params}`;
  const response = await fetch(url, {
    signal: timeoutSignal(25_000),
    headers: { "User-Agent": "RunCast-Jamsil/0.2 local-dashboard", Accept: "image/png,image/*;q=.9,*/*;q=.1" },
  });
  if (!response.ok) throw new Error(`기상청 레이더 요청 실패 (${response.status})`);
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const data = Buffer.from(await response.arrayBuffer());
  if (!contentType.startsWith("image/") || data.length < 1000) {
    const message = data.toString("utf8", 0, Math.min(data.length, 240)).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    throw new Error(message || "레이더 이미지 응답 형식을 확인할 수 없습니다.");
  }
  const result = { data, contentType, savedAt: Date.now(), tm };
  radarCache.set(cacheKey, result);
  while (radarCache.size > 40) radarCache.delete(radarCache.keys().next().value);
  return result;
}

async function sendRadarGraphic(res, minutes) {
  const graphic = await fetchRadarGraphic(minutes);
  res.writeHead(200, {
    "Content-Type": graphic.contentType,
    "Content-Length": graphic.data.length,
    "Cache-Control": "private, max-age=120",
    "X-Radar-Base-Time": graphic.tm,
  });
  res.end(graphic.data);
}

async function downloadImage(url, filePath) {
  if (!knownCctvUrls.has(url)) throw new Error("현재 조회 목록에 없는 CCTV 주소입니다.");
  const response = await fetch(url, {
    signal: timeoutSignal(20_000), redirect: "follow",
    headers: { "User-Agent": "RunCast-Jamsil/0.1", Accept: "image/*", "Cache-Control": "no-cache" },
  });
  if (!response.ok) throw new Error(`CCTV 이미지 다운로드 실패 (${response.status})`);
  const type = response.headers.get("content-type") || "";
  if (!type.startsWith("image/")) throw new Error(`정지영상이 아닙니다 (${type || "형식 불명"}). ITS에서 정지영상 유형을 신청해야 합니다.`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > 10_000_000) throw new Error("CCTV 이미지가 10MB를 초과합니다.");
  await writeFile(filePath, data);
}

function runProcess(command, args, { cwd, timeout = 180_000, input } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Codex 분석 시간이 초과되었습니다.")); }, timeout);
    if (input != null) child.stdin.end(input);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(stderr.trim() || `프로세스 종료 코드 ${code}`));
    });
  });
}

async function runCodex(args, options) {
  let notFoundError;
  for (const command of CODEX_COMMANDS) {
    try {
      const result = await runProcess(command, args, options);
      return { ...result, command };
    } catch (error) {
      if (error?.code === "ENOENT") {
        notFoundError = error;
        continue;
      }
      throw error;
    }
  }
  throw notFoundError || new Error("Codex CLI 실행 파일을 찾지 못했습니다.");
}

async function analyzeCctv(body) {
  if (!LOCAL_AI_ENABLED) {
    const error = new Error("노면 CCTV AI 분석은 로컬 실행에서만 사용할 수 있습니다.");
    error.statusCode = 403;
    throw error;
  }
  const cameras = (body.cctvs || []).filter((c) => c.url && knownCctvUrls.has(c.url)).slice(0, 4);
  if (!cameras.length) throw new Error("분석 가능한 실제 정지영상 CCTV가 없습니다. 설정에서 ITS 인증키를 입력해 주세요.");
  const taskDir = await mkdtemp(join(tmpdir(), "runcast-cctv-"));
  try {
    const files = [];
    for (let index = 0; index < cameras.length; index += 1) {
      const file = join(taskDir, `${index + 1}-${cameras[index].id}-a.jpg`);
      await downloadImage(cameras[index].url, file);
      files.push(file);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15_000));
    for (let index = 0; index < cameras.length; index += 1) {
      const file = join(taskDir, `${index + 1}-${cameras[index].id}-b.jpg`);
      await downloadImage(cameras[index].url, file);
      files.push(file);
    }

    const schema = {
      type: "object", additionalProperties: false,
      properties: {
        cameras: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            properties: {
              id: { type: "string" },
              rainNow: { type: "string", enum: ["yes", "no", "uncertain"] },
              intensity: { type: "string", enum: ["none", "light", "moderate", "heavy", "unknown"] },
              roadWet: { type: "boolean" }, vehicleSpray: { type: "boolean" }, lensDrops: { type: "boolean" },
              visibility: { type: "string", enum: ["good", "reduced", "poor", "unknown"] },
              cameraUsable: { type: "boolean" }, confidence: { type: "number", minimum: 0, maximum: 1 },
              evidence: { type: "string" }, ambiguity: { type: "string" },
            },
            required: ["id", "rainNow", "intensity", "roadWet", "vehicleSpray", "lensDrops", "visibility", "cameraUsable", "confidence", "evidence", "ambiguity"],
          },
        },
        summary: { type: "string" },
      },
      required: ["cameras", "summary"],
    };
    const schemaPath = join(taskDir, "schema.json"), outputPath = join(taskDir, "result.json");
    await writeFile(schemaPath, JSON.stringify(schema));
    const cameraGuide = cameras.map((c, index) => `${index + 1}번 쌍의 id=${c.id}, 위치=${c.name}, 잠실 기준 ${c.sector}쪽 ${c.distance}km`).join("\n");
    const prompt = `당신은 러닝 직전의 도로 CCTV 강수 관측 분석기다. 각 카메라마다 15초 간격 이미지 두 장이 순서대로 첨부되어 있다. 미래 날씨를 예측하지 말고 이미지에 직접 보이는 현재 강수 증거만 판정하라. 젖은 노면만으로 비가 온다고 판단하지 말고 빗줄기, 차량 물보라의 지속, 와이퍼/낙수, 시야 저하, 렌즈 물방울을 구분하라. 야간 반사, 압축 노이즈, 오래된 젖은 노면은 ambiguity에 적어라. 근거가 약하면 uncertain을 선택하라. evidence와 ambiguity는 간결한 한국어로 작성하라.\n\n${cameraGuide}`;
    const args = [
      "exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check",
      "-m", "gpt-5.6-terra", "-c", "model_reasoning_effort=\"high\"",
      "--output-schema", schemaPath, "-o", outputPath,
    ];
    for (const file of files) args.push("-i", file);
    await runCodex(args, { cwd: taskDir, input: prompt });
    const result = JSON.parse(await readFile(outputPath, "utf8"));
    const merged = cameras.map((camera) => ({ ...camera, ...(result.cameras.find((item) => item.id === camera.id) || {}) }));
    return { cameras: merged, summary: result.summary, decision: makeDecision(body.forecast || [], merged), analyzedAt: new Date().toISOString() };
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
}

async function getStatus() {
  if (!LOCAL_AI_ENABLED) {
    return {
      codex: false, aiEnabled: false, localOnly: true, runtimeMode: RUNTIME_MODE,
      version: null, model: "gpt-5.6-terra", reasoning: "high",
      error: "공개 배포에서는 노면 CCTV AI 분석을 사용하지 않습니다.",
    };
  }
  try {
    const result = await runCodex(["--version"], { cwd: ROOT, timeout: 8_000 });
    return { codex: true, aiEnabled: true, localOnly: true, runtimeMode: RUNTIME_MODE, version: result.stdout.trim(), model: "gpt-5.6-terra", reasoning: "high" };
  } catch (error) {
    return { codex: false, aiEnabled: true, localOnly: true, runtimeMode: RUNTIME_MODE, version: null, model: "gpt-5.6-terra", reasoning: "high", error: error.message };
  }
}

async function serveFile(pathname, res) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const publicFiles = new Set([
    "index.html", "mobile.html", "manifest.webmanifest", "assets/mobile.js", "assets/mobile.css", "assets/weather-domain.mjs", "assets/mobile-extra.js", "assets/refresh-scheduler.mjs", "assets/ui-icons.mjs", "sw.js",
    "assets/favicon.svg", "assets/apple-touch-icon.png", "assets/apple-touch-icon-v2.png", "assets/pwa-icon-192.png",
    "assets/pwa-icon-512.png", "assets/pwa-icon-maskable-512.png", "assets/og-image.png",
    "assets/apple-startup-1320x2868.png", "assets/apple-startup-1206x2622.png",
    "assets/apple-startup-1290x2796.png", "assets/apple-startup-1179x2556.png",
    "assets/apple-startup-1284x2778.png", "assets/apple-startup-1170x2532.png",
    "assets/apple-startup-1125x2436.png", "assets/apple-startup-1242x2688.png",
    "assets/apple-startup-828x1792.png", "assets/apple-startup-750x1334.png",
    "assets/apple-startup-640x1136.png",
  ]);
  if (!publicFiles.has(relative)) return sendJson(res, 404, { error: "Not found" });
  const filePath = resolve(ROOT, relative);
  if (!filePath.startsWith(ROOT)) return sendJson(res, 404, { error: "Not found" });
  try {
    const data = await readFile(filePath);
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };
    res.writeHead(200, { "Content-Type": types[extname(filePath)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

export async function requestHandler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (req.method === "GET" && url.pathname === "/api/config") return sendJson(res, 200, {
      // Naver Maps Client ID는 브라우저 지도 SDK에 필요한 공개 식별자입니다.
      // 나머지 비밀 키는 값 대신 연결 여부만 전달합니다.
      keys: { naverKey: LOCAL_KEYS.naverKey },
      configured: {
        naver: Boolean(LOCAL_KEYS.naverKey),
        forecast: Boolean(LOCAL_KEYS.kmaServiceKey),
        radar: Boolean(LOCAL_KEYS.kmaHubKey),
        cctv: Boolean(LOCAL_KEYS.itsApiKey),
      },
      runtime: { mode: RUNTIME_MODE, aiEnabled: LOCAL_AI_ENABLED, aiLocalOnly: true },
    });
    if (req.method === "GET" && url.pathname === "/api/status") return sendJson(res, 200, await getStatus());
    if (req.method === "GET" && url.pathname === "/api/radar") return await sendRadarGraphic(res, Number(url.searchParams.get("minutes")));
    if (req.method === "POST" && url.pathname === "/api/weekly-forecast") return sendJson(res, 200, await weeklyForecast(await readJson(req)));
    if (req.method === "POST" && url.pathname === "/api/mobile-forecast") return sendJson(res, 200, await mobileForecast(await readJson(req)));
    if (req.method === "POST" && url.pathname === "/api/mobile-context") return sendJson(res, 200, await mobileContext(await readJson(req)));
    if (req.method === "POST" && url.pathname === "/api/snapshot") return sendJson(res, 200, await snapshot(await readJson(req)));
    if (req.method === "POST" && url.pathname === "/api/analyze") return sendJson(res, 200, await analyzeCctv(await readJson(req)));
    if (req.method === "GET") return serveFile(url.pathname, res);
    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    const retryAt = Number.isFinite(error?.retryAt)
      ? new Date(error.retryAt).toISOString()
      : Number.isFinite(error?.retryAfterMs)
        ? new Date(Date.now() + error.retryAfterMs).toISOString()
        : null;
    sendJson(res, error.statusCode || 500, {
      error: error.message || "알 수 없는 오류",
      refresh: { stale: false, retryAt, failed: true },
      cache: { retryAt },
    });
  }
}

if (!process.env.VERCEL) {
  const server = http.createServer(requestHandler);
  server.listen(PORT, HOST, () => {
    console.log(`RUNCAST_READY http://${HOST}:${PORT} · ${RUNTIME_MODE.toUpperCase()} MODE`);
  });
}
