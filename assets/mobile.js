import { ROUTES, locationKey } from './weather-domain.mjs';
import { createExtras, storage, preferences, readForecastCache, writeForecastCache } from './mobile-extra.js';


// 이전 버전이 브라우저에 저장했던 비밀 키를 더 이상 사용하지 않고 제거합니다.
try { localStorage.removeItem("runcast.keys"); } catch {}

const state = {
  view: "decision", route: preferences.location.id, location: preferences.location, mapHorizon: 0, departureMode: "now", data: null,
  keys: {}, configured: {},
  runtime: { mode: "local", aiEnabled: true, aiLocalOnly: true }, codex: null,
  loading: true, analyzing: false, naverMap: null, naverSdkPromise: null,
  overlays: [], radarOverlay: null, radarFrames: [], radarFrameIndex: 0,
  radarPlaying: true, radarTimer: null, radarLoadToken: 0,
  refreshController: null, refreshToken: 0, usingCachedData: false, contextLoading: false,
};
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

function activeRunMode() {
  const modes = state.data?.runModes || [];
  return modes.find((mode) => mode.id === state.departureMode) || modes[0] || null;
}

function modePoint(mode, phase) {
  return mode?.samples?.find((sample) => sample.phase === phase) || null;
}

function expectedMm(item) {
  const value = item?.runAssessment?.expectedAmount;
  if (Number.isFinite(value)) return value;
  if (Number.isFinite(item?.villageMm)) return item.villageMm;
  return Number.isFinite(item?.mm) ? item.mm : null;
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

function modePrimaryCopy(mode) {
  if (mode?.decision?.level === "unknown") return "예보 자료를 확인할 수 없어요";
  if (mode?.samples?.some(s => s.runAssessment?.snow)) return "눈·진눈깨비로 러닝을 미뤄요";
  const summary = mode?.summary || {};
  const decision = mode?.decision || {};
  const amount = summary.estimatedAmount || 0;
  if (summary.surface === "recovering") return "비는 약해도 노면이 젖어 있을 수 있어요";
  if (decision.level === "red" || summary.peakAmount >= 3) return "1시간 러닝은 미루는 게 좋아요";
  if (amount <= .2 && decision.level === "green") return "눈·비 걱정 적어요";
  if (amount < 1 && decision.level !== "red") return "이슬비 괜찮으면 나가도 돼요";
  if (amount < 3) return "젖어도 괜찮다면 뛸 수 있어요";
  return decision.label || "출발 직전에 다시 확인하세요";
}

function surfaceInfo(assessment, recent = state.data?.recentConditions, cameras = state.data?.cctvs || []) {
  // 관측의 우선순위는 비 > 젖은 노면 > 판단 어려움 > 건조입니다.
  // 아직 분석하지 않은 unknown CCTV는 관측도, 판단 근거도 아닙니다.
  const analyzed = cameras.filter((camera) => ["yes", "no", "uncertain"].includes(camera.rainNow));
  if (analyzed.some((camera) => camera.rainNow === "yes")) return { short: "CCTV 비 확인", detail: "CCTV에서 현재 비가 확인됐어요", observed: true };
  if (analyzed.some((camera) => camera.roadWet === true)) return { short: "CCTV 노면 젖음", detail: "CCTV에서는 비가 보이지 않지만 젖은 노면이 확인됐어요", observed: true };
  if (analyzed.some((camera) => camera.rainNow === "uncertain")) return { short: "CCTV 판단 어려움", detail: "CCTV 영상은 분석했지만 비 여부가 분명하지 않아요", observed: true };
  if (analyzed.length) return { short: "CCTV 건조", detail: "분석한 CCTV에서 현재 비나 젖은 노면이 보이지 않아요", observed: true };
  if (assessment?.surface === "recovering" || assessment?.surface === "wet" || (recent?.recentTotalMm || 0) >= 1) {
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
  return mode?.decision?.level !== 'unknown' && mode?.samples?.length >= 3 && mode.samples.every(sample => !sample.unavailable && sample.runAssessment?.level !== 'unknown' && Number.isFinite(expectedMm(sample)));
}
function renderDecision() {
  const data=state.data, mode=activeRunMode(); if(!data||!mode)return;
  const complete=completeMode(mode), decision=complete?mode.decision:{level:'unknown'};
  const first=modePoint(mode,'출발');
  const surface=surfaceInfo({surface:mode.summary?.surface},data.recentConditions,mode.immediate?data.cctvs:[]);
  const expiredRun=Date.parse(mode.endAt)<Date.now();
  $('#decisionHero').className=`decision-hero ${decision.level}`;
  $('#decisionTitle').textContent=complete ? (expiredRun?'당시 눈·비 판단: '+modePrimaryCopy(mode):modePrimaryCopy(mode)):'예보가 부족해 판단을 보류해요';
  const departure=new Date(mode.departureAt), arrival=new Date(mode.endAt);
  $('#decisionWindow').textContent=`${expiredRun?'지난 예보 · ':''}${new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric'}).format(departure)} ${formatDayTime(departure)}–${formatTime(arrival)} · 1시간`;
  const probability=mode.summary?.officialProbabilityMax, mm=mode.summary?.estimatedAmount;
  $('#decisionReason').innerHTML=complete?`<div class="hero-metrics"><div><small>강수확률</small><b>${Number.isFinite(probability)?probability+'%':'—'}</b></div><div><small>예상 강수량</small><b>${Number.isFinite(mm)?Number(mm.toFixed(2))+'mm':'—'}</b></div></div><p class="surface-copy">노면 ${escapeHtml(surface.short)}${surface.observed?' · 실측':''}</p>`:'<p class="surface-copy">일부 시간의 자료가 없어 눈·비 판단을 제공하지 않습니다.</p>';
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
  const cameras = data.cctvs || [];
  const analyzed = cameras.filter((camera) => ["yes", "no", "uncertain"].includes(camera.rainNow));
  const surface = surfaceInfo(mode?.summary ? { surface: mode.summary.surface } : first?.runAssessment, recent, mode?.immediate ? cameras : []);
  const quality = dataQuality(data, first);
  return [
    { icon: "☂", title: "기상청 예보", copy: mode ? `강수확률 ${modeProbabilityCopy(mode)} · 1시간 예상 ${modeAmountCopy(mode)}` : `강수확률 ${probabilityCopy(first)} · 예상 ${rainAmountCopy(first)}`, status: mode?.decision?.level === "unknown" ? "자료 없음" : "확인", warn: mode?.decision?.level === "red" || first?.runAssessment?.level === "avoid" },
    { icon: "≋", title: "최근 비와 노면", copy: recent ? `최근 3시간 ${recent.recentTotalMm}mm · ${surface.detail}` : "최근 강수 자료를 확인하지 못했어요", status: surface.observed ? "관측" : "추정", warn: !recent || first?.runAssessment?.surface !== "dry" },
    { icon: "◇", title: "다른 예보", copy: models ? `${models.availableModels || 0}개 예보 중 ${models.wetVotes || 0}개가 비를 예상해요 · ${quality.detail}` : "다른 예보 자료를 확인하지 못했어요", status: quality.label.replace("자료 일치도 ", ""), warn: quality.label.endsWith("낮음") },
    { icon: "◎", title: "비구름 영상", copy: data.radar?.configured ? "지도에서 비구름의 예상 이동을 직접 볼 수 있어요" : "강수 영상은 현재 연결되지 않았어요", status: data.radar?.configured ? "확인 가능" : "제외", warn: !data.radar?.configured },
    { icon: "▣", title: "방향별 CCTV", copy: analyzed.length ? `${analyzed.length}곳 분석 완료 · ${surface.detail}` : cameras.length ? `${cameras.length}개 영상이 있지만 아직 분석하지 않았어요 · 판단에는 반영하지 않아요` : "CCTV 목록이 없어 판단에서 제외했어요", status: analyzed.length ? "관측" : "미확인", warn: false },
  ];
}

function renderEvidence() {
  const rows=evidenceRows();
  const rowHtml=row=>`<div class="evidence-item"><div><b>${escapeHtml(row.title)}</b><small>${escapeHtml(row.copy)}</small></div></div>`;
  $('#evidenceSummary').innerHTML=rows.slice(0,3).map(rowHtml).join('');
  $('#evidenceDetail').innerHTML=rows.map(rowHtml).join('');
}

function cctvStatus(camera) {
  if (camera.rainNow === "yes") return ["rain", camera.intensity === "moderate" ? "비가 확인돼요 · 중간" : "현재 비가 보여요"];
  if (camera.rainNow === "no") return ["dry", "현재 비가 보이지 않아요"];
  if (camera.rainNow === "uncertain") return ["", "영상은 분석했지만 판단이 어려워요"];
  return ["", "아직 확인 안 함"];
}

function renderCctv() {
  const cameras = state.data?.cctvs || [];
  $("#cctvCount").textContent = `${cameras.length}곳`;
  $("#cctvRail").innerHTML = cameras.length ? cameras.slice(0, 8).map((camera) => {
    const [klass, status] = cctvStatus(camera);
    return `<a class="cctv-card" href="${escapeHtml(camera.url || "#")}" target="_blank" rel="noopener noreferrer">
      <header><span>${escapeHtml(camera.sector)} 방향</span><span>${camera.distance ? `${camera.distance}km` : ""}</span></header>
      <h3>${escapeHtml(camera.name)}</h3><p>${escapeHtml(camera.rainNow === "unknown" ? status : (camera.evidence || status))}</p>
      <footer><span>원본 영상 직접 보기 ↗</span><i class="${klass}"></i></footer>
    </a>`;
  }).join("") : `<div class="empty-card">주변 CCTV 없음</div>`;

  const realStill = cameras.some((camera) => camera.url && (camera.cctvType === "3" || String(camera.format).toLowerCase().includes("jpg")));
  const publicMode = state.runtime.mode === "public" || state.runtime.aiEnabled === false;
  const blockers = [];
  if (publicMode) blockers.push("공개 배포에서는 AI 분석 비활성화");
  else if (!state.codex?.codex) blockers.push("로컬 Codex CLI 미연결");
  if (!publicMode && !realStill) blockers.push("분석 가능한 정지영상 없음");
  $("#analyzeBtn").hidden = publicMode;
  $("#analyzeBtn").disabled = blockers.length > 0 || state.analyzing;
  $("#analysisHint").textContent = publicMode
    ? "자동 확인은 내 컴퓨터에서만 사용할 수 있어요. 영상은 카드에서 직접 열어볼 수 있어요."
    : blockers.length ? blockers.join(" · ") : "로컬에서만 사용 · 15초 간격 이미지 2장으로 현재 비와 노면을 확인해요.";
}

function renderAviation() {
  const aviation = state.data?.aviation || { metar: [], taf: [] };
  const rows = [];
  for (const item of aviation.metar || []) rows.push(`<div class="aviation-block"><b>${escapeHtml(item.label || item.id)} · 현재 관측</b><small>${escapeHtml(item.role || "")}</small><code>METAR ${escapeHtml(item.id)}<br>${escapeHtml(item.raw || "자료 없음")}</code></div>`);
  for (const item of aviation.taf || []) rows.push(`<div class="aviation-block"><b>${escapeHtml(item.label || item.id)} · 단시간 예보</b><small>${escapeHtml(item.role || "")}</small><code>TAF ${escapeHtml(item.id)}<br>${escapeHtml(item.raw || "자료 없음")}</code></div>`);
  $("#aviationDetail").innerHTML = rows.length ? rows.join("") : "현재 항공기상 자료가 없습니다.";
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
  $('#refreshBtn').disabled=busy;$('#refreshBtn').setAttribute('aria-busy',String(busy));
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
  $('#decisionStamp').textContent=usable&&date?`기상청 중심 · ${extras.stamp(date)} 업데이트`:'';
  $('#mapStamp').textContent=date?`기상청 수치예보 · ${extras.stamp(date)} 업데이트`:'';
  if(data){renderDepartureModes();renderDecision();renderTimeline();renderEvidence();renderMapSummary();}
  renderCctv();renderAviation();if(state.naverMap)drawMapOverlays();
}

async function loadMobileContext(token, controller) {
  state.contextLoading = true;
  try {
    const response = await fetch("/api/mobile-context", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location: state.location }), signal: controller.signal });
    const context = await response.json();
    if (!response.ok) throw new Error(context.error || "CCTV 자료 요청 실패");
    if (token !== state.refreshToken || controller.signal.aborted || !state.data) return;
    state.data = { ...state.data, cctvs: context.cctvs, cctv: context.cctv, aviation: context.aviation };
    render();
  } catch (error) { /* Context failure leaves existing evidence intact. */ }
  finally { if (token === state.refreshToken) state.contextLoading = false; }
}

async function refreshData(force = true) {
  state.refreshController?.abort();
  const controller = new AbortController();
  state.refreshController = controller;
  const token = ++state.refreshToken;
  const pointKey = locationKey(state.location);
  const cached = readForecastCache('core', pointKey);
  if (!state.data && cached) { state.data = cached; state.usingCachedData = true; render(); }
  if (!force && cached && Date.now() < Date.parse(cached.expiresAt)) { state.loading = false; $("#refreshBtn").disabled = false;  render(); void loadMobileContext(token, controller); return; }
  state.loading = true; state.contextLoading = false;
  $("#refreshBtn").disabled = true;  render();
  try {
    const response = await fetch("/api/mobile-forecast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location: state.location }), signal: controller.signal });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "날씨 자료 요청 실패");
    if (token !== state.refreshToken) return;
    const usable = !payload.demo && payload.runModes?.some(completeMode);
    if (!usable && state.data?.runModes?.some(m => m.decision.level !== 'unknown')) {
      state.usingCachedData = true;
    } else {
      payload.expiresAt = new Date(Date.parse(payload.dataUpdatedAt || payload.generatedAt)+5*60000).toISOString();
      state.data = payload; state.usingCachedData = false;
      if (usable) writeForecastCache('core', pointKey, payload);
    }
    render();
    if (state.view === "map") void startRadarSequence();
    void loadMobileContext(token, controller);
  } catch (error) {
    if (error.name !== "AbortError" && token === state.refreshToken) {
      state.usingCachedData = Boolean(state.data);
      if (!state.data) resetDecision('날씨를 불러오지 못했어요');
      if(force)toast(state.data ? '갱신 실패 · 기존 자료를 유지합니다' : '날씨를 불러오지 못했어요');
    }
  } finally { if (token === state.refreshToken) { state.loading = false; $("#refreshBtn").disabled = false;  render(); } }
}

function resetDecision() { render(); $('#mapHorizons').replaceChildren(); $('#mapSelected').textContent='현재 기준'; }

const extras = createExtras(state, { toast, switchView, loadNaverSdk, openSheet, setBusy,
  resetNaverSdk(){state.naverSdkPromise=null;},
  async changeLocation(point) {
    state.refreshController?.abort();++state.refreshToken;
    state.location=point;state.route=point.id;state.data=null;state.usingCachedData=false;
    clearMapOverlays();state.radarOverlay?.setMap(null);++state.radarLoadToken;
    state.radarFrames=[];$('#mapStamp').textContent='';
    if(state.naverMap)state.naverMap.panTo(new naver.maps.LatLng(point.lat,point.lon));
    if(state.view==='weekly'){render();return;}
    await refreshData(false);
  }
});

async function refreshMap() {
  setBusy(true);
  try { state.naverSdkPromise=null;await ensureMap();await startRadarSequence(); }
  finally { if(state.view==='map')setBusy(false); }
}

function selectHorizon(minutes, openMap) {
  state.mapHorizon = minutes; renderTimeline(); renderMapSummary();
  if (openMap) switchView("map");
  else if (state.view === "map") { drawMapOverlays(); startRadarSequence(); }
}

const viewScroll={};
async function switchView(view) {
  viewScroll[state.view]=window.scrollY;state.view=view;
  $$('.mobile-view').forEach(section=>section.classList.toggle('active',section.dataset.view===view));
  $$('.bottom-nav button').forEach(button=>{button.classList.toggle('active',button.dataset.tab===view);if(button.dataset.tab===view)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
  window.scrollTo({top:viewScroll[view]||0,behavior:'auto'});
  if(view==='weekly'){void extras.loadWeekly();extras.syncBusy();}
  else {render();if(!state.loading&&(!state.data||Date.now()>=Date.parse(state.data.expiresAt)))void refreshData(false);}
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
  state.naverMap.panTo(new naver.maps.LatLng(route.lat, route.lon));
  state.overlays.push(new naver.maps.Marker({ map: state.naverMap, position: new naver.maps.LatLng(route.lat, route.lon), icon: { content: `<div class="naver-marker-mobile route">RUN</div>`, anchor: new naver.maps.Point(22, 16) } }));
  for (const camera of state.data.cctvs || []) {
    state.overlays.push(new naver.maps.Marker({ map: state.naverMap, position: new naver.maps.LatLng(camera.lat, camera.lon), title: camera.name, icon: { content: `<div class="naver-marker-mobile">${escapeHtml(camera.sector)}</div>`, anchor: new naver.maps.Point(18, 16) } }));
  }
}

function radarMinutes() {
  const step = state.mapHorizon >= 180 ? 10 : 5;
  const start = Math.max(0, state.mapHorizon - step * 4);
  return Array.from({ length: 5 }, (_, index) => start + index * step);
}

async function transparentRadarFrame(minutes) {
  const response = await fetch(`/api/radar?minutes=${minutes}&snapshot=${encodeURIComponent(state.data?.generatedAt || "")}`);
  if (!response.ok) throw new Error(`레이더 프레임 ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  const raster = state.data?.radar?.raster || { sourceX: 0, sourceY: 20, width: 700, height: 700 };
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
  state.radarFrameIndex = index % state.radarFrames.length;
  const frame = state.radarFrames[state.radarFrameIndex];
  $("#radarFrameLabel").textContent = `T+${String(frame.minutes).padStart(2, "0")}m`;
  $$("#radarDots button").forEach((dot, dotIndex) => dot.classList.toggle("active", dotIndex === state.radarFrameIndex));
  if (!frame.surface) return;
  if (!state.radarOverlay) state.radarOverlay = createRadarOverlay(state.naverMap);
  else if (!state.radarOverlay.getMap()) state.radarOverlay.setMap(state.naverMap);
  state.radarOverlay.setFrame(frame.surface);
}

function syncRadarTimer() {
  clearInterval(state.radarTimer); state.radarTimer = null;
  $("#radarPlay").textContent = state.radarPlaying ? "Ⅱ" : "▶";
  if (state.radarPlaying && state.view === "map" && state.radarFrames.some((frame) => frame.surface)) state.radarTimer = setInterval(() => showRadarFrame((state.radarFrameIndex + 1) % state.radarFrames.length), 1200);
}

async function startRadarSequence() {
  clearInterval(state.radarTimer); state.radarTimer = null;
  if (!state.data?.radar?.configured || !state.naverMap || state.view !== "map") {
    $("#radarState").textContent = state.data?.radar?.configured ? "지도 대기" : "자료 없음";
    state.radarOverlay?.setMap(null); return;
  }
  const blended = state.mapHorizon > 60;
  $("#radarProduct").textContent = state.mapHorizon === 0 ? "현재 관측 강수" : blended ? "기상청 강수 예측" : "단기 비구름 이동 예측";
  $("#radarState").textContent = "불러오는 중";
  const token = ++state.radarLoadToken;
  state.radarFrames = radarMinutes().map((minutes) => ({ minutes, surface: null })); state.radarFrameIndex = 0;
  $("#radarDots").innerHTML = state.radarFrames.map((_, index) => `<button data-radar-index="${index}" aria-label="레이더 프레임 ${index + 1}"></button>`).join("");
  $$("#radarDots button").forEach((button) => button.onclick = () => { showRadarFrame(Number(button.dataset.radarIndex)); syncRadarTimer(); });
  await Promise.all(state.radarFrames.map(async (frame, index) => {
    try { frame.surface = await transparentRadarFrame(frame.minutes); if (token === state.radarLoadToken) { $$("#radarDots button")[index]?.classList.add("loaded"); if (index === 0) showRadarFrame(0); } }
    catch (error) { if (token === state.radarLoadToken) console.warn(error); }
  }));
  if (token !== state.radarLoadToken) return;
  $("#radarState").textContent = state.radarFrames.some((frame) => frame.surface) ? "재생" : "오류";
  showRadarFrame(0); syncRadarTimer();
}

async function analyzeCctv() {
  if (state.analyzing || !state.data) return;
  if (state.runtime.mode === "public" || state.runtime.aiEnabled === false) return toast("노면 CCTV AI 분석은 로컬에서만 사용할 수 있습니다.");
  state.analyzing = true; $("#analyzeBtn").disabled = true; $("#analyzeBtn").textContent = "CCTV 영상 확인 중";
  try {
    const response = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cctvs: state.data.cctvs, forecast: state.data.forecast }) });
    const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "분석 실패");
    const analyzed = new Map(payload.cameras.map((camera) => [camera.id, camera]));
    state.data.cctvs = state.data.cctvs.map((camera) => analyzed.get(camera.id) || camera);
    state.data.decision = payload.decision;
    const nowMode = state.data.runModes?.find((mode) => mode.id === "now");
    if (nowMode) nowMode.decision = payload.decision;
    render(); toast(payload.summary || "노면 CCTV 분석을 마쳤습니다.");
  } catch (error) { toast(error.message); }
  finally { state.analyzing = false; $("#analyzeBtn").textContent = "CCTV로 비·노면 확인"; renderCctv(); }
}

let activeSheet=null, pendingSheetPop=null, resolveSheetPop=null;
const silentSheetCloses=new WeakSet(), sheetFocus=new WeakMap();
async function openSheet(dialog) {
  if(pendingSheetPop)await pendingSheetPop;
  if(dialog.open)return;
  const returnTo=dialog.id==='cctvSheet'?$('#openCctv'):document.activeElement;
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
  resetDecision();
  $("#refreshBtn").onclick = () => state.view === "weekly" ? extras.loadWeekly(true) : state.view === "map" ? refreshMap() : refreshData(true); $("#radarPlay").onclick = () => { state.radarPlaying = !state.radarPlaying; syncRadarTimer(); };
  $("#analyzeBtn").onclick = analyzeCctv; $("#settingsBtn").onclick = openSettings; $("#closeSettings").onclick = closeSettings;
  $('#moreBtn').onclick=()=>{const hidden=!$('#moreMenu').hidden;$('#moreMenu').hidden=hidden;$('#moreBtn').setAttribute('aria-expanded',String(!hidden));};
  $('#settingsBtn').onclick=()=>{$('#moreMenu').hidden=true;$('#moreBtn').setAttribute('aria-expanded','false');openSettings();};
  $('#openEvidence').onclick=()=>openSheet($('#evidenceSheet'));
  $('#openCctv').onclick=()=>openSheet($('#cctvSheet'));
  $('#evidenceCctv').onclick=async()=>{await switchView('map');await openSheet($('#cctvSheet'));};
  $$('[data-close-sheet]').forEach(button=>button.onclick=()=>button.closest('dialog').close());
  $$('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const bounds=dialog.getBoundingClientRect();if(event.clientY<bounds.top||event.clientX<bounds.left||event.clientX>bounds.right)dialog.close();}}));
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){$('#moreMenu').hidden=true;$('#moreBtn').setAttribute('aria-expanded','false');}});
  try {
    const config = await fetch("/api/config").then((response) => response.json());
    state.runtime = { ...state.runtime, ...(config.runtime || {}) };
    state.keys = { naverKey: config.keys?.naverKey || "" };
    state.configured = config.configured || {};
    renderConnectionStatus();
    if (state.runtime.mode === "public") $("#settingsIntro").textContent = "공개 배포 모드입니다. 비밀 키와 AI 기능은 서버 안에서만 관리됩니다.";
  } catch { renderConnectionStatus(); }
  try {
    state.codex = await fetch("/api/status").then((response) => response.json());
    if (state.codex.runtimeMode) state.runtime = { ...state.runtime, mode: state.codex.runtimeMode, aiEnabled: state.codex.aiEnabled };
  } catch { state.codex = { codex: false }; }
  await refreshData(false);
  const refreshVisible = () => {
    if (document.visibilityState !== 'visible') return;
    if (state.view === 'weekly') { extras.loadWeekly(); return; }
    if (!state.loading && (!state.data || Date.now() >= Date.parse(state.data.expiresAt || 0))) void refreshData(false);
  };
  document.addEventListener('visibilitychange', refreshVisible);
  window.addEventListener('online', refreshVisible);
  setInterval(refreshVisible, 60000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
}

boot();
