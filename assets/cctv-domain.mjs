// Shared by browser acquisition and server upload validation.
function parseXmlTag(block, tag) {
  return (block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i")) || [])[1]?.trim() || "";
}

export function normalizeCctv(item, target) {
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

export function chooseDirectionalCctv(cameras) {
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


export const CCTV_POLICY = Object.freeze({freshMs:25_000, staleMs:45_000, leaseMs:25_000, failureMs:20_000, timeoutMs:12_000, maxResponseBytes:2_000_000});

export function cctvBounds(target) {
  return {minX:target.lon-0.55,maxX:target.lon+0.55,minY:target.lat-0.42,maxY:target.lat+0.42};
}

export function validCctvUrl(value) {
  try {
    const url=new URL(value);
    return ['http:','https:'].includes(url.protocol)
      && ['cctvsec.ktict.co.kr','cctv.ktict.co.kr'].includes(url.hostname)
      && !url.username && !url.password && (!url.port || ['80','443','8090'].includes(url.port));
  } catch { return false; }
}

// Never accept client-provided analysis or confidence as observed weather.
export function selectCctvRows(rows,target) {
  if(!Array.isArray(rows)||rows.length>6000)throw itsResponseError('CCTV 목록 크기를 확인해 주세요.');
  const bounds=cctvBounds(target);
  const clean=rows.map(row=>{
    const lat=Number(row?.coordy),lon=Number(row?.coordx);
    if(!row || row.coordy==null || row.coordx==null || !Number.isFinite(lat)||!Number.isFinite(lon)
      || lat<bounds.minY||lat>bounds.maxY||lon<bounds.minX||lon>bounds.maxX
      || typeof row.cctvurl!=='string'||row.cctvurl.length>4096||!validCctvUrl(row.cctvurl))return null;
    return {coordy:lat,coordx:lon,cctvurl:row.cctvurl,cctvname:String(row.cctvname||'이름 없는 CCTV').slice(0,160),
      cctvformat:String(row.cctvformat||'').slice(0,40),cctvtype:String(row.cctvtype||'3').slice(0,8)};
  }).filter(Boolean);
  if(rows.length && !clean.length)throw itsResponseError('CCTV 주소 또는 위치를 확인하지 못했어요.');
  const ranked=clean.map(row=>({row,camera:normalizeCctv(row,target)})).filter(item=>item.camera.distance<=15)
    .sort((a,b)=>a.camera.distance-b.camera.distance||a.camera.id.localeCompare(b.camera.id));
  const seen=new Set();
  return ranked.filter(item=>{if(seen.has(item.camera.id))return false;seen.add(item.camera.id);return true;}).slice(0,8).map(item=>item.row);
}

export function cctvResult(rows,target,{fetchedAt=null,retryAt=null,stale=false,configured=true,pending=false}={}) {
  const cameras=rows.map(row=>normalizeCctv(row,target));
  return {cctvs:cameras,cctv:{configured,available:cameras.length>0,included:false,fetchedAt,
    usableUntil:fetchedAt?new Date(Date.parse(fetchedAt)+CCTV_POLICY.staleMs).toISOString():null,retryAt,stale,pending},
    errors:[],refresh:{failed:false,stale,retryAt}};
}
