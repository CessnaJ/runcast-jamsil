import { ROUTES, resolveLocation, locationKey, recommendRunningWear, runningIntervals, nextDepartureTime, kstDay, roundTemperature } from './weather-domain.mjs';
import { createRefreshScheduler } from './refresh-scheduler.mjs';
import { icon } from './ui-icons.mjs';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const storage = {
  read(key, fallback = null) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  write(key, value) { try { localStorage.setItem(key,JSON.stringify(value)); return true; } catch { return false; } },
};
const safeLocation = value => { try { return resolveLocation({location:value}); } catch { return null; } };
const saved = storage.read('runcast.preferences.v1', {});
export const preferences = {
  location: safeLocation(saved.location) || ROUTES.seokchon,
  comfort: ['cold','normal','hot'].includes(saved.comfort) ? saved.comfort : 'normal',
};
export function readForecastCache(type,key) {
  const all = storage.read(`runcast.cache.${type}.v1`, {}), value = all?.[key];
  if (!value || typeof value !== 'object' || value.demo || !Number.isFinite(Date.parse(value.expiresAt))) return null;
  if (type === 'core' && (!Array.isArray(value.forecast) || !Array.isArray(value.runModes) || !value.decision)) return null;
  if (type === 'weekly' && (!Array.isArray(value.hourly) || !Array.isArray(value.daily))) return null;
  return value;
}
export function writeForecastCache(type,key,value) {
  const all = storage.read(`runcast.cache.${type}.v1`, {});
  const entries = Object.entries(all && typeof all === 'object' ? all : {}).filter(([k])=>k!==key);
  entries.push([key,value]);
  // Bounded LRU. TTL triggers revalidation; it never deletes the last result.
  storage.write(`runcast.cache.${type}.v1`, Object.fromEntries(entries.slice(-10)));
}
const value = (n,unit='',digits=0) => Number.isFinite(n) ? `${n.toFixed(digits)}${unit}` : '—';
const temperature = n => { const rounded=roundTemperature(n); return rounded == null ? '—' : String(rounded); };
const temperatureWithUnit = n => `${temperature(n)}°`;
const amount = n => !Number.isFinite(n) ? '—' : n===0 ? '0' : Number(n.toFixed(2))===0 ? '<0.01' : String(Number(n.toFixed(2)));
const solarClock = (value, date) => typeof value === 'string' && value.startsWith(`${date}T`) && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value) ? value.slice(11,16) : '—';
function applyRetryMetadata(error, payload, response) {
  const bodyRetry = payload?.refresh?.retryAt || payload?.cache?.retryAt;
  const parsedBodyRetry = typeof bodyRetry === 'number' ? bodyRetry : Date.parse(bodyRetry || '');
  if (Number.isFinite(parsedBodyRetry)) { error.retryAt = parsedBodyRetry; return; }
  const retryAfter = response?.headers?.get?.('Retry-After');
  if (!retryAfter) return;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) error.retryAfterMs = Math.max(0, seconds * 1000);
  else {
    const retryDate = Date.parse(retryAfter);
    if (Number.isFinite(retryDate)) error.retryAt = retryDate;
  }
}
function weather(code) {
  if (code == null) return [icon('question'),'자료 없음'];
  if ([71,73,75,77,85,86].includes(code)) return [icon('snow'),'눈'];
  if (code >=95) return [icon('warning'),'뇌우'];
  if (code >=51) return [icon('rain'),'비'];
  if (code >=45) return [icon('fog'),'안개'];
  return code>=2 ? [icon('cloud'),'흐림'] : [icon('sun'),code===0?'맑음':'구름 조금'];
}
export function createExtras(state, hooks) {
  let weekly=null, weeklyKey='', lastRenderedSelectedTime='', token=0, loading=false, pending=null, intervals=[], weeklyStatus='idle';
  const refreshScheduler=hooks.refreshScheduler || createRefreshScheduler();
  let selectedDay='', selectedTime='', preferredHour=+nextDepartureTime().slice(11,13), showWind=false;
  let pickerMap=null, draft={...state.location}, dialogToken=0, lastDay=kstDay();
  const daySelections = new Map();
  const solarMigrationAttempts = new Set();
  const persist=()=>{if(!storage.write('runcast.preferences.v1',preferences))hooks.toast('저장 공간을 사용할 수 없어 이번 실행에만 적용돼요');};
  const kstDate=date=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(date));
  const stamp=(date,reference=new Date())=>{
    const options={timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hourCycle:'h23'};
    if(kstDate(date)!==kstDate(reference))Object.assign(options,{month:'numeric',day:'numeric'});
    return new Intl.DateTimeFormat('ko-KR',options).format(new Date(date));
  };
  const publishThermal=(status='idle',error=null)=>{weeklyStatus=status;hooks.setThermal?.({key:weeklyKey,status,data:weekly,error});};
  const updateLocationBar=()=>{$('#locationName').textContent=state.location.name;};
  async function selectLocation(point) {
    const previousKey=weeklyKey;
    preferences.location=point;persist();
    if (previousKey) refreshScheduler?.cancel('weekly',previousKey,{intentional:true,reason:'위치 변경'});
    ++token;pending=null;loading=false;weekly=null;weeklyKey='';lastRenderedSelectedTime='';weeklyStatus='idle';selectedDay='';selectedTime='';daySelections.clear();
    publishThermal('idle');
    closePicker();const request=hooks.changeLocation(point);updateLocationBar();renderWeekly();
    if(state.view==='weekly')void loadWeekly();await request;
  }
  function updateDraft(lat,lon,moveMap=false) {
    draft={lat,lon,name:$('#placeName').value.trim()};
    const valid=safeLocation(draft);$('#pickedCoords').textContent=valid?`${lat.toFixed(4)}, ${lon.toFixed(4)}`:'국내 위치를 선택해 주세요.';
    $('#confirmLocation').disabled=!valid;$('#latitudeInput').value=lat.toFixed(4);$('#longitudeInput').value=lon.toFixed(4);
    if(moveMap&&pickerMap)pickerMap.setCenter(new naver.maps.LatLng(lat,lon));
  }
  async function loadPicker() {
    const current=dialogToken;$('#pickerMessage').hidden=false;$('#pickerMessage p').textContent='지도를 준비하고 있어요';$('#retryPicker').hidden=true;
    const ready=await hooks.loadNaverSdk(state.keys.naverKey);
    if(current!==dialogToken||!$('#locationDialog').open)return;
    $('.picker-wrap').classList.toggle('failed',!ready);$('#pickerMessage').hidden=ready;$('.picker-hint').textContent=ready?'지도를 움직여 RUN 표시를 원하는 곳에 맞춰 주세요.':'기본 장소나 좌표로 선택해 주세요.';
    if(!ready){$('#pickerMessage p').textContent='지도를 불러오지 못했어요';$('#retryPicker').hidden=false;$('#locationDetails').open=true;return;}
    if(!pickerMap){
      pickerMap=new naver.maps.Map('locationMap',{center:new naver.maps.LatLng(draft.lat,draft.lon),zoom:14,mapTypeControl:false,zoomControl:true});
      naver.maps.Event.addListener(pickerMap,'click',event=>{$('#placeName').value='';pickerMap.panTo(event.coord);});
      naver.maps.Event.addListener(pickerMap,'dragstart',()=>{$('#placeName').value='';});
      naver.maps.Event.addListener(pickerMap,'idle',()=>{if(!$('#locationDialog').open)return;const center=pickerMap.getCenter();updateDraft(center.lat(),center.lng());});
    }
    naver.maps.Event.trigger(pickerMap,'resize');pickerMap.setCenter(new naver.maps.LatLng(draft.lat,draft.lon));
  }
  async function openPicker() {
    ++dialogToken;draft={...state.location};$('#placeName').value=state.location.name;$('#selectedLocationLabel').textContent=state.location.name;$('#locationDetails').open=false;
    $('#savedPlaces').innerHTML=Object.values(ROUTES).map((p,i)=>`<button data-place="${i}">${esc(p.name)}</button>`).join('');
    $('#savedPlaces').querySelectorAll('button').forEach(b=>b.onclick=()=>selectLocation(Object.values(ROUTES)[+b.dataset.place]));
    hooks.openSheet($('#locationDialog'));updateDraft(draft.lat,draft.lon);await loadPicker();
  }
  function closePicker(){++dialogToken;if($('#locationDialog').open)$('#locationDialog').close();}
  function renderWeeklyStamp() {
    if(!$('#weeklyStamp'))return;
    $('#weeklyStamp').textContent=weekly?`자료 갱신 · 주간 예보 ${stamp(weekly.fetchedAt)}${weeklyStatus==='stale'?' · 이전 자료':''}${weeklyStatus==='loading'?' · 갱신 중':''}`:'';
  }
  async function loadWeekly(force=false) {
    const key=locationKey(state.location);
    if(key!==weeklyKey){++token;pending=null;loading=false;weekly=readForecastCache('weekly',key);weeklyKey=key;publishThermal(weekly?'ready':'idle');renderWeeklyStamp();}
    if(loading&&key===weeklyKey&&pending)return pending;
    if(hooks.canRefresh&&!hooks.canRefresh()){if(weekly){publishThermal(weeklyStatus==='stale'?'stale':'ready');renderWeeklyStamp();}syncBusy();return weekly;}
    const upgradeSolar=weekly?.daily?.some(day=>!Object.hasOwn(day,'sunrise')||!Object.hasOwn(day,'sunset'))&&!solarMigrationAttempts.has(key);
    if(upgradeSolar)solarMigrationAttempts.add(key);
    const fresh=weekly&&!upgradeSolar&&Date.now()<Date.parse(weekly.expiresAt)&&weekly.daily[0]?.date===kstDay();
    const meta=refreshScheduler.getMeta('weekly',key);
    if(!force&&fresh&&(!meta?.nextEligibleAt||Date.now()<meta.nextEligibleAt)){publishThermal('ready');renderWeeklyStamp();syncBusy();return weekly;}
    const requestOptions={manual:force||upgradeSolar,intervalMs:30*60_000,dataAt:weekly?.fetchedAt,expiresAt:weekly?.expiresAt,serverRetryAt:weekly?.refresh?.retryAt||weekly?.cache?.retryAt,fetcher:async({signal})=>{
      const response=await fetch('/api/weekly-forecast',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:state.location}),signal});
      const data=await response.json();if(!response.ok){const error=Error(data.error||'주간 예보 조회 실패');applyRetryMetadata(error,data,response);throw error;}return data;
    }};
    const eligibility=refreshScheduler?.eligibility?.('weekly',key,requestOptions) || {allowed:true,shared:false};
    if(!eligibility.allowed){
      if(weekly){publishThermal(weeklyStatus==='stale'?'stale':'ready');renderWeeklyStamp();}
      else publishThermal('idle');
      syncBusy();
      return weekly;
    }
    if(eligibility.shared&&pending)return pending;
    const current=++token;loading=true;publishThermal('loading');renderWeeklyStamp();if(!weekly||!$('#wearCard'))renderWeekly();syncBusy();
    const request=refreshScheduler?.request('weekly',key,requestOptions);
    pending=(async()=>{
      let outcome=null;
      try{
        outcome=await (request||Promise.resolve({status:'skipped',reason:'no-scheduler'}));
        if(current!==token||key!==locationKey(state.location))return weekly;
        if(outcome.status==='success'){
          weekly=outcome.value;writeForecastCache('weekly',key,weekly);publishThermal(outcome.stale?'stale':'ready');return weekly;
        }
        if(outcome.status==='error'&&outcome.error?.name!=='AbortError'){
          publishThermal(weekly?'stale':'error',outcome.error?.message||'주간 예보 조회 실패');
          if(force)hooks.toast(weekly?'새 자료를 불러오지 못해 이전 자료를 보여드려요':'날씨를 불러오지 못했어요');
        } else if(outcome.status==='skipped') {
          publishThermal(weekly?(weeklyStatus==='stale'?'stale':'ready'):'idle');
        }
        return weekly;
      } finally{
        if(current===token&&key===locationKey(state.location)){
          loading=false;pending=null;
          if(outcome?.status==='skipped')renderWeeklyStamp();else renderWeekly();
          syncBusy();
        }
      }
    })();
    return pending;
  }
  function syncBusy(){if(state.view==='weekly')hooks.setBusy(loading);}
  function chooseInitial(days) {
    const next=nextDepartureTime();
    if(!selectedDay||lastDay!==kstDay()) {selectedDay=days.some(d=>d.date===next.slice(0,10))?next.slice(0,10):days[0]?.date;selectedTime=next;preferredHour=+next.slice(11,13);}
    if(!days.some(d=>d.date===selectedDay)){selectedDay=days[0]?.date;selectedTime='';}
    lastDay=kstDay();
  }
  function renderWeekly() {
    const pageScroll=window.scrollY;const root=$('#weeklyContent'), scroll=$('.hourly-scroll')?.scrollLeft, dayScroll=$('.day-rail')?.scrollLeft;
    const focus=document.activeElement;const focusKey=focus?.dataset.comfort?['comfort',focus.dataset.comfort]:focus?.dataset.hour?['hour',focus.dataset.hour]:focus?.dataset.day?['day',focus.dataset.day]:focus?.id?['id',focus.id]:null;
    const openDetails=[...root.querySelectorAll('details[open]')].map(d=>d.id);
    renderWeeklyStamp();
    if(!weekly){root.innerHTML=`<div class="empty-state" aria-live="polite">${loading?'<span class="loading-orbit"></span><p>날씨를 확인하고 있어요</p>':'<p>날씨를 불러오지 못했어요</p><button id="retryWeekly">다시 시도</button>'}</div>`;$('#retryWeekly')?.addEventListener('click',()=>loadWeekly(true));return;}
    intervals=runningIntervals(weekly.hourly);const days=weekly.daily.slice(0,7);chooseInitial(days);
    const hours=intervals.filter(h=>h.time.startsWith(selectedDay));
    if(!hours.some(h=>h.time===selectedTime))selectedTime=daySelections.get(selectedDay)||hours.find(h=>+h.time.slice(11,13)===preferredHour)?.time||hours[0]?.time;
    if(!hours.some(h=>h.time===selectedTime))selectedTime=hours[0]?.time;
    const solarDay=days.find(day=>day.date===selectedDay), sunrise=solarClock(solarDay?.sunrise,selectedDay), sunset=solarClock(solarDay?.sunset,selectedDay);
    const cells=(fn)=>hours.map(h=>`<td class="${h.time===selectedTime?'selected-hour':''} ${Date.parse(h.time)<Date.now()?'past-hour':''}">${fn(h)}</td>`).join('');
    const row=(label,fn)=>`<tr><th scope="row">${label}</th>${cells(fn)}</tr>`;
    const windRows=showWind?row('체감 °C',h=>temperatureWithUnit(h.feelsLike))+row('풍속 m/s',h=>value(h.windSpeed,'',1))+row('돌풍 m/s',h=>value(h.gusts,'',1)):'';
    root.innerHTML=`<div class="weekly-temp-guide" aria-label="기온 단위">최저 / 최고 °C</div><div class="day-rail" role="group" aria-label="7일 날짜 선택, 숫자는 최저/최고 기온 °C">${days.map(d=>{const[weatherIcon,label]=weather(d.code);const name=d.date===kstDay()?'오늘':new Intl.DateTimeFormat('ko-KR',{weekday:'short',timeZone:'Asia/Seoul'}).format(new Date(d.date+'T12:00:00+09:00'));return `<button class="day-chip ${selectedDay===d.date?'active':''}" data-day="${d.date}" aria-pressed="${selectedDay===d.date}" aria-label="${d.date} ${name}, ${label}, 최저 ${temperatureWithUnit(d.low)} 최고 ${temperatureWithUnit(d.high)}"><b>${name}</b><small>${+d.date.slice(5,7)}/${+d.date.slice(8)}</small><span aria-hidden="true">${weatherIcon}</span><div>${temperature(d.low)}/${temperature(d.high)}</div></button>`;}).join('')}</div>
      <div class="sun-times" role="group" aria-label="${selectedDay} 일출과 일몰"><span aria-label="일출 ${sunrise==='—'?'자료 없음':sunrise}">일출 <b>${sunrise}</b></span><span aria-label="일몰 ${sunset==='—'?'자료 없음':sunset}">일몰 <b>${sunset}</b></span></div>
      <section class="hourly-section"><div id="hourlyScroll" class="hourly-scroll" tabindex="0" role="region" aria-label="출발 시각 선택, 시간별 예보, 가로로 스크롤"><table class="hourly-table"><caption class="sr-only">${selectedDay}. 출발 시각을 선택하세요. 강수는 이후 1시간. 기온과 체감 °C, 강수확률 %, 강수량 mm, 풍속과 돌풍 m/s.</caption><thead><tr><th scope="col">출발</th>${hours.map(h=>`<th scope="col" class="${h.time===selectedTime?'selected-hour':''} ${Date.parse(h.time)<Date.now()?'past-hour':''}"><button data-hour="${h.time}" aria-pressed="${h.time===selectedTime}">${+h.time.slice(11,13)}시</button></th>`).join('')}</tr></thead><tbody>${row('기온 °C',h=>`<b>${temperatureWithUnit(h.temperature)}</b>`)}${row('강수확률',h=>value(h.probability,'%'))}${row('강수량 mm',h=>amount(h.precipitation))}${windRows}</tbody></table></div>
      <div class="table-actions"><details id="forecastInfo"><summary id="forecastInfoSummary" aria-label="예보 시간과 단위 안내">${icon('info')}<span>예보 정보</span>${icon('chevron')}</summary><p>선택한 출발 시각부터 1시간의 강수확률·강수량·돌풍을 보여드려요. 정시 사이의 기온은 해당 시간대 예보를 사용해요. — 자료 없음.</p></details><button id="windToggle" class="text-button" aria-expanded="${showWind}">체감·바람 ${showWind?'접기':'더 보기'} ${icon('chevron')}</button></div></section><section id="wearCard" class="wear-card"></section>`;
    root.querySelectorAll('[data-day]').forEach(b=>b.onclick=()=>{daySelections.set(selectedDay,selectedTime);selectedDay=b.dataset.day;selectedTime=daySelections.get(selectedDay)||'';renderWeekly();root.querySelector(`[data-day="${selectedDay}"]`)?.focus({preventScroll:true});});
    root.querySelectorAll('[data-hour]').forEach(b=>b.onclick=()=>{selectedTime=b.dataset.hour;lastRenderedSelectedTime=selectedTime;preferredHour=+selectedTime.slice(11,13);daySelections.set(selectedDay,selectedTime);const index=hours.findIndex(h=>h.time===selectedTime)+1;root.querySelectorAll('tr').forEach(tr=>[...tr.children].forEach((cell,i)=>cell.classList.toggle('selected-hour',i===index)));root.querySelectorAll('[data-hour]').forEach(btn=>btn.setAttribute('aria-pressed',String(btn===b)));renderWear();});
    $('#windToggle').onclick=()=>{showWind=!showWind;renderWeekly();$('#windToggle').focus({preventScroll:true});};renderWear();
    openDetails.forEach(id=>{if($('#'+id))$('#'+id).open=true;});
    const hourlyNode=$('.hourly-scroll'), selectedHourButton=root.querySelector(`[data-hour="${selectedTime}"]`), selectedIndex=[...root.querySelectorAll('[data-hour]')].findIndex(button=>button.dataset.hour===selectedTime), visible=hourlyNode.clientWidth>0, selectionChanged=lastRenderedSelectedTime!==selectedTime||!visible;
    hourlyNode.scrollLeft=selectionChanged?Math.max(0,selectedIndex*60-60):(scroll??0);
    if(selectionChanged&&selectedHourButton){
      const view=hourlyNode.getBoundingClientRect(), target=selectedHourButton.getBoundingClientRect();
      if(target.left<view.left+88||target.right>view.right)selectedHourButton.scrollIntoView({block:'nearest',inline:'center'});
      requestAnimationFrame(()=>{hourlyNode.scrollLeft=Math.max(0,selectedIndex*60-60);});
    }
    lastRenderedSelectedTime=visible?selectedTime:'';
    $('.day-rail').scrollLeft=dayScroll??0;
    window.scrollTo({top:pageScroll,behavior:'auto'});
    if(focusKey){const[k,v]=focusKey;const target=k==='id'?document.getElementById(v):root.querySelector(`[data-${k}="${v}"]`);target?.focus({preventScroll:true});}
  }
  function renderWear() {
    const card=$('#wearCard');if(!card)return;const wasOpen=$('#comfortDetails')?.open;
    const recommendation=recommendRunningWear(intervals,selectedTime,preferences.comfort,true);const model=intervals.find(h=>h.time===selectedTime);
    const past=Date.parse(selectedTime)<Date.now();const time=`${selectedTime?.slice(11,16)||'—'}–${model?.endAt?.slice(11,16)||'—'}${model?.endAt?.slice(0,10)!==selectedTime?.slice(0,10)&&model?.endAt?' (다음 날)':''}`;
    card.innerHTML=`${past?'<p class="past-note">지난 시간 기준</p>':''}<p class="wear-title">1시간 러닝 옷차림</p><p class="wear-time">${time} · ${recommendation?`체감 ${temperatureWithUnit(recommendation.low)}–${temperatureWithUnit(recommendation.high)}`:'체감 자료 없음'}</p>${recommendation?`<p class="wear-combination">${recommendation.top} · ${recommendation.bottom}</p>${[recommendation.extra,...recommendation.notes].filter(Boolean).filter((n,i,a)=>!n.includes('바람막이')||!a.some((other,j)=>j!==i&&other.includes('바람 강함'))).slice(0,2).map(n=>`<p class="wear-note">${n}</p>`).join('')}`:''}<details id="comfortDetails" class="comfort-details" ${wasOpen?'open':''}><summary id="comfortSummary">내 체감: ${{cold:'추위를 많이 탐',normal:'보통',hot:'더위를 많이 탐'}[preferences.comfort]} ${icon('chevron')}</summary><div class="comfort-options" role="group" aria-label="내 체감">${[['cold','추위를 많이 탐'],['normal','보통'],['hot','더위를 많이 탐']].map(([v,l])=>`<button data-comfort="${v}" aria-pressed="${preferences.comfort===v}">${l}</button>`).join('')}</div><p>가벼운 1시간 러닝 기준이며 바람·습도는 체감온도에 반영돼요. 강풍 안내는 준비물 참고용이고 공식 특보가 아니에요.</p></details>`;
    card.querySelectorAll('[data-comfort]').forEach(b=>b.onclick=()=>{preferences.comfort=b.dataset.comfort;persist();renderWear();$('#comfortDetails').open=true;card.querySelector(`[data-comfort="${preferences.comfort}"]`).focus({preventScroll:true});});
  }
  function boot() {
    updateLocationBar();$('#locationBtn').onclick=openPicker;$('#closeLocation').onclick=closePicker;$('#locationDialog').addEventListener('close',()=>{++dialogToken;});
    $('#retryPicker').onclick=()=>{hooks.resetNaverSdk();void loadPicker();};
    $('#applyCoordinates').onclick=()=>{const lat=Number($('#latitudeInput').value),lon=Number($('#longitudeInput').value);if(!safeLocation({lat,lon})){hooks.toast('국내 위치의 위도·경도를 입력해 주세요');return;}updateDraft(lat,lon,true);};
    $('#confirmLocation').onclick=()=>{const point=safeLocation({...draft,name:$('#placeName').value.trim()||'선택한 위치'});if(point)void selectLocation(point);else hooks.toast('국내 위치를 선택해 주세요');};
    $('#locateMe').onclick=()=>{if(!navigator.geolocation){hooks.toast('이 브라우저에서는 현재 위치를 사용할 수 없어요');return;}const current=dialogToken;$('#locateMe').disabled=true;navigator.geolocation.getCurrentPosition(position=>{$('#locateMe').disabled=false;if(current!==dialogToken||!$('#locationDialog').open)return;const{latitude:lat,longitude:lon}=position.coords;if(!safeLocation({lat,lon})){hooks.toast('국내 위치를 선택해 주세요');return;}$('#placeName').value='현재 위치';updateDraft(lat,lon,true);},()=>{$('#locateMe').disabled=false;if(current===dialogToken)hooks.toast('현재 위치를 확인하지 못했어요. 지도에서 선택할 수 있어요.');},{enableHighAccuracy:false,timeout:10000,maximumAge:60000});};
  }
  return {boot,loadWeekly,stamp,syncBusy,render:renderWeekly};
}
