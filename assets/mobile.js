import { ROUTES, locationKey, hourlyTemperatureAt, roundTemperature, evaluateRunWindow, runSampleMetrics } from './weather-domain.mjs';
import { createExtras, storage, preferences, readForecastCache, writeForecastCache } from './mobile-extra.js';
import { createRefreshScheduler, REFRESH_INTERVALS, REFRESH_TIMEOUTS } from './refresh-scheduler.mjs';
import { icon } from './ui-icons.mjs';


// 이전 버전이 브라우저에 저장했던 비밀 키를 더 이상 사용하지 않고 제거합니다.
try { localStorage.removeItem("runcast.keys"); } catch {}

const state = {
  view: "decision", route: preferences.location.id, location: preferences.location, mapHorizon: 0, departureMode: "now", data: null,
  keys: {}, configured: {},
  runtime: { mode: "local", aiEnabled: true, aiLocalOnly: true }, codex: null,
  loading: true, analyzing: false, naverMap: null, naverSdkPromise: null,
  overlays: [], radarOverlay: null, radarFrames: [], radarFrameIndex: 0,
  radarFrameKey: null, radarSequenceCache: new Map(),
  radarPlaying: true, radarTimer: null, radarLoadToken: 0,
  refreshController: null, contextController: null, analysisController: null, lifecycleTimer: null, refreshToken: 0, analysisToken: 0,
  usingCachedData: false, thermal: { locationKey: locationKey(preferences.location), status: "idle", data: null, error: null }, context: { locationKey: locationKey(preferences.location), status: "idle", cctvs: null, cctv: null, aviation: null, errors: [] }, cctvExpanded: false,
};
const refreshScheduler = createRefreshScheduler();
window.runCastMobileDebug = () => ({ hasNaverKey: Boolean(state.keys.naverKey), runtimeMode: state.runtime.mode, hasMap: Boolean(state.naverMap), view: state.view });

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));

function toast(message) {
  const node = $("#toast");
  node.textContent = message; node.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove("show"), 3200);
}

function formatTime(date = new Date()) {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

function formatDayTime(date) {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date).replace(" ", " ");
}

function horizonLabel(minutes) {
  const fixed = ({ 0: "현재", 30: "+30분", 60: "+1시간", 180: "+3시간", 360: "+6시간", 540: "+9시간" })[minutes];
  if (fixed) return fixed;
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return remainder ? `+${hours}시간 ${remainder}분` : `+${hours}시간`;
}

function radarFrameLabel(minutes) {
  if (minutes === 0) return "현재";
  if (minutes < 60) return `+${minutes}분`;
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return remainder ? `+${hours}시간 ${remainder}분` : `+${hours}시간`;
}

function activeRunMode() {
  const modes = state.data?.runModes || [];
  return modes.find((mode) => mode.id === state.departureMode) || modes[0] || null;
}

function modePoint(mode, phase) {
  return mode?.samples?.find((sample) => sample.phase === phase) || null;
}

function expectedMm(item) {
  return runSampleMetrics(item).expectedAmount;
}

function rainAmountCopy(item) {
  const mm = expectedMm(item);
  if (!Number.isFinite(mm)) return "자료 없음";
  if (mm <= .05) return "거의 0mm";
  if (mm < 1) return `${mm.toFixed(1)}mm 안팎`;
  return `${mm.toFixed(mm % 1 ? 1 : 0)}mm 안팎`;
}

function probabilityCopy(item) {
  const probability = item?.probability;
  if (!Number.isFinite(probability)) return "확률 자료 없음";
  const level = probability <= 30 ? "낮음" : probability < 60 ? "보통" : "있음";
  return `${level} · ${probability}%`;
}

function modeProbabilityCopy(mode) {
  const probability = mode?.summary?.officialProbabilityMax;
  if (!Number.isFinite(probability)) return "확률 자료 없음";
  const level = probability <= 30 ? "낮음" : probability < 60 ? "보통" : "있음";
  return `${level} · ${probability}%`;
}

function modeAmountCopy(mode) {
  const mm = mode?.summary?.estimatedAmount;
  if (!Number.isFinite(mm)) return "자료 없음";
  if (mm <= .05) return "거의 0mm";
  if (mm < 1) return `${mm.toFixed(1)}mm 안팎`;
  return `${mm.toFixed(mm % 1 ? 1 : 0)}mm 안팎`;
}

function thermalTemperature(mode, phase) {
  const target = phase === "출발" ? mode?.departureAt : mode?.endAt;
  const hourly = state.thermal?.locationKey === locationKey(state.location) ? state.thermal.data?.hourly : null;
  return hourlyTemperatureAt(hourly, target);
}

function temperatureCopy(value) {
  const temperature = roundTemperature(value);
  return temperature == null ? "—" : `${temperature}°`;
}

function modePrimaryCopy(mode) {
  if (mode?.decision?.level === "unknown") return mode.decision.headline || "자료가 부족해 판단하기 어려워요";
  return mode?.decision?.headline || mode?.decision?.label || "출발 직전에 다시 확인하세요";
}

function surfaceInfo(assessment, recent = state.data?.recentConditions, cameras = state.data?.cctvs || []) {
  // 관측의 우선순위는 비 > 젖은 노면 > 판단 어려움 > 건조입니다.
  // 아직 분석하지 않은 unknown CCTV는 관측도, 판단 근거도 아닙니다.
  const analyzed = cameras.filter((camera) => ["yes", "no", "uncertain"].includes(camera.rainNow));
  if (analyzed.some((camera) => camera.rainNow === "yes")) return { short: "CCTV 비 확인", detail: "CCTV 영상에서 현재 비가 보여요", observed: true };
  if (analyzed.some((camera) => camera.roadWet === true)) return { short: "CCTV 노면 젖음", detail: "CCTV 영상에서 젖은 노면이 보여요", observed: true };
  if (analyzed.some((camera) => camera.rainNow === "uncertain")) return { short: "CCTV 판단 어려움", detail: "CCTV 영상을 분석했지만 비 여부가 분명하지 않아요", observed: true };
  if (analyzed.length) return { short: "CCTV 건조", detail: "분석한 CCTV 영상에서 현재 비나 젖은 노면이 보이지 않아요", observed: true };
  if (assessment?.surface === "recovering" || assessment?.surface === "wet") {
    return { short: "젖음 추정", detail: `최근 3시간 ${recent?.recentTotalMm ?? "-"}mm 기준 노면이 젖어 있을 수 있어요`, observed: false };
  }
  if (!recent?.observations?.length) return { short: "자료 없음", detail: "최근 노면 상태를 추정할 자료가 없어요", observed: false };
  return { short: "건조 추정", detail: "최근 강수 기준으로 노면이 건조한 것으로 추정해요", observed: false };
}

function dataQuality(data, item) {
  const hasOfficialKma = !data?.demo
    && ["ultra", "village"].includes(item?.source)
    && Boolean(item?.sourceTime)
    && /(?:초단기|단기)예보/.test(String(item?.sourceLabel || ""));
  if (!hasOfficialKma) return { label: "자료 없음", detail: "해당 시각의 기상청 예보를 확인하지 못했어요" };
  const hasOfficial = hasOfficialKma;
  const hasModels = Boolean(item?.multiModel?.availableModels);
  const hasRecent = Boolean(data?.recentConditions?.observations?.length);
  const fresh = !Number.isFinite(item?.issueAgeMinutes) || item.issueAgeMinutes <= 180;
  const count = [hasOfficial, hasModels, hasRecent].filter(Boolean).length;
  if (count >= 3 && fresh && !item?.runAssessment?.disagreement) return { label: "자료 일치도 높음", detail: "공식 예보와 다른 예보가 대체로 비슷해요" };
  if (count >= 2) return { label: "자료 일치도 보통", detail: item?.runAssessment?.disagreement ? "예보가 서로 달라 출발 직전 확인이 좋아요" : "확인 가능한 자료는 충분하지만 일부 자료가 빠졌어요" };
  return { label: "자료 일치도 낮음", detail: "확인 가능한 예보 자료가 부족해요" };
}

function completeMode(mode) {
  return mode?.decision?.level !== 'unknown' && mode?.samples?.length >= 3 && mode.samples.every(sample => !sample.unavailable && Number.isFinite(expectedMm(sample)));
}

function currentContext() {
  return state.context?.locationKey === locationKey(state.location) ? state.context : null;
}

function currentCctvs() {
  const cameras = currentContext()?.cctvs;
  return Array.isArray(cameras) ? cameras : [];
}

// A cached core response may contain the old amount ladder and old go/caution
// labels. Rebuild the verdict from its raw samples before rendering so stale
// localStorage data follows the same policy as a fresh server response.
function normalizeCoreData(payload, cctvs = []) {
  if (!payload || typeof payload !== "object") return payload;
  const runModes = Array.isArray(payload.runModes) ? payload.runModes.map(mode => {
    const evaluated = evaluateRunWindow(mode.samples || [], mode.immediate || mode.id === "now" ? cctvs : [], { requireSamples: 3 });
    return { ...mode, summary: evaluated.summary, decision: evaluated.decision };
  }) : payload.runModes;
  const forecast = Array.isArray(payload.forecast) ? payload.forecast.filter(item => Number(item?.minutes) <= 60) : [];
  const decision = forecast.length ? evaluateRunWindow(forecast, cctvs).decision : payload.decision;
  return { ...payload, runModes, decision };
}

function currentAviation() {
  return currentContext()?.aviation || { metar: [], taf: [] };
}

function contextNeedsRefresh() {
  const context=currentContext();
  if (!context || context.status === "idle" || context.status === "error") return true;
  if (context.status === "loading" || context.status === "refreshing") return false;
  if (context.errors?.some(error=>String(error).startsWith("CCTV:"))) return true;
  const usableUntil=Date.parse(context.cctv?.usableUntil || "");
  return Number.isFinite(usableUntil) ? Date.now() >= usableUntil : false;
}

function pageCanRefresh() {
  return document.visibilityState === "visible" && (typeof navigator === "undefined" || navigator.onLine !== false);
}

function hydrateCoreCache() {
  const key=locationKey(state.location), cached=readForecastCache('core',key);
  if(cached&&!state.data){state.data=normalizeCoreData(cached,currentCctvs());state.usingCachedData=true;}
  if(state.loading)state.loading=false;
  return state.data || cached;
}

function applyRetryMetadata(error, payload, response) {
  const bodyRetry = payload?.refresh?.retryAt || payload?.cache?.retryAt;
  const parsedBodyRetry = typeof bodyRetry === "number" ? bodyRetry : Date.parse(bodyRetry || "");
  if (Number.isFinite(parsedBodyRetry)) { error.retryAt = parsedBodyRetry; return; }
  const retryAfter = response?.headers?.get?.("Retry-After");
  if (!retryAfter) return;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) error.retryAfterMs = Math.max(0, seconds * 1000);
  else {
    const retryDate = Date.parse(retryAfter);
    if (Number.isFinite(retryDate)) error.retryAt = retryDate;
  }
}

function decisionIcon(level) {
  return level === "green" ? icon('check') : level === "yellow" || level === "red" ? icon('warning') : icon('question');
}

function renderDecision() {
  const data=state.data, mode=activeRunMode(); if(!data||!mode)return;
  const complete=completeMode(mode), decision=complete?mode.decision:{level:'unknown'};
  const surface=surfaceInfo({surface:mode.summary?.surface},data.recentConditions,mode.immediate?currentCctvs():[]);
  const expiredRun=Date.parse(mode.endAt)<Date.now();
  $('#decisionHero').className=`decision-hero ${decision.level}`;
  $('#decisionStatusIcon').innerHTML=decisionIcon(decision.level);
  $('#decisionTitle').textContent=complete ? (expiredRun?'당시 눈·비 판단: '+modePrimaryCopy(mode):modePrimaryCopy(mode)):'예보가 부족해 판단을 보류해요';
  const departure=new Date(mode.departureAt), arrival=new Date(mode.endAt);
  $('#decisionWindow').textContent=`${expiredRun?'지난 예보 · ':''}${new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric'}).format(departure)} ${formatDayTime(departure)}–${formatTime(arrival)} · 1시간`;
  const probability=mode.summary?.officialProbabilityMax, mm=mode.summary?.estimatedAmount;
  const departureTemperature=thermalTemperature(mode,"출발"), returnTemperature=thermalTemperature(mode,"복귀");
  const hasTemperature=departureTemperature != null || returnTemperature != null;
  const returnTemperatureCopy=returnTemperature == null ? "복귀 자료 없음" : `복귀 ${temperatureCopy(returnTemperature)}`;
  const temperatureMetrics=`<div class="hero-metric hero-temperature"><small>출발 기온</small><b>${temperatureCopy(departureTemperature)}</b><span class="hero-metric-sub">${returnTemperatureCopy}</span></div>`;
  const precipitationMetrics=`<div class="hero-metric"><small>강수확률</small><b>${complete&&Number.isFinite(probability)?probability+'%':'—'}</b></div><div class="hero-metric"><small>예상 강수량</small><b>${complete&&Number.isFinite(mm)?Number(mm.toFixed(2))+'mm':'—'}</b></div>`;
  const surfaceWarning=["젖음 추정","CCTV 비 확인","CCTV 노면 젖음","CCTV 판단 어려움"].includes(surface.short) ? `<p class="surface-copy">노면 ${escapeHtml(surface.short)}${surface.observed?' · 영상 확인':''}</p>` : "";
  const metrics=(complete||hasTemperature)?`<div class="hero-metrics">${temperatureMetrics}${precipitationMetrics}</div>`:"";
  const decisionReason = complete ? `<p class="decision-reason">${escapeHtml(decision.reason || decision.headline || "")}</p>` : '<p class="surface-copy">일부 시간의 자료가 없어 눈·비 판단을 제공하지 않아요.</p>';
  $('#decisionReason').innerHTML=complete?`${metrics}${decisionReason}${surfaceWarning}`:hasTemperature?`${metrics}${decisionReason}`:decisionReason;
  $('#runMapCta').hidden=false;
  $('#runMapCta').onclick=()=>{state.mapHorizon=mode.withinMapHorizon?mode.mapHorizonMinutes:0;switchView('map');};
}

function renderDepartureModes() {
  const focused=document.activeElement?.dataset.mode;
  $('#departureModes').innerHTML=(state.data?.runModes||[]).map(mode=>`<button class="departure-mode ${mode.id===state.departureMode?'active':''}" data-mode="${escapeHtml(mode.id)}" role="tab" aria-selected="${mode.id===state.departureMode}"><b>${escapeHtml(Date.parse(mode.endAt)<Date.now()?(mode.id==='now'?'지난 출발':'지난 '+mode.label):mode.label)}</b><small>${!completeMode(mode)?'—':({green:'무난',yellow:'주의',red:'미루기'}[mode.decision.level]||'—')}</small></button>`).join('');
  $$('#departureModes button').forEach(button=>button.onclick=()=>{state.departureMode=button.dataset.mode;render();button=document.querySelector(`[data-mode="${state.departureMode}"]`);button?.focus({preventScroll:true});});
  if(focused)document.querySelector(`[data-mode="${focused}"]`)?.focus({preventScroll:true});
}

function renderTimeline() {
  const mode=activeRunMode();if(!mode)return;
  $('#timelineRail').innerHTML=(mode.samples||[]).map(item=>`<article class="run-point"><small>${escapeHtml(item.phase)}</small><b>${formatTime(new Date(item.at))}</b><span>${Number.isFinite(item.probability)?item.probability+'%':'—'} · ${Number.isFinite(expectedMm(item))?Number(expectedMm(item).toFixed(2))+'mm':'—'}</span></article>`).join('');
}

function evidenceRows() {
  const data = state.data;
  if (!data) return [];
  const mode = activeRunMode();
  const first = modePoint(mode, "출발") || data.forecast.find((item) => item.minutes === 30) || data.forecast[0];
  const models = first?.multiModel;
  const recent = data.recentConditions;
  const cameras = currentCctvs();
  const analyzed = cameras.filter((camera) => ["yes", "no", "uncertain"].includes(camera.rainNow));
  const surface = surfaceInfo(mode?.summary ? { surface: mode.summary.surface } : first?.runAssessment, recent, mode?.immediate ? cameras : []);
  return { data, mode, first, models, recent, surface, cameras, analyzed };
}

function renderEvidence() {
  const { mode, first, models, recent, surface }=evidenceRows();
  const recentCopy=recent ? `최근 3시간 ${recent.recentTotalMm}mm · ${surface.short}` : "최근 강수 자료가 없어 노면을 추정하지 못했어요";
  const modelsCopy=models?.availableModels
    ? `출발 무렵 ${models.availableModels}개 중 ${models.wetVotes || 0}개가 비를 예상해요`
    : "비교할 다른 예보가 없어요";
  $('#evidenceSummary').innerHTML=`<div class="evidence-item"><b>노면</b><small>${escapeHtml(recentCopy)}</small></div><div class="evidence-item"><b>다른 예보</b><small>${escapeHtml(modelsCopy)}</small></div>`;
  const officialSource=first?.sourceLabel || "기상청 예보 자료 없음";
  const issuedAt=first?.issuedAt, targetAt=first?.sourceTime;
  const officialDetail=[officialSource,issuedAt?`발표 ${extras.stamp(issuedAt)}`:null,targetAt?`예보 시각 ${extras.stamp(targetAt)}`:null].filter(Boolean).join(" · ");
  const modelDetail=[models?.validAt?`예보 시각 ${escapeHtml(extras.stamp(models.validAt))}`:null,(models?.models || []).map(model=>`${escapeHtml(model.label)}: ${Number.isFinite(model.probability)?`${model.probability}%`:"확률 자료 없음"} · ${Number.isFinite(model.amount)?`${Number(model.amount.toFixed(2))}mm`:"강수량 자료 없음"}`).join("<br>")].filter(Boolean).join("<br>") || "비교 가능한 다른 예보 자료가 없어요.";
  const thermal=state.thermal?.locationKey===locationKey(state.location)?state.thermal:null;
  const thermalSource=thermal?.data?.source||"Open-Meteo";
  const thermalDetail=thermal?.data?.fetchedAt
    ? `${thermalSource} · 자료 갱신 ${extras.stamp(thermal.data.fetchedAt)} · 시간별 예보`
    : thermal?.status==='loading' ? "Open-Meteo · 기온 자료를 불러오는 중"
    : "Open-Meteo · 기온 자료 없음";
  const surfaceDetail=recent ? `최근 강수와 시간대 예보로 노면을 추정해요. CCTV 원본은 현장을 영상으로 확인할 때 쓰며, 아직 분석하지 않은 영상은 판단에 반영하지 않아요.` : "최근 강수 자료가 없어 노면 상태를 추정하지 않아요.";
  $('#evidenceDetail').innerHTML=`<div class="detail-fact"><b>눈·비: 기상청</b><span>${escapeHtml(officialDetail)}</span></div><div class="detail-fact"><b>기온: ${escapeHtml(thermalSource)}</b><span>${escapeHtml(thermalDetail)}</span></div><div class="detail-fact"><b>모델별 출발 무렵</b><span>${modelDetail}</span></div><div class="detail-fact"><b>노면 추정</b><span>${escapeHtml(surfaceDetail)}</span></div><p class="detail-note">기온은 출발·복귀 정시의 시간별 예보를 사용하고 정시 사이에는 해당 시간대 예보를 보여드려요. 강수확률은 러닝 구간 최대값, 강수량은 1시간 예상 누적량이에요. 눈·비는 기상청, 기온·체감·옷차림은 Open-Meteo 자료를 사용해요.</p>`;
}

function cctvStatus(camera) {
  if (camera.rainNow === "yes") return ["rain", camera.intensity === "moderate" ? "영상에 비가 보여요 · 중간" : "영상에 비가 보여요"];
  if (camera.rainNow === "no") return ["dry", "현재 비가 보이지 않아요"];
  if (camera.rainNow === "uncertain") return ["", "영상은 분석했지만 판단이 어려워요"];
  return ["", "아직 확인 안 함"];
}

function renderCctv() {
  const focusedCctvId=document.activeElement?.closest?.(".cctv-card")?.dataset.cctvId || null;
  const context=currentContext(), cameras=currentCctvs().slice().sort((a,b)=>(a.distance??Infinity)-(b.distance??Infinity)||String(a.id).localeCompare(String(b.id)));
  const cctvFailure=Boolean(context?.errors?.some(error=>String(error).startsWith("CCTV:")));
  const rail=$("#cctvRail"), more=$("#moreCctv");
  if(context?.status === "loading") {
    rail.innerHTML='<div class="cctv-state"><span class="loading-orbit"></span><span>CCTV를 불러오고 있어요</span></div>';
    more.hidden=true;
  } else if(cctvFailure || context?.status === "error") {
    rail.innerHTML='<div class="cctv-state">CCTV를 불러오지 못했어요 <button id="retryCctv">다시 시도</button></div>';
    more.hidden=true;
    $('#retryCctv')?.addEventListener('click',()=>void refreshContext(true));
  } else if(!context?.cctv?.configured) {
    rail.innerHTML='<div class="cctv-state">CCTV 연결이 설정되지 않았어요</div>';
    more.hidden=true;
  } else if(!cameras.length) {
    rail.innerHTML='<div class="cctv-state">이 위치 주변에서 제공되는 CCTV가 없어요</div>';
    more.hidden=true;
  } else {
    const shown=state.cctvExpanded?cameras:cameras.slice(0,2);
    rail.innerHTML=shown.map(camera=>`<a class="cctv-card" data-cctv-id="${escapeHtml(camera.id)}" href="${escapeHtml(camera.url)}" target="_blank" rel="noopener noreferrer"><span><b>${icon('camera')} ${escapeHtml(camera.name)}</b><small>${escapeHtml(camera.sector)} 방향 · ${Number.isFinite(camera.distance)?`${camera.distance}km`:"거리 정보 없음"}</small></span><strong>${icon('external')}<span>영상</span></strong></a>`).join("")+(context?.cctv?.stale?'<p class="cctv-cache-note">이전 CCTV 목록을 보여드려요</p>':"");
    const remaining=Math.max(0,cameras.length-2);
    more.hidden=!remaining;
    more.innerHTML=state.cctvExpanded?`접기 ${icon('chevron')}`:`나머지 ${remaining}곳 보기 ${icon('chevron')}`;
    more.setAttribute('aria-expanded',String(state.cctvExpanded));
    more.onclick=()=>{state.cctvExpanded=!state.cctvExpanded;renderCctv();};
  }

  const realStill = cameras.some((camera) => camera.url && (camera.cctvType === "3" || String(camera.format).toLowerCase().includes("jpg")));
  const publicMode = state.runtime.mode === "public" || state.runtime.aiEnabled === false;
  const blockers = [];
  if (publicMode) blockers.push("공개 배포에서는 분석을 사용할 수 없어요");
  else if (!state.codex?.codex) blockers.push("로컬 분석 연결이 필요해요");
  if (!publicMode && !realStill) blockers.push("분석할 수 있는 영상이 없어요");
  $("#analyzeBtn").hidden = publicMode || !realStill;
  $("#analysisHint").hidden = publicMode || !realStill;
  $("#analyzeBtn").disabled = blockers.length > 0 || state.analyzing;
  $("#analysisHint").textContent = blockers.length ? blockers.join(" · ") : "로컬에서만 사용 · 15초 간격 CCTV 이미지 2장으로 비와 노면을 분석해요.";
  if (focusedCctvId) [...document.querySelectorAll(".cctv-card")].find(link=>link.dataset.cctvId === focusedCctvId)?.focus({ preventScroll:true });
}

function renderAviation() {
  const aviation = currentAviation();
  const rows = [];
  for (const item of aviation.metar || []) rows.push(`<div class="aviation-block"><b>${escapeHtml(item.label || item.id)} · 현재 관측</b><small>${escapeHtml(item.role || "")}</small><code>METAR ${escapeHtml(item.id)}<br>${escapeHtml(item.raw || "자료 없음")}</code></div>`);
  for (const item of aviation.taf || []) rows.push(`<div class="aviation-block"><b>${escapeHtml(item.label || item.id)} · 단시간 예보</b><small>${escapeHtml(item.role || "")}</small><code>TAF ${escapeHtml(item.id)}<br>${escapeHtml(item.raw || "자료 없음")}</code></div>`);
  $("#aviationDetail").innerHTML = rows.length ? rows.join("") : "현재 항공기상 자료가 없어요.";
}

function renderMapSummary() {
  const selectedMode = activeRunMode();
  const modeSample = selectedMode?.samples?.find((sample) => Math.abs(sample.minutes - state.mapHorizon) <= 3);
  const item = state.data?.forecast?.find((entry) => entry.minutes === state.mapHorizon) || modeSample;
  if (!item) return;

  const mapKind = state.mapHorizon === 0 ? "현재 관측 강수 영상" : state.mapHorizon <= 60 ? "단기 비구름 이동 예측" : "기상청 강수 예측";
  $("#mapSelected").innerHTML = `<b>${horizonLabel(state.mapHorizon)}</b><span>${escapeHtml(mapKind)}</span>`;
  const baseHorizons = state.data?.forecast || [];
  const hasStandardHorizon = baseHorizons.some((entry) => entry.minutes === state.mapHorizon);
  const horizons = hasStandardHorizon || !modeSample ? baseHorizons : [
    ...baseHorizons,
    { minutes: state.mapHorizon, runDeparture: true, label: `${selectedMode?.label || "출발"} 출발` },
  ];
  $("#mapHorizons").innerHTML = horizons.map((entry) => `<button class="${entry.minutes === state.mapHorizon ? "active" : ""} ${entry.runDeparture ? "run-departure" : ""}" data-map-horizon="${entry.minutes}">${escapeHtml(entry.label || horizonLabel(entry.minutes))}</button>`).join("");
  $$("#mapHorizons button").forEach((button) => button.onclick = () => selectHorizon(Number(button.dataset.mapHorizon), false));
}

function setBusy(busy) {
  $('#refreshBtn').disabled=busy;$('#refreshBtn').setAttribute('aria-busy',String(busy));$('#refreshBtn').setAttribute('aria-label',busy?'새로고침 중':'활성 화면 새로고침');
}
function render() {
  if(state.view==='weekly')extras.syncBusy();else setBusy(state.loading);
  const data=state.data, usable=data&&!data.demo&&data.runModes?.some(completeMode);
  $('#decisionContent').hidden=!usable;$('#decisionEmpty').hidden=Boolean(usable);
  if(!usable) {
    $('#decisionEmpty').innerHTML=state.loading?'<span class="loading-orbit"></span><p>날씨를 확인하고 있어요</p>':'<p>날씨를 불러오지 못했어요</p><button id="retryDecision">다시 시도</button>';
    $('#retryDecision')?.addEventListener('click',()=>refreshData(true));
  }
  const date=data?.dataUpdatedAt;
  const thermal=state.thermal?.locationKey===locationKey(state.location)?state.thermal:null;
  const rainStamp=date?`눈·비 ${extras.stamp(date)}`:'눈·비 자료 없음';
  const thermalStamp=thermal?.data?.fetchedAt?`기온 ${extras.stamp(thermal.data.fetchedAt)}`:thermal?.status==='loading'?'기온 불러오는 중':'기온 자료 없음';
  $('#decisionStamp').textContent=usable?`자료 갱신 · ${rainStamp} · ${thermalStamp}`:'';
  $('#mapStamp').textContent=date?`자료 갱신 · 기상청 수치예보 ${extras.stamp(date)}`:'';
  if(data){renderDepartureModes();renderDecision();renderTimeline();renderEvidence();renderMapSummary();}
  renderCctv();renderAviation();if(state.naverMap)drawMapOverlays();
}

function refreshContext(manual = false) {
  if (!pageCanRefresh()) return Promise.resolve({ status: "skipped", reason: "lifecycle" });
  const location={...state.location}, key=locationKey(location), previous=currentContext();
  const keepList=Array.isArray(previous?.cctvs);
  const cachedRetryAt=previous?.cctv?.retryAt || previous?.cctv?.serverRetryAt;
  const requestOptions={manual,intervalMs:REFRESH_INTERVALS.context,dataAt:previous?.cctv?.fetchedAt,serverRetryAt:cachedRetryAt,fetcher:async({signal})=>{
    const response=await fetch("/api/mobile-context", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location }), signal });
    const context=await response.json();
    if (!response.ok) {
      const error=new Error(context.error||"CCTV 자료 요청 실패");
      applyRetryMetadata(error, context, response);
      throw error;
    }
    return context;
  }};
  const eligibility=refreshScheduler.eligibility('context',key,requestOptions);
  if(!eligibility.allowed)return Promise.resolve({status:'skipped',reason:eligibility.reason,meta:eligibility.meta});
  const request=refreshScheduler.request('context',key,requestOptions);
  if(eligibility.shared)return request;
  state.context=keepList ? { ...previous, status:"refreshing" } : { locationKey:key, status:"loading", cctvs:null, cctv:null, aviation:null, errors:[] };
  if (!keepList) render();
  return request.then(outcome=>{
    if (key!==locationKey(state.location)) return outcome;
    if (outcome.status==='success') {
      const context=outcome.value;
      state.context={locationKey:key,status:"ready",cctvs:Array.isArray(context.cctvs)?context.cctvs:[],cctv:context.cctv||null,aviation:context.aviation||{metar:[],taf:[]},errors:context.errors||[]};
    } else if (outcome.status==='error' && outcome.error?.name!=='AbortError') {
      const keep=keepList;
      state.context=keep ? {...previous,status:"ready",errors:[`CCTV: ${outcome.error.message||"조회 실패"}`]} : {locationKey:key,status:"error",cctvs:[],cctv:null,aviation:{metar:[],taf:[]},errors:[`CCTV: ${outcome.error?.message||"조회 실패"}`]};
    } else if (outcome.status==='skipped') {
      state.context=keepList ? {...previous,status:"ready"} : previous?.status==='ready' ? {...previous,status:"ready"} : {locationKey:key,status:"error",cctvs:[],cctv:null,aviation:{metar:[],taf:[]},errors:[`CCTV: ${outcome.reason==='server-retry'?'재시도 대기 중':'조회가 아직 가능하지 않아요'}`]};
    }
    if(outcome.status!=='skipped'||!keepList)render();
    return outcome;
  });
}

async function refreshData(force = true) {
  const controllerKey=locationKey(state.location), token = state.refreshToken;
  const pointKey = locationKey(state.location);
  const cached = hydrateCoreCache() || readForecastCache('core', pointKey);
  void extras.loadWeekly(force);
  if (!pageCanRefresh()) {
    state.loading=false;$('#refreshBtn').disabled=false;render();
    return { status: "skipped", reason: "lifecycle" };
  }
  if((state.view==='decision'||state.view==='map')&&contextNeedsRefresh()) void refreshContext();
  if (!state.data && cached) { state.data = normalizeCoreData(cached,currentCctvs()); state.usingCachedData = true; render(); }
  state.loading = true;
  $("#refreshBtn").disabled = true;  render();
  const request=refreshScheduler.request('core',pointKey,{manual:force,intervalMs:REFRESH_INTERVALS.core,timeoutMs:REFRESH_TIMEOUTS.core,dataAt:cached?.dataUpdatedAt,expiresAt:cached?.expiresAt,serverRetryAt:state.data?.refresh?.retryAt||state.data?.cache?.retryAt,fetcher:async({signal})=>{
    const response=await fetch("/api/mobile-forecast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location: state.location }), signal });
    const payload=await response.json();
    if (!response.ok) {
      const error=new Error(payload.error||"날씨 자료 요청 실패");
      applyRetryMetadata(error, payload, response);
      throw error;
    }
    return payload;
  }});
  const outcome=await request;
  if (token !== state.refreshToken || controllerKey!==locationKey(state.location)) return outcome;
  if(outcome.status==='success'){
    const payload=normalizeCoreData(outcome.value,currentCctvs()), usable=!payload.demo&&payload.runModes?.some(completeMode);
    if(!usable&&state.data?.runModes?.some(m=>m.decision.level!=='unknown')) state.usingCachedData=true;
    else {
      payload.expiresAt=new Date(Date.parse(payload.dataUpdatedAt||payload.generatedAt)+REFRESH_INTERVALS.core).toISOString();
      // Radar canvases belong to the forecast snapshot that produced them.
      // Drop an in-flight generation before replacing that snapshot so the
      // next map render cannot share a request carrying the old raster.
      invalidateRadarSequence("예보 자료 변경", { clearCache: true });
      state.data=payload;state.usingCachedData=Boolean(outcome.stale);if(usable)writeForecastCache('core',pointKey,payload);
    }
    render();
    if(state.view==='map')void startRadarSequence();
  } else if(outcome.status==='error'&&outcome.error?.name!=='AbortError'){
    state.usingCachedData=Boolean(state.data);if(!state.data)resetDecision('날씨를 불러오지 못했어요');if(force)toast(state.data?'새 자료를 불러오지 못해 이전 자료를 보여드려요':'날씨를 불러오지 못했어요');
  }
  state.loading=false;$("#refreshBtn").disabled=false;render();
  return outcome;
}

function resetDecision() { render(); $('#mapHorizons').replaceChildren(); $('#mapSelected').textContent='현재 기준'; }

const extras = createExtras(state, { toast, switchView, loadNaverSdk, openSheet, setBusy,
  refreshScheduler,
  canRefresh: pageCanRefresh,
  setThermal(snapshot) {
    if (!snapshot || snapshot.key !== locationKey(state.location)) return;
    state.thermal={locationKey:snapshot.key,status:snapshot.status,data:snapshot.data||null,error:snapshot.error||null};
    render();
  },
  resetNaverSdk(){state.naverSdkPromise=null;},
  async changeLocation(point) {
    const previousKey=locationKey(state.location);
    refreshScheduler.cancel('core',previousKey,{intentional:true,reason:'위치 변경'});
    refreshScheduler.cancel('weekly',previousKey,{intentional:true,reason:'위치 변경'});
    refreshScheduler.cancel('context',previousKey,{intentional:true,reason:'위치 변경'});
    cancelRadarRequest(`${previousKey}:${state.mapHorizon}`, '위치 변경');
    state.refreshController?.abort();state.contextController?.abort();state.analysisController?.abort();++state.refreshToken;++state.analysisToken;
    state.location=point;state.route=point.id;state.data=null;state.usingCachedData=false;state.cctvExpanded=false;state.analyzing=false;
    state.thermal={locationKey:locationKey(point),status:"idle",data:null,error:null};
    state.context={ locationKey:locationKey(point), status:"idle", cctvs:null, cctv:null, aviation:null, errors:[] };
    invalidateRadarSequence("위치 변경", { cancel: false, clearCache: true });
    clearMapOverlays();$('#mapStamp').textContent='';
    if(state.naverMap)state.naverMap.panTo(new naver.maps.LatLng(point.lat,point.lon));
    void extras.loadWeekly(false);
    if(state.view==='weekly'){render();return;}
    await refreshData(false);
  }
});

async function refreshMap() {
  if(!pageCanRefresh())return {status:'skipped',reason:'lifecycle'};
  setBusy(true);
  try { return await startRadarSequence({manual:true}); }
  finally { if(state.view==='map')setBusy(false); }
}

function selectHorizon(minutes, openMap) {
  const previousKey=radarKey(state.location,state.mapHorizon), nextKey=radarKey(state.location,minutes);
  if (previousKey!==nextKey) {
    cancelRadarRequest(previousKey, '지도 시간 선택 변경');
    invalidateRadarSequence("지도 시간 선택 변경", { cancel: false, clearCache: false });
  }
  state.mapHorizon = minutes; renderTimeline(); renderMapSummary();
  if (openMap) switchView("map");
  else if (state.view === "map") { drawMapOverlays(); void startRadarSequence(); }
}

const viewScroll={};
async function switchView(view) {
  viewScroll[state.view]=window.scrollY;state.view=view;
  $$('.mobile-view').forEach(section=>section.classList.toggle('active',section.dataset.view===view));
  $$('.bottom-nav button').forEach(button=>{button.classList.toggle('active',button.dataset.tab===view);if(button.dataset.tab===view)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
  window.scrollTo({top:viewScroll[view]||0,behavior:'auto'});
  if(view==='weekly'){extras.render();void extras.loadWeekly();extras.syncBusy();}
  else {render();if(pageCanRefresh()&&!state.loading)void refreshData(false);if((view==='decision'||view==='map')&&pageCanRefresh()&&contextNeedsRefresh())void refreshContext();}
  if(view==='map'){await ensureMap();if(state.naverMap){naver.maps.Event.trigger(state.naverMap,'resize');drawMapOverlays();}await startRadarSequence();}
  else {clearInterval(state.radarTimer);state.radarTimer=null;}
}

function loadNaverSdk(key) {
  if (!key) return Promise.resolve(false);
  if (window.naver?.maps) return Promise.resolve(true);
  if (state.naverSdkPromise) return state.naverSdkPromise;
  state.naverSdkPromise = new Promise((resolve) => {
    let completed = false;
    const finish = (ready) => { if (completed) return; completed = true; resolve(Boolean(ready)); };
    window.initRunCastMobileNaver = () => { if (window.naver?.maps) finish(true); };
    window.navermap_authFailure = () => { finish(false); };
    const script = document.createElement("script");
    script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(key)}&callback=initRunCastMobileNaver`;
    script.onload = () => { if (window.naver?.maps) finish(true); };
    script.onerror = () => { finish(false); };
    document.head.appendChild(script);
    setTimeout(() => finish(Boolean(window.naver?.maps)), 6000);
  });
  return state.naverSdkPromise;
}

async function ensureMap() {
  if (state.naverMap) return true;
  const ready = await loadNaverSdk(state.keys.naverKey);
  if (!ready) { $("#mapLoading p").textContent = "지도를 불러오지 못했어요. 다시 시도해 주세요."; return false; }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const route = state.location;
  state.naverMap = new naver.maps.Map("mobileNaverMap", {
    center: new naver.maps.LatLng(route.lat, route.lon), zoom: 11,
    mapTypeId: naver.maps.MapTypeId.NORMAL, mapTypeControl: false,
    zoomControl: true, zoomControlOptions: { position: naver.maps.Position.RIGHT_CENTER },
  });
  $("#mapLoading").classList.add("hidden");
  drawMapOverlays();
  return true;
}

function clearMapOverlays() { state.overlays.forEach((overlay) => overlay.setMap(null)); state.overlays = []; }

function drawMapOverlays() {
  if (!state.naverMap || !state.data) return;
  clearMapOverlays();
  const route = state.location;
  state.overlays.push(new naver.maps.Marker({ map: state.naverMap, position: new naver.maps.LatLng(route.lat, route.lon), icon: { content: '<div class="naver-marker-mobile route">RUN</div>', anchor: new naver.maps.Point(22, 16) } }));
  for (const camera of currentCctvs()) {
    state.overlays.push(new naver.maps.Marker({ map: state.naverMap, position: new naver.maps.LatLng(camera.lat, camera.lon), title: camera.name, icon: { content: `<div class="naver-marker-mobile">${escapeHtml(camera.sector)}</div>`, anchor: new naver.maps.Point(18, 16) } }));
  }
}

function radarKey(location = state.location, horizon = state.mapHorizon) {
  return `${locationKey(location)}:${Number(horizon)}`;
}

function radarRequestIsCurrent(key, horizon, dataSnapshot) {
  return key === radarKey(state.location, state.mapHorizon)
    && Number(horizon) === Number(state.mapHorizon)
    && state.view === "map"
    && Boolean(state.naverMap)
    && state.data === dataSnapshot
    && Boolean(dataSnapshot?.radar?.configured);
}

function cancelRadarRequest(key, reason) {
  if (refreshScheduler.cancel("radar", key, { intentional: true, reason })) refreshScheduler.inflight.delete(`radar:${key}`);
}

function invalidateRadarSequence(reason = "레이더 자료 변경", { cancel = true, clearCache = false } = {}) {
  const key = radarKey();
  if (cancel) cancelRadarRequest(key, reason);
  clearInterval(state.radarTimer); state.radarTimer = null;
  ++state.radarLoadToken;
  state.radarFrameKey = null;
  state.radarFrames = [];
  state.radarFrameIndex = 0;
  if (clearCache) state.radarSequenceCache.clear();
  state.radarOverlay?.setMap(null);
  $("#radarDots").replaceChildren();
}

function radarMinutes(horizon = state.mapHorizon) {
  const step = horizon >= 180 ? 10 : 5;
  const start = Math.max(0, horizon - step * 4);
  return Array.from({ length: 5 }, (_, index) => start + index * step);
}

function radarProductLabel(horizon) {
  const blended = horizon > 60;
  return horizon === 0 ? "현재 관측 강수" : blended ? "기상청 강수 예측" : "단기 비구름 이동 예측";
}

function renderRadarDots(frames) {
  $("#radarDots").innerHTML = frames.map((frame, index) => {
    const status = frame.status === "ready" ? "준비됨" : frame.status === "error" ? "영상 없음" : "불러오는 중";
    const className = frame.status === "ready" ? "loaded" : frame.status === "error" ? "failed" : "";
    return `<button class="${className}" data-radar-index="${index}" aria-label="강수 영상 ${radarFrameLabel(frame.minutes)} ${status}" aria-current="${index === state.radarFrameIndex ? "true" : "false"}"></button>`;
  }).join("");
  $$("#radarDots button").forEach((button) => button.onclick = () => { showRadarFrame(Number(button.dataset.radarIndex)); syncRadarTimer(); });
}

function radarCacheEntry(key) {
  const entry = state.radarSequenceCache.get(key);
  if (!entry || entry.dataSnapshot !== state.data || !entry.frames?.some((frame) => frame.surface)) return null;
  return entry;
}

function cacheRadarSequence(key, horizon, dataSnapshot) {
  if (dataSnapshot !== state.data || state.radarFrameKey !== key || !state.radarFrames.some((frame) => frame.surface)) return;
  if (!state.radarSequenceCache.has(key) && state.radarSequenceCache.size >= 8) {
    state.radarSequenceCache.delete(state.radarSequenceCache.keys().next().value);
  }
  state.radarSequenceCache.set(key, {
    key,
    horizon,
    dataSnapshot,
    frames: state.radarFrames.map((frame) => ({ ...frame })),
    frameIndex: state.radarFrameIndex,
    storedAt: Date.now(),
  });
}

function restoreRadarSequence(entry) {
  if (!entry || entry.dataSnapshot !== state.data || state.view !== "map" || !state.naverMap || radarKey() !== entry.key) return false;
  clearInterval(state.radarTimer); state.radarTimer = null;
  state.radarFrameKey = entry.key;
  state.radarFrames = entry.frames.map((frame) => ({ ...frame }));
  const firstLoaded = state.radarFrames.findIndex((frame) => frame.surface);
  state.radarFrameIndex = state.radarFrames[entry.frameIndex]?.surface ? entry.frameIndex : firstLoaded;
  $("#radarProduct").textContent = radarProductLabel(entry.horizon);
  $("#radarPlay").disabled = false;
  renderRadarDots(state.radarFrames);
  state.radarOverlay?.setMap(null);
  if (firstLoaded >= 0) showRadarFrame(state.radarFrameIndex);
  syncRadarTimer();
  return firstLoaded >= 0;
}

async function transparentRadarFrame(minutes, signal, dataSnapshot = state.data) {
  const response = await fetch(`/api/radar?minutes=${minutes}&snapshot=${encodeURIComponent(dataSnapshot?.generatedAt || "")}`, { signal });
  if (!response.ok) throw new Error(`레이더 프레임 ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  const raster = dataSnapshot?.radar?.raster || { sourceX: 0, sourceY: 20, width: 700, height: 700 };
  const canvas = document.createElement("canvas"); canvas.width = raster.width; canvas.height = raster.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, raster.sourceX, raster.sourceY, raster.width, raster.height, 0, 0, raster.width, raster.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const r = pixels.data[index], g = pixels.data[index + 1], b = pixels.data[index + 2];
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    if (spread < 28 || Math.max(r, g, b) < 70) pixels.data[index + 3] = 0;
    else pixels.data[index + 3] = Math.min(225, 80 + spread * 2);
  }
  context.putImageData(pixels, 0, 0); bitmap.close?.(); return canvas;
}

function radarPixelToLatLng(px, py) {
  const projection = state.data?.radar?.lcc || { lat1: 30, lat2: 60, lat0: 0, lon0: 126, xMin: -440000, yMin: 3797382.7212162036, xMax: 584000, yMax: 4821382.721216239 };
  const raster = state.data?.radar?.raster || { width: 700, height: 700 };
  const rad = Math.PI / 180, a = 6378137, e = Math.sqrt(0.0066943799901413165);
  const m = (phi) => Math.cos(phi) / Math.sqrt(1 - e * e * Math.sin(phi) ** 2);
  const t = (phi) => Math.tan(Math.PI / 4 - phi / 2) / Math.pow((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi)), e / 2);
  const phi1 = projection.lat1 * rad, phi2 = projection.lat2 * rad, phi0 = projection.lat0 * rad;
  const n = (Math.log(m(phi1)) - Math.log(m(phi2))) / (Math.log(t(phi1)) - Math.log(t(phi2)));
  const f = m(phi1) / (n * Math.pow(t(phi1), n)), rho0 = a * f * Math.pow(t(phi0), n);
  const x = projection.xMin + px / raster.width * (projection.xMax - projection.xMin);
  const y = projection.yMax - py / raster.height * (projection.yMax - projection.yMin);
  const rho = Math.hypot(x, rho0 - y), theta = Math.atan2(x, rho0 - y), tt = Math.pow(rho / (a * f), 1 / n);
  let phi = Math.PI / 2 - 2 * Math.atan(tt);
  for (let index = 0; index < 7; index += 1) phi = Math.PI / 2 - 2 * Math.atan(tt * Math.pow((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi)), e / 2));
  return { lat: phi / rad, lon: projection.lon0 + theta / n / rad };
}

function drawRadarTriangle(context, image, s0, s1, s2, d0, d1, d2) {
  const denominator = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  if (!denominator) return;
  const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / denominator;
  const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / denominator;
  const e = (d0.x * (s1.x * s2.y - s2.x * s1.y) + d1.x * (s2.x * s0.y - s0.x * s2.y) + d2.x * (s0.x * s1.y - s1.x * s0.y)) / denominator;
  const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / denominator;
  const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / denominator;
  const f = (d0.y * (s1.x * s2.y - s2.x * s1.y) + d1.y * (s2.x * s0.y - s0.x * s2.y) + d2.y * (s0.x * s1.y - s1.x * s0.y)) / denominator;
  context.save(); context.beginPath(); context.moveTo(d0.x, d0.y); context.lineTo(d1.x, d1.y); context.lineTo(d2.x, d2.y); context.closePath(); context.clip(); context.transform(a, b, c, d, e, f); context.drawImage(image, 0, 0); context.restore();
}

function createRadarOverlay(map) {
  const overlay = new naver.maps.OverlayView();
  overlay.surface = null; overlay.canvas = document.createElement("canvas");
  Object.assign(overlay.canvas.style, { position: "absolute", left: "0", top: "0", pointerEvents: "none", opacity: ".58" });
  overlay.onAdd = function () { this.getPanes().overlayLayer.appendChild(this.canvas); };
  overlay.onRemove = function () { this.canvas.remove(); };
  overlay.setFrame = function (surface) { this.surface = surface; if (this.getMap()) this.draw(); };
  overlay.draw = function () {
    if (!this.surface) return;
    const mapNode = $("#mobileNaverMap"), width = mapNode.clientWidth, height = mapNode.clientHeight, dpr = Math.min(devicePixelRatio || 1, 2);
    if (!width || !height) return;
    this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`; this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr);
    const context = this.canvas.getContext("2d"); context.scale(dpr, dpr);
    const mapProjection = this.getProjection(), step = 35, size = 700, nodes = [];
    for (let y = 0; y <= size; y += step) {
      const row = [];
      for (let x = 0; x <= size; x += step) { const point = radarPixelToLatLng(x, y); row.push(mapProjection.fromCoordToOffset(new naver.maps.LatLng(point.lat, point.lon))); }
      nodes.push(row);
    }
    for (let row = 0; row < nodes.length - 1; row += 1) for (let column = 0; column < nodes[row].length - 1; column += 1) {
      const d00 = nodes[row][column], d10 = nodes[row][column + 1], d01 = nodes[row + 1][column], d11 = nodes[row + 1][column + 1];
      if (Math.max(d00.x, d10.x, d01.x, d11.x) < 0 || Math.min(d00.x, d10.x, d01.x, d11.x) > width || Math.max(d00.y, d10.y, d01.y, d11.y) < 0 || Math.min(d00.y, d10.y, d01.y, d11.y) > height) continue;
      const x = column * step, y = row * step, s00 = { x, y }, s10 = { x: x + step, y }, s01 = { x, y: y + step }, s11 = { x: x + step, y: y + step };
      drawRadarTriangle(context, this.surface, s00, s10, s11, d00, d10, d11); drawRadarTriangle(context, this.surface, s00, s11, s01, d00, d11, d01);
    }
  };
  overlay.setMap(map); return overlay;
}

function showRadarFrame(index) {
  if (!state.radarFrames.length || !state.naverMap) return;
  state.radarFrameIndex = ((index % state.radarFrames.length) + state.radarFrames.length) % state.radarFrames.length;
  const frame = state.radarFrames[state.radarFrameIndex];
  const label = radarFrameLabel(frame.minutes);
  $("#radarFrameLabel").textContent = label;
  $$("#radarDots button").forEach((dot, dotIndex) => {
    const active = dotIndex === state.radarFrameIndex;
    dot.classList.toggle("active", active);
    dot.setAttribute("aria-current", active ? "true" : "false");
  });
  if (frame.status === "error") {
    $("#radarState").textContent = "영상 없음";
    state.radarOverlay?.setMap(null);
    return;
  }
  if (!frame.surface) {
    $("#radarState").textContent = "불러오는 중";
    state.radarOverlay?.setMap(null);
    return;
  }
  $("#radarState").textContent = state.radarFrames.some((candidate) => candidate.status === "error") ? "일부 영상 없음" : "재생";
  if (!state.radarOverlay) state.radarOverlay = createRadarOverlay(state.naverMap);
  else if (!state.radarOverlay.getMap()) state.radarOverlay.setMap(state.naverMap);
  state.radarOverlay.setFrame(frame.surface);
}

function nextLoadedRadarIndex(start = state.radarFrameIndex) {
  for (let offset = 1; offset <= state.radarFrames.length; offset += 1) {
    const index = (start + offset) % state.radarFrames.length;
    if (state.radarFrames[index]?.surface) return index;
  }
  return start;
}

function syncRadarTimer() {
  clearInterval(state.radarTimer); state.radarTimer = null;
  const play = $("#radarPlay");
  const hasLoadedFrame = state.radarFrames.some((frame) => frame.surface);
  const hasFrameError = state.radarFrames.some((frame) => frame.status === "error");
  const allFramesFailed = state.radarFrames.length > 0 && state.radarFrames.every((frame) => frame.status === "error");
  if (allFramesFailed) state.radarPlaying = false;
  play.disabled = allFramesFailed;
  $("#radarState").textContent = allFramesFailed ? "영상 불러오기 실패" : hasFrameError ? "일부 영상 없음" : hasLoadedFrame ? state.radarPlaying ? "재생" : "일시정지" : $("#radarState").textContent;
  play.innerHTML = icon(state.radarPlaying ? "pause" : "play");
  play.setAttribute("aria-label", allFramesFailed ? "강수 영상 재생 불가" : state.radarPlaying ? "강수 영상 일시정지" : "강수 영상 재생");
  play.setAttribute("aria-pressed", String(state.radarPlaying));
  if (state.radarPlaying && state.view === "map" && document.visibilityState === "visible" && (typeof navigator === "undefined" || navigator.onLine !== false) && hasLoadedFrame) state.radarTimer = setInterval(() => showRadarFrame(nextLoadedRadarIndex()), 800);
}

async function loadRadarSequence({signal, key = radarKey(), horizon = state.mapHorizon, dataSnapshot = state.data} = {}) {
  clearInterval(state.radarTimer); state.radarTimer = null;
  if(signal?.aborted)throw signal.reason;
  if (!dataSnapshot?.radar?.configured || !state.naverMap || state.view !== "map" || !radarRequestIsCurrent(key, horizon, dataSnapshot)) {
    if (key === radarKey() && state.view === "map") $("#radarState").textContent = dataSnapshot?.radar?.configured ? "지도 대기" : "자료 없음";
    state.radarOverlay?.setMap(null);
    return { loaded: false, reason: "not-ready", key, horizon };
  }
  $("#radarProduct").textContent = radarProductLabel(horizon);
  $("#radarState").textContent = "불러오는 중";
  $("#radarPlay").disabled = false;
  state.radarOverlay?.setMap(null);
  const token = ++state.radarLoadToken;
  state.radarFrameKey = key;
  state.radarFrames = radarMinutes(horizon).map((minutes) => ({ minutes, surface: null, status: "loading" })); state.radarFrameIndex = 0;
  renderRadarDots(state.radarFrames);
  await Promise.all(state.radarFrames.map(async (frame, index) => {
    try {
      frame.surface = await transparentRadarFrame(frame.minutes, signal, dataSnapshot); frame.status = "ready";
      if (token === state.radarLoadToken && radarRequestIsCurrent(key, horizon, dataSnapshot)) {
        const button = $$("#radarDots button")[index];
        button?.classList.add("loaded");
        button?.setAttribute("aria-label", `강수 영상 ${radarFrameLabel(frame.minutes)} 준비됨`);
        if (index === 0 || state.radarFrameIndex === index) showRadarFrame(state.radarFrameIndex);
      }
    } catch (error) {
      if(signal?.aborted)throw error;
      frame.status = "error";
      if (token === state.radarLoadToken && radarRequestIsCurrent(key, horizon, dataSnapshot)) {
        const button = $$("#radarDots button")[index];
        button?.classList.add("failed");
        button?.setAttribute("aria-label", `강수 영상 ${radarFrameLabel(frame.minutes)} 없음`);
        if (state.radarFrameIndex === index) showRadarFrame(index);
        console.warn(error);
      }
    }
  }));
  if (token !== state.radarLoadToken || !radarRequestIsCurrent(key, horizon, dataSnapshot)) return { loaded: false, reason: "superseded", key, horizon };
  const loaded = state.radarFrames.filter((frame) => frame.surface).length;
  $("#radarState").textContent = loaded === state.radarFrames.length ? "재생" : loaded ? "일부 영상 없음" : "영상 불러오기 실패";
  const firstLoaded = state.radarFrames.findIndex((frame) => frame.surface);
  if (firstLoaded >= 0) showRadarFrame(state.radarFrames[state.radarFrameIndex]?.surface ? state.radarFrameIndex : firstLoaded);
  else state.radarOverlay?.setMap(null);
  syncRadarTimer();
  if (!loaded) return { loaded: false, reason: "all-failed", key, horizon };
  cacheRadarSequence(key, horizon, dataSnapshot);
  return { loaded: true, key, horizon, loadedFrames: loaded };
}

async function startRadarSequence({manual = false} = {}) {
  if(!pageCanRefresh())return {status:'skipped',reason:'lifecycle'};
  const requestLocation=state.location, requestHorizon=state.mapHorizon, key=radarKey(requestLocation,requestHorizon), dataSnapshot=state.data;
  if (state.view !== "map" || !dataSnapshot?.radar?.configured) return { status: "skipped", reason: "not-ready" };
  const mapReady=state.naverMap || await ensureMap();
  if (!mapReady || !radarRequestIsCurrent(key,requestHorizon,dataSnapshot)) return { status: "skipped", reason: "not-ready" };
  if (!manual) {
    const cached=radarCacheEntry(key);
    if (cached && restoreRadarSequence(cached)) return { status: "success", value: { loaded: true, cached: true, key, horizon: requestHorizon } };
    // A persisted success only says that a request once completed. It is not
    // a video cache. Fetch when this tab cannot show that selected sequence.
    if (!refreshScheduler.inflight.has(`radar:${key}`) && refreshScheduler.getMeta('radar',key)?.lastSuccessAt) refreshScheduler.reset('radar',key);
  }
  const request=refreshScheduler.request('radar',key,{manual,intervalMs:10_000,fetcher:async({signal})=>{
    if(manual)state.naverSdkPromise=null;
    if (!radarRequestIsCurrent(key,requestHorizon,dataSnapshot)) return { loaded: false, reason: "superseded", key, horizon: requestHorizon };
    const ready=await ensureMap();
    if (!ready || !radarRequestIsCurrent(key,requestHorizon,dataSnapshot)) return { loaded: false, reason: "superseded", key, horizon: requestHorizon };
    return loadRadarSequence({signal,key,horizon:requestHorizon,dataSnapshot});
  }});
  const outcome=await request;
  if (outcome.status==='success' && !outcome.value?.loaded) {
    refreshScheduler.reset('radar',key);
    return { ...outcome, status:'skipped', reason:outcome.value?.reason||'not-ready' };
  }
  return outcome;
}

async function analyzeCctv() {
  const cameras=currentCctvs();
  if (state.analyzing || !state.data || !cameras.length) return;
  if (state.runtime.mode === "public" || state.runtime.aiEnabled === false) return toast("노면 CCTV 분석은 로컬에서만 사용할 수 있어요.");
  const locationAtRequest=locationKey(state.location), refreshAtRequest=state.refreshToken, analysisAtRequest=++state.analysisToken;
  const controller=new AbortController();state.analysisController=controller;
  state.analyzing = true; $("#analyzeBtn").disabled = true; $("#analyzeBtn").textContent = "CCTV 영상 확인 중";
  try {
    const response = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cctvs: cameras, forecast: state.data.forecast }), signal: controller.signal });
    const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "분석 실패");
    if (analysisAtRequest !== state.analysisToken || refreshAtRequest !== state.refreshToken || locationAtRequest !== locationKey(state.location) || currentContext()?.locationKey !== locationAtRequest) return;
    const analyzed = new Map(payload.cameras.map((camera) => [camera.id, camera]));
    state.context = { ...state.context, cctvs: cameras.map((camera) => analyzed.get(camera.id) || camera) };
    state.data = normalizeCoreData(state.data, state.context.cctvs);
    render(); toast(payload.summary || "노면 CCTV 분석을 마쳤어요.");
  } catch (error) { if(error.name !== "AbortError" && analysisAtRequest === state.analysisToken) toast("CCTV 분석을 완료하지 못했어요. 다시 시도해 주세요."); }
  finally { if(analysisAtRequest === state.analysisToken){state.analyzing = false; $("#analyzeBtn").textContent = "CCTV 영상으로 비·노면 확인"; renderCctv();} }
}

function scrollToCctv() {
  if(contextNeedsRefresh()) void refreshContext(true);
  const reveal=()=>{
    const section=$("#cctvSection");
    section.scrollIntoView({ block:"start", behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth" });
    section.focus({ preventScroll:true });
  };
  if(state.view === "decision") reveal();
  else void switchView("decision").then(()=>requestAnimationFrame(reveal));
}

let activeSheet=null, pendingSheetPop=null, resolveSheetPop=null;
const silentSheetCloses=new WeakSet(), sheetFocus=new WeakMap();
async function openSheet(dialog) {
  if(pendingSheetPop)await pendingSheetPop;
  if(dialog.open)return;
  const returnTo=document.activeElement;
  sheetFocus.set(dialog,returnTo);
  if(activeSheet?.open){silentSheetCloses.add(activeSheet);activeSheet.close();history.replaceState({runcastSheet:dialog.id},'');}
  else history.pushState({runcastSheet:dialog.id},'');
  activeSheet=dialog;dialog.showModal();
  dialog.addEventListener('close',()=>{
    if(silentSheetCloses.has(dialog)){silentSheetCloses.delete(dialog);return;}
    if(activeSheet===dialog)activeSheet=null;
    if(history.state?.runcastSheet===dialog.id){pendingSheetPop=new Promise(resolve=>{resolveSheetPop=resolve;});history.back();}
    returnTo?.focus({preventScroll:true});
  },{once:true});
}
window.addEventListener('popstate',()=>{
  if(activeSheet?.open){const returnTo=sheetFocus.get(activeSheet);silentSheetCloses.add(activeSheet);activeSheet.close();activeSheet=null;returnTo?.focus({preventScroll:true});}
  resolveSheetPop?.();resolveSheetPop=null;pendingSheetPop=null;
});
function openSettings(){void openSheet($('#settingsSheet'));}
function closeSettings(){$('#settingsSheet').close();}

function renderConnectionStatus() {
  const rows = [
    ["네이버 지도", state.configured.naver],
    ["기상청 동네예보", state.configured.forecast],
    ["기상청 강수영상", state.configured.radar],
    ["ITS CCTV", state.configured.cctv],
  ];
  $("#connectionList").innerHTML = rows.map(([label, connected]) => `<div><span>${label}</span><b class="${connected ? "connected" : "missing"}">${connected ? "연결됨" : "미연결"}</b></div>`).join("");
}

async function boot() {
  $$(".bottom-nav button").forEach((button) => button.onclick = () => switchView(button.dataset.tab));
  $$('[data-open-view]').forEach((button) => button.onclick = () => switchView(button.dataset.openView));
  extras.boot();
  hydrateCoreCache();
  // Thermal/weekly uses its own Open-Meteo request and must not delay KMA core.
  void extras.loadWeekly(false);
  resetDecision();
  $("#refreshBtn").onclick = () => state.view === "weekly" ? extras.loadWeekly(true) : state.view === "map" ? refreshMap() : refreshData(true); $("#radarPlay").onclick = () => { state.radarPlaying = !state.radarPlaying; syncRadarTimer(); };
  $("#analyzeBtn").onclick = analyzeCctv; $("#settingsBtn").onclick = openSettings; $("#closeSettings").onclick = closeSettings;
  $('#moreBtn').onclick=()=>{const hidden=!$('#moreMenu').hidden;$('#moreMenu').hidden=hidden;$('#moreBtn').setAttribute('aria-expanded',String(!hidden));};
  $('#settingsBtn').onclick=()=>{$('#moreMenu').hidden=true;$('#moreBtn').setAttribute('aria-expanded','false');openSettings();};
  $('#jumpCctv').onclick=scrollToCctv;
  $('#openCctv').onclick=scrollToCctv;
  $$('[data-close-sheet]').forEach(button=>button.onclick=()=>button.closest('dialog').close());
  $$('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const bounds=dialog.getBoundingClientRect();if(event.clientY<bounds.top||event.clientX<bounds.left||event.clientX>bounds.right)dialog.close();}}));
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){$('#moreMenu').hidden=true;$('#moreBtn').setAttribute('aria-expanded','false');}});
  try {
    const config = await fetch("/api/config").then((response) => response.json());
    state.runtime = { ...state.runtime, ...(config.runtime || {}) };
    state.keys = { naverKey: config.keys?.naverKey || "" };
    state.configured = config.configured || {};
    renderConnectionStatus();
    $("#settingsIntro").textContent = state.runtime.mode === "public"
      ? "공개 배포 모드예요. 비밀 키와 AI 기능은 서버에서 관리해요."
      : "로컬 테스트는 프로젝트의 .env.local에 키를 입력한 뒤 서버를 재시작해 주세요. .env와 실행 환경변수도 사용할 수 있어요.";
  } catch { $("#settingsIntro").textContent = "데이터 연결 설정을 확인하지 못했어요. 서버 실행 상태를 확인해 주세요."; renderConnectionStatus(); }
  try {
    state.codex = await fetch("/api/status").then((response) => response.json());
    if (state.codex.runtimeMode) state.runtime = { ...state.runtime, mode: state.codex.runtimeMode, aiEnabled: state.codex.aiEnabled };
  } catch { state.codex = { codex: false }; }
  const refreshVisible = () => {
    refreshScheduler.cleanupExpired();
    if (!pageCanRefresh()) {
      syncRadarTimer();
      clearInterval(state.lifecycleTimer);state.lifecycleTimer=null;
      return;
    }
    clearInterval(state.lifecycleTimer);state.lifecycleTimer=setInterval(refreshVisible,60000);
    syncRadarTimer();
    if (state.view === 'weekly') void extras.loadWeekly();
    else if (!state.loading) void refreshData(false);
    if ((state.view === 'decision'||state.view==='map') && contextNeedsRefresh()) void refreshContext();
  };
  document.addEventListener('visibilitychange', refreshVisible);
  window.addEventListener('pageshow', refreshVisible);
  window.addEventListener('online', refreshVisible);
  window.addEventListener('offline', refreshVisible);
  if (pageCanRefresh()) await refreshData(false);
  else { state.loading=false; render(); }
  if (pageCanRefresh()) { clearInterval(state.lifecycleTimer);state.lifecycleTimer=setInterval(refreshVisible,60000); }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
}

boot();
