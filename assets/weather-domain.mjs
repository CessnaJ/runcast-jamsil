// Shared by the server and browser. No credentials or browser globals here.
export const ROUTES = {
  seokchon: { id: 'seokchon', name: '석촌호수', lat: 37.5082, lon: 127.1001 },
  olympic: { id: 'olympic', name: '올림픽공원', lat: 37.5207, lon: 127.1215 },
  hanriver: { id: 'hanriver', name: '잠실 한강', lat: 37.5197, lon: 127.0857 },
};
export const numberOrNull = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
// Open-Meteo JSON values are numeric. Keep malformed string samples out of the
// browser contract so a quoted "0" cannot become a valid zero by coercion.
const strictNumberOrNull = value => value == null || value === '' || !Number.isFinite(value) ? null : value;
// Supported Korean mainland/coastal envelope, plus Jeju, Ulleung and Dokdo.
// Deliberately bounded: not a global geocoder or a legal boundary dataset.
export function isSupportedLocation(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  const mainland = [[125.7,34.0],[126.8,33.9],[129.7,35.0],[129.6,36.4],[128.4,38.65],[127.15,38.35],[126.6,37.8],[125.7,37.75]];
  let inside = false;
  for (let i = 0, j = mainland.length - 1; i < mainland.length; j = i++) {
    const [xi, yi] = mainland[i], [xj, yj] = mainland[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj-xi)*(lat-yi)/(yj-yi)+xi) inside = !inside;
  }
  return inside || (lat >= 33.0 && lat <= 33.65 && lon >= 126.05 && lon <= 126.98)
    || (lat >= 37.4 && lat <= 38.05 && lon >= 124.5 && lon <= 125.75)
    || (lat >= 37.42 && lat <= 37.58 && lon >= 130.75 && lon <= 130.97)
    || (lat >= 37.20 && lat <= 37.28 && lon >= 131.82 && lon <= 131.91);
}
export function resolveLocation(body = {}) {
  if (!body || typeof body !== 'object') throw Object.assign(new Error('위치 정보가 올바르지 않습니다.'), { statusCode: 400 });
  if (body.location != null) {
    const { lat, lon } = body.location;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !isSupportedLocation(lat, lon)) {
      throw Object.assign(new Error('대한민국 내 지원 지역을 선택해 주세요.'), { statusCode: 400 });
    }
    const point = { lat: +lat.toFixed(4), lon: +lon.toFixed(4) };
    const preset = Object.values(ROUTES).find(p => p.lat === point.lat && p.lon === point.lon);
    const name = typeof body.location.name === 'string' ? body.location.name.trim().slice(0, 30) : '';
    return { ...point, id: preset?.id || `point-${point.lat}-${point.lon}`, name: name || preset?.name || '선택한 위치' };
  }
  if (body.route != null && !Object.hasOwn(ROUTES, body.route)) throw Object.assign(new Error('등록되지 않은 러닝 코스입니다.'), { statusCode: 400 });
  return { ...(ROUTES[body.route] || ROUTES.seokchon) };
}
export const locationKey = p => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
export const kstDay = (date = new Date()) => new Date(+date + 9*3600000).toISOString().slice(0,10);
// Open-Meteo hourly values are matched to the exact local-hour bucket. Keeping
// this pure makes the same rule usable by the running card and weekly table.
export function hourlyBucketEpoch(value) {
  const epoch = value instanceof Date ? +value : typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(epoch) ? Math.floor(epoch / 3600000) * 3600000 : null;
}
export function hourlyPointAt(hourly, target) {
  const bucket = hourlyBucketEpoch(target);
  if (!Array.isArray(hourly) || bucket == null) return null;
  return hourly.find(point => hourlyBucketEpoch(point?.time) === bucket) || null;
}
export function hourlyTemperatureAt(hourly, target) {
  const temperature = hourlyPointAt(hourly, target)?.temperature;
  return Number.isFinite(temperature) ? temperature : null;
}
// Use one display rule in both views. Number#toFixed handles -2.5 as -3,
// avoiding the asymmetric Math.round result for negative decimal values.
export function roundTemperature(value) {
  if (!Number.isFinite(value)) return null;
  const rounded = Number(Number(value).toFixed(0));
  return Object.is(rounded, -0) ? 0 : rounded;
}
export function normalizeWeekly(payload, location, fetchedAt) {
  const h = payload.hourly || {}, d = payload.daily || {};
  const variables = { temperature:'temperature_2m', feelsLike:'apparent_temperature', humidity:'relative_humidity_2m', precipitation:'precipitation', probability:'precipitation_probability', windSpeed:'wind_speed_10m', gusts:'wind_gusts_10m', windDirection:'wind_direction_10m', code:'weather_code' };
  const hourly = (h.time || []).filter(time => typeof time === 'string' && time).map((time, i) => ({ time: `${time}:00+09:00`, ...Object.fromEntries(Object.entries(variables).map(([key, field]) => [key, strictNumberOrNull(h[field]?.[i])])) }));
  const daily = (d.time || []).slice(0,7).filter(date => typeof date === 'string' && date).map((date, i) => ({ date, low:strictNumberOrNull(d.temperature_2m_min?.[i]), high:strictNumberOrNull(d.temperature_2m_max?.[i]), code:strictNumberOrNull(d.weather_code?.[i]) }));
  if (!hourly.length || !daily.length || !hourly.some(h => h.temperature != null)) throw new Error('주간 예보 자료가 없습니다.');
  return { location, hourly, daily, fetchedAt, expiresAt:new Date(Date.parse(fetchedAt)+30*60000).toISOString(), source:'Open-Meteo', timezone:'Asia/Seoul', units:{temperature:'°C', windSpeed:'m/s', precipitation:'mm'}, precipitationPeriod:'직전 1시간 누적' };
}
export const WEAR_BANDS = [
  { below:0, top:'보온 긴팔 + 방풍 재킷', bottom:'보온 타이츠', extra:'장갑 · 귀를 덮는 모자' },
  { below:6, top:'긴팔 베이스 + 가벼운 재킷', bottom:'긴 타이츠', extra:'얇은 장갑' },
  { below:12, top:'기능성 긴팔', bottom:'긴 타이츠 또는 반바지', extra:'얇은 바람막이 챙기기' },
  { below:18, top:'얇은 긴팔 또는 반팔', bottom:'반바지', extra:'' },
  { below:24, top:'통기성 좋은 반팔', bottom:'반바지', extra:'' },
  { below:Infinity, top:'가벼운 반팔 또는 민소매', bottom:'얇은 반바지', extra:'' },
];
// UI departure contract: point values at t, interval values from the exact t+1h.
export function runningIntervals(hourly) {
  const byTime = new Map(hourly.map(h => [Date.parse(h.time), h]));
  return hourly.map(start => {
    const end = byTime.get(Date.parse(start.time) + 3600000);
    return { ...start, startAt:start.time, endAt:end?.time ?? null,
      precipitation:end?.precipitation ?? null, probability:end?.probability ?? null,
      gusts:end?.gusts ?? null, endFeelsLike:end?.feelsLike ?? null,
      endWindSpeed:end?.windSpeed ?? null };
  });
}
export function nextDepartureTime(now = new Date()) {
  return new Date(Math.floor(+now / 3600000) * 3600000 + 3600000 + 9*3600000).toISOString().slice(0,19) + '+09:00';
}
export function recommendRunningWear(hourly, startTime, preference = 'normal', normalized = false) {
  const start = (normalized ? hourly : runningIntervals(hourly)).find(h => h.time === startTime);
  if (!start?.endAt || !Number.isFinite(start.feelsLike) || !Number.isFinite(start.endFeelsLike)) return null;
  const low = Math.min(start.feelsLike,start.endFeelsLike), high = Math.max(start.feelsLike,start.endFeelsLike);
  const adjusted = Math.round((low + ({cold:-2,hot:2}[preference] || 0))/2)*2;
  const band = WEAR_BANDS.find(b => adjusted < b.below);
  const windy = [start.windSpeed,start.endWindSpeed].some(v=>Number.isFinite(v)&&v>=8) || (Number.isFinite(start.gusts)&&start.gusts>=12);
  const notes = [];
  if (windy) notes.push('바람 강함 · 휴대용 바람막이 권장');
  if (Number.isFinite(start.precipitation) && start.precipitation > 0) notes.push('비·눈 가능 · 갈아입을 옷 준비');
  return { ...band, low, high, windy, notes, startAt:start.time, endAt:start.endAt };
}

// Run advice is deliberately kept in this browser/server module so a cached
// response cannot make the mobile badge, colour, and headline disagree with
// the API.  These are product heuristics for a one-hour run, not an official
// weather warning or a medical safety assessment.
const RUN_SNOW_TYPES = new Set([2, 3, 6, 7]);
const RUN_APPROACH_SECTORS = new Set(['남', '남서', '서']);

const finiteNonNegative = value => Number.isFinite(value) && value >= 0 ? value : null;
const finiteProbability = value => Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
const runMedian = values => {
  const sorted = values.map(finiteNonNegative).filter(value => value != null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const runAverage = values => {
  const valid = values.map(value => finiteProbability(value)).filter(value => value != null);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
};
const runRoundFive = value => Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value / 5) * 5)) : null;
const runRoundAmount = value => {
  const numeric = finiteNonNegative(value);
  if (numeric == null) return null;
  if (numeric === 0) return 0;
  return Math.round(numeric * 10) / 10;
};

function runModelEntries(item) {
  return Array.isArray(item?.multiModel?.models)
    ? item.multiModel.models.filter(model => model && typeof model === 'object')
    : [];
}

/**
 * Derive the current-time fields used by both the point assessment and the
 * run-window classifier.  nextHour* fields and old aggregate spread/vote
 * fields are intentionally excluded from the decision inputs.
 */
export function runSampleMetrics(item = {}, recentConditions = null) {
  const models = runModelEntries(item);
  const modelAmounts = models.map(model => model.amount).map(finiteNonNegative).filter(value => value != null);
  const modelAmountMedian = runMedian(modelAmounts);
  const officialAmount = finiteNonNegative(Number.isFinite(item.villageMm) ? item.villageMm : item.mm);
  const fallbackAmount = finiteNonNegative(item?.runAssessment?.expectedAmount);
  const expectedRaw = officialAmount != null || modelAmountMedian != null
    ? runMedian([officialAmount, modelAmountMedian])
    : fallbackAmount;
  const expectedAmount = runRoundAmount(expectedRaw);

  const modelProbabilities = models.map(model => finiteProbability(model.probability)).filter(value => value != null);
  const officialProbability = finiteProbability(item.probability);
  const modelProbabilityAverage = runAverage(modelProbabilities);
  const chance = [officialProbability, modelProbabilityAverage].filter(value => value != null).length
    ? Math.max(officialProbability ?? 0, modelProbabilityAverage ?? 0)
    : null;
  const previousCandidates = [
    item.previousHourMm,
    item?.multiModel?.previousAmountMedian,
    item?.runAssessment?.previousAmount,
  ].map(finiteNonNegative).filter(value => value != null);
  const previousAmount = previousCandidates.length ? Math.max(...previousCandidates) : 0;

  const modelSpread = modelProbabilities.length >= 2
    ? Math.max(...modelProbabilities) - Math.min(...modelProbabilities)
    : null;
  const wetVotes = models.filter(model => {
    const probability = finiteProbability(model.probability);
    const amount = finiteNonNegative(model.amount);
    return (probability != null && probability >= 50) || (amount != null && amount >= 0.2);
  }).length;
  const wetVoteRatio = models.length ? wetVotes / models.length : null;
  const disagreement = (Number.isFinite(modelSpread) && modelSpread >= 40)
    || (Number.isFinite(wetVoteRatio) && wetVoteRatio >= 0.25 && wetVoteRatio <= 0.75);

  const recent = recentConditions || item?.recentConditions || null;
  const observationStillRelevant = !Number.isFinite(item.minutes) || item.minutes <= 180;
  const recentTotal = finiteNonNegative(recent?.recentTotalMm);
  const recentMax = finiteNonNegative(recent?.recentMaxMm);
  const recentWet = observationStillRelevant && recentTotal != null && recentTotal >= 1;
  const recentHeavy = observationStillRelevant && ((recentMax != null && recentMax >= 5) || (recentTotal != null && recentTotal >= 8));
  const easingFromHeavy = previousAmount >= 3 && (expectedAmount ?? 0) <= 1;
  const recoveringSurface = easingFromHeavy || (recentHeavy && (expectedAmount ?? 0) <= 1);
  const wetSurface = previousAmount >= 0.5 || recentWet;
  const priorSurface = ['recovering', 'wet', 'dry'].includes(item?.runAssessment?.surface) ? item.runAssessment.surface : null;
  const surface = recoveringSurface ? 'recovering' : wetSurface ? 'wet' : priorSurface || 'dry';
  const snow = RUN_SNOW_TYPES.has(Number(item.precipitationType)) || item?.runAssessment?.snow === true;

  return {
    expectedAmount,
    previousAmount: runRoundAmount(previousAmount) ?? 0,
    currentModelProbabilities: modelProbabilities,
    currentModelAmounts: modelAmounts,
    modelProbabilityAverage,
    modelSpread,
    wetVotes,
    wetVoteRatio,
    chance,
    disagreement,
    recentWet,
    recentHeavy,
    recoveringSurface,
    surface,
    snow,
  };
}

function runWindowAmounts(metrics) {
  const values = metrics.map(item => item.expectedAmount);
  if (!values.length || values.some(value => !Number.isFinite(value))) return null;
  if (values.length === 1) return { estimated: values[0], peak: values[0] };
  if (values.length === 2) return { estimated: runRoundAmount((values[0] + values[1]) / 2), peak: Math.max(...values) };
  // Run modes contain departure / 30-minute / return samples.  Keeping this
  // explicit also preserves the historical one-hour trapezoid contract.
  const first = values[0], middle = values[1], last = values.at(-1);
  return { estimated: runRoundAmount(first * 0.25 + middle * 0.5 + last * 0.25), peak: Math.max(...values) };
}

function runCctvSignals(cctvs) {
  const cameras = Array.isArray(cctvs) ? cctvs : [];
  const trustworthy = camera => camera
    && ['yes', 'no', 'uncertain'].includes(camera.rainNow)
    && camera.cameraUsable !== false
    && Number.isFinite(camera.confidence)
    && camera.confidence >= 0.65;
  const rainyApproach = cameras.filter(camera => trustworthy(camera)
    && camera.rainNow === 'yes' && RUN_APPROACH_SECTORS.has(camera.sector));
  const wetSurface = cameras.filter(camera => trustworthy(camera) && camera.roadWet === true);
  return { rainyApproach, wetSurface };
}

function runUnknownDecision(summary = {}) {
  return {
    level: 'unknown', reasonCode: 'unavailable', headline: '자료가 부족해 판단하기 어려워요',
    label: '자료가 부족해 판단하기 어려워요', short: '확인 불가', confidence: 0,
    reason: '자료가 부족해 판단하기 어려워요', ...summary,
  };
}

/**
 * Shared run-window evaluator. `requireSamples` is 3 for actual run modes;
 * callers of the legacy makeDecision API may leave it at 0 so one-point
 * fixtures continue to classify.
 */
export function evaluateRunWindow(samples = [], cctvs = [], options = {}) {
  const list = Array.isArray(samples) ? samples : [];
  const metrics = list.map(sample => runSampleMetrics(sample));
  const requiredSamples = Number.isInteger(options.requireSamples) ? options.requireSamples : 0;
  const amountInfo = runWindowAmounts(metrics);
  const incomplete = !list.length
    || (requiredSamples > 0 && list.length < requiredSamples)
    || list.some((sample, index) => sample?.unavailable || sample?.source === 'demo' || metrics[index].expectedAmount == null);
  const common = {
    estimatedAmount: amountInfo?.estimated ?? null,
    peakAmount: amountInfo?.peak ?? null,
    runCumulative: amountInfo?.estimated ?? null,
    runPeak: amountInfo?.peak ?? null,
    sampleCount: list.length,
  };
  if (incomplete) return { decision: runUnknownDecision(common), summary: { ...common, probabilityMax: null, probabilityAverage: null, officialProbabilityMax: null, modelProbabilityAverage: null, modelProbabilityMax: null, surface: 'unknown', worstLevel: 'unknown', disagreement: false, modelDriving: false } };

  const officialProbabilities = list.map(sample => finiteProbability(sample.probability)).filter(value => value != null);
  const modelProbabilityMeans = metrics.map(metric => metric.modelProbabilityAverage).filter(value => value != null);
  const modelProbabilityAverage = modelProbabilityMeans.length ? Math.max(...modelProbabilityMeans) : null;
  const officialProbabilityMaxRaw = officialProbabilities.length ? Math.max(...officialProbabilities) : null;
  const chance = [officialProbabilityMaxRaw, modelProbabilityAverage].filter(value => value != null).length
    ? Math.max(officialProbabilityMaxRaw ?? 0, modelProbabilityAverage ?? 0)
    : null;
  const disagreement = metrics.some(metric => metric.disagreement);
  const modelDriving = modelProbabilityAverage != null && (officialProbabilityMaxRaw == null || modelProbabilityAverage > officialProbabilityMaxRaw);
  const surfaces = metrics.map(metric => metric.surface);
  const surface = surfaces.includes('recovering') ? 'recovering' : surfaces.includes('wet') ? 'wet' : 'dry';
  const summary = {
    ...common,
    probabilityMax: runRoundFive(chance),
    probabilityAverage: runRoundFive(chance),
    officialProbabilityMax: runRoundFive(officialProbabilityMaxRaw),
    modelProbabilityAverage: runRoundFive(modelProbabilityAverage),
    modelProbabilityMax: runRoundFive(modelProbabilityAverage),
    surface,
    worstLevel: 'green',
    disagreement,
    modelDriving,
  };
  const { rainyApproach, wetSurface } = runCctvSignals(cctvs);
  const chanceKnown = Number.isFinite(chance);
  const peak = amountInfo.peak;
  const cumulative = amountInfo.estimated;
  const hasSnow = metrics.some(metric => metric.snow);
  const surfaceCctv = wetSurface.length >= 2;
  const reasonForModel = modelDriving
    ? ` 다른 예보 모델의 러닝 구간 내 모델 평균 최댓값은 ${Math.round(modelProbabilityAverage)}%예요.`
    : '';
  let decision;
  if (hasSnow) {
    decision = { level: 'red', reasonCode: 'snow', headline: '눈·진눈깨비가 예상돼요', short: '미루기', confidence: 92, reason: '눈·진눈깨비가 예상돼요.' };
  } else if (peak >= 3 || cumulative >= 3) {
    decision = { level: 'red', reasonCode: 'rain_heavy', headline: '비가 많아 러닝을 미루는 게 좋아요', short: '미루기', confidence: 90, reason: `러닝 시간대 강수량이 시간당 최대 ${peak}mm, 예상 누적 ${cumulative}mm예요.` };
  } else if (rainyApproach.length >= 2) {
    decision = { level: 'red', reasonCode: 'cctv_rain', headline: '주변 CCTV에 비가 보여요', short: '미루기', confidence: 84, reason: `남·남서·서쪽 접근 CCTV ${rainyApproach.length}곳에서 현재 비가 보여요.` };
  } else if (rainyApproach.length >= 1) {
    decision = { level: 'yellow', reasonCode: 'cctv_rain', headline: '주변 CCTV에 비가 보여요', short: '주의', confidence: 72, reason: `남·남서·서쪽 접근 CCTV ${rainyApproach.length}곳에서 현재 비가 보여요.` };
  } else if (peak >= 1 || cumulative >= 1) {
    decision = { level: 'yellow', reasonCode: 'rain', headline: '비에 젖을 수 있어요', short: '주의', confidence: 70, reason: `러닝 시간대 강수량이 시간당 최대 ${peak}mm, 예상 누적 ${cumulative}mm예요.` };
  } else if (surface === 'wet' || surface === 'recovering' || surfaceCctv) {
    const cctvSurface = surfaceCctv;
    decision = cctvSurface
      ? { level: 'yellow', reasonCode: 'surface_cctv', headline: 'CCTV에 젖은 노면이 보여요', short: '노면 주의', confidence: 70, reason: `신뢰할 수 있는 CCTV ${wetSurface.length}곳에서 젖은 노면이 보여요.` }
      : { level: 'yellow', reasonCode: 'surface', headline: '노면이 젖어 있을 수 있어요', short: '노면 주의', confidence: 66, reason: '최근 강수 또는 직전 강수로 노면이 젖어 있을 수 있어요.' };
  } else if (chanceKnown && chance >= 60) {
    decision = { level: 'yellow', reasonCode: 'probability', headline: '비 올 가능성이 있어요', short: '가능성', confidence: 64, reason: `강수확률이 ${runRoundFive(chance)}%로 비 올 가능성이 있어요.${reasonForModel}` };
  } else if (disagreement) {
    decision = { level: 'yellow', reasonCode: 'uncertain', headline: '예보가 엇갈려요', short: '재확인', confidence: 58, reason: `예보가 엇갈려요. 출발 전에 최신 자료를 확인해 주세요.${reasonForModel}` };
  } else if (cumulative <= 0.2 && peak <= 0.2) {
    decision = { level: 'green', reasonCode: 'low', headline: '눈·비 걱정 적어요', short: '무난', confidence: 68, reason: '러닝 시간대 눈·비 걱정이 적어요.' };
  } else {
    decision = { level: 'green', reasonCode: 'light', headline: '약한 비가 예상돼요', short: '약한 비', confidence: 60, reason: `러닝 시간대 약한 비가 예상돼요. 예상 누적 ${cumulative}mm예요.${reasonForModel}` };
  }
  const level = decision.level === 'red' ? 'red' : decision.level === 'yellow' ? 'yellow' : 'green';
  summary.worstLevel = level;
  return { decision: { ...decision, label: decision.headline, ...summary }, summary };
}
