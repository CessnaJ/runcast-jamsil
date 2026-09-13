// Shared by the server and browser. No credentials or browser globals here.
export const ROUTES = {
  seokchon: { id: 'seokchon', name: '석촌호수', lat: 37.5082, lon: 127.1001 },
  olympic: { id: 'olympic', name: '올림픽공원', lat: 37.5207, lon: 127.1215 },
  hanriver: { id: 'hanriver', name: '잠실 한강', lat: 37.5197, lon: 127.0857 },
};
export const numberOrNull = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
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
export function normalizeWeekly(payload, location, fetchedAt) {
  const h = payload.hourly || {}, d = payload.daily || {};
  const variables = { temperature:'temperature_2m', feelsLike:'apparent_temperature', humidity:'relative_humidity_2m', precipitation:'precipitation', probability:'precipitation_probability', windSpeed:'wind_speed_10m', gusts:'wind_gusts_10m', windDirection:'wind_direction_10m', code:'weather_code' };
  const hourly = (h.time || []).map((time, i) => ({ time: `${time}:00+09:00`, ...Object.fromEntries(Object.entries(variables).map(([key, field]) => [key, numberOrNull(h[field]?.[i])])) }));
  const daily = (d.time || []).slice(0,7).map((date, i) => ({ date, low:numberOrNull(d.temperature_2m_min?.[i]), high:numberOrNull(d.temperature_2m_max?.[i]), code:numberOrNull(d.weather_code?.[i]) }));
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
