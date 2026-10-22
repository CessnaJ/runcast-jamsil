import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROUTES, resolveLocation, isSupportedLocation, normalizeWeekly, recommendRunningWear, hourlyBucketEpoch, hourlyPointAt, hourlyTemperatureAt, roundTemperature, evaluateRunWindow } from '../assets/weather-domain.mjs';
process.env.VERCEL='1';
const { assessRunForecast, makeDecision, summarizeRunWindow, cachedRawLoad, resetRawCacheForTest, requestHandler, loadLocalKeys, parseItsCctvResponse } = await import('../server.mjs');

test('local keys load from files with environment precedence; Vercel ignores local files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'runcast-key-test-'));
  try {
    await writeFile(join(root,'.env'),'NAVER_MAP_CLIENT_ID=base-map\nKMA_SERVICE_KEY=base-weather\nKMA_HUB_KEY=base-radar\nITS_API_KEY=base-cctv\n');
    await writeFile(join(root,'.env.local'),'NAVER_MAP_CLIENT_ID="local-map"\nKMA_SERVICE_KEY=local-weather\nKMA_HUB_KEY=\n');
    const environment={KMA_SERVICE_KEY:' process-weather '};
    assert.deepEqual(await loadLocalKeys(root,environment),{naverKey:'local-map',kmaServiceKey:'process-weather',kmaHubKey:'base-radar',itsApiKey:'base-cctv'});
    assert.deepEqual(await loadLocalKeys(root,{...environment,VERCEL:'1'}),{naverKey:'',kmaServiceKey:'process-weather',kmaHubKey:'',itsApiKey:''});
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('key files cannot be served and config exposes only the public map identifier',async()=>{
  for(const url of ['/.env','/.env.local','/api/config']) {
    let status,body;
    await requestHandler({url,method:'GET',headers:{}},{writeHead(s){status=s;},end(b){body=JSON.parse(b);}});
    if(url==='/api/config'){assert.equal(status,200);assert.deepEqual(Object.keys(body.keys),['naverKey']);}
    else assert.equal(status,404);
  }
});

test('installation guide module is served as JavaScript by the local server',async()=>{
  let status,headers,body;
  await requestHandler({url:'/assets/install-guide.mjs',method:'GET',headers:{}},{writeHead(s,h){status=s;headers=h;},end(b){body=String(b);}});
  assert.equal(status,200);
  assert.match(headers['Content-Type'],/text\/javascript/);
  assert.match(body,/export function createInstallGuide/);
});

test('location validates Korean support areas and preserves legacy presets',()=>{
  assert.deepEqual(resolveLocation({route:'olympic'}),ROUTES.olympic);
  for(const p of [{lat:37.55,lon:126.99},{lat:35.1796,lon:129.0756},{lat:33.4996,lon:126.5312},{lat:37.48,lon:130.9},{lat:37.24,lon:131.87}])assert.ok(isSupportedLocation(p.lat,p.lon));
  for(const p of [{lat:35.68,lon:139.69},{lat:0,lon:0},{lat:NaN,lon:127},{lat:39,lon:127},{lat:37,lon:'127'}])assert.throws(()=>resolveLocation({location:p}));
  assert.throws(()=>resolveLocation({route:'unknown'}));
  assert.equal(resolveLocation({location:{lat:37.55,lon:127,name:'내 장소'}}).name,'내 장소');
});
test('missing and sample forecasts can never produce a departure recommendation',()=>{
  for(const item of [{unavailable:true},{source:'demo'}]){
    const runAssessment=assessRunForecast(item,null);
    assert.equal(runAssessment.level,'unknown');
    assert.equal(makeDecision([{...item,minutes:0,runAssessment}]).level,'unknown');
  }
  assert.equal(makeDecision([]).level,'unknown');
  const summary=summarizeRunWindow([{probability:null,runAssessment:{expectedAmount:null,combinedRisk:null}}]);
  assert.equal(summary.estimatedAmount,null);
  assert.equal(summary.officialProbabilityMax,null);
});
test('snow and sleet remain adverse even with trace precipitation',()=>{
  for(const precipitationType of [2,3,6,7]){
    const item={minutes:0,precipitationType,mm:0.1,probability:20};
    const runAssessment=assessRunForecast(item,null);
    assert.equal(runAssessment.snow,true);
    assert.equal(makeDecision([{...item,runAssessment}]).level,'red');
  }
});

test('shared run decision keeps amount, chance, surface and legacy samples consistent',()=>{
  const sample=(mm, probability=0, extra={})=>({mm, probability, ...extra});
  const window=(mm, probability=0, extra={})=>Array.from({length:3},()=>sample(mm, probability, extra));
  const verdict=(samples, cctvs=[])=>evaluateRunWindow(samples,cctvs,{requireSamples:3});
  const cases=[
    [window(0), 'green', 'low'],
    [window(0,80), 'yellow', 'probability'],
    [window(.2), 'green', 'low'],
    [window(.3), 'green', 'light'],
    [window(.9), 'green', 'light'],
    [window(1), 'yellow', 'rain'],
    [window(2.9), 'yellow', 'rain'],
    [window(3), 'red', 'rain_heavy'],
    [window(3,0), 'red', 'rain_heavy'],
    [window(0,0,{precipitationType:2}), 'red', 'snow'],
  ];
  for (const [samples, level, reasonCode] of cases) {
    const result=verdict(samples);
    assert.equal(result.decision.level,level);
    assert.equal(result.decision.reasonCode,reasonCode);
    assert.equal(result.decision.label,result.decision.headline);
  }
  const wet=verdict(window(0,0,{recentConditions:{recentTotalMm:1,recentMaxMm:0}}));
  assert.equal(wet.decision.reasonCode,'surface');
  assert.equal(wet.decision.level,'yellow');
  const disagree=verdict(window(0,0,{multiModel:{models:[{probability:10,amount:0,nextProbability:100,nextAmount:5},{probability:90,amount:0,nextProbability:0,nextAmount:0}]}}));
  assert.equal(disagree.decision.reasonCode,'uncertain');
  const nextHourOnly=verdict(window(0,0,{nextHourMm:5,nextHourProbability:100,multiModel:{models:[{probability:0,amount:0,nextProbability:100,nextAmount:5}]}}));
  assert.equal(nextHourOnly.decision.reasonCode,'low');
  assert.equal(nextHourOnly.decision.level,'green');
  const highModelAtReturn=verdict([
    sample(0,0,{multiModel:{models:[{probability:0,amount:0},{probability:0,amount:0}]}}),
    sample(0,0,{multiModel:{models:[{probability:0,amount:0},{probability:0,amount:0}]}}),
    sample(0,0,{multiModel:{models:[{probability:100,amount:0},{probability:100,amount:0}]}}),
  ]);
  assert.equal(highModelAtReturn.decision.reasonCode,'probability');
  assert.equal(highModelAtReturn.summary.modelProbabilityAverage,100);
  assert.match(highModelAtReturn.decision.reason,/러닝 구간 내 모델 평균 최댓값/);
  const tinyTrace=verdict(window(.001));
  assert.equal(tinyTrace.summary.estimatedAmount,0);
  assert.equal(tinyTrace.decision.reasonCode,'low');
  const previousOutlier=verdict(window(0,0,{multiModel:{previousAmountMedian:0,models:[{probability:0,amount:0,previousAmount:10},{probability:0,amount:0,previousAmount:0}]}}));
  assert.equal(previousOutlier.decision.reasonCode,'low');
  const earlierLightLaterHeavy=verdict([sample(.2),sample(.2),sample(3)]);
  assert.equal(earlierLightLaterHeavy.decision.reasonCode,'rain_heavy');
  const cachedOldLevel=verdict(window(0,0,{runAssessment:{level:'avoid',expectedAmount:0}}));
  assert.equal(cachedOldLevel.decision.reasonCode,'low');
  const recovery=verdict(window(0,0,{previousHourMm:5,recentConditions:{recentTotalMm:8,recentMaxMm:5}}));
  assert.equal(recovery.decision.reasonCode,'surface');
  assert.equal(recovery.decision.level,'yellow');
  const unknown=verdict([{mm:null,probability:0},{mm:0,probability:0},{mm:0,probability:0}]);
  assert.equal(unknown.decision.level,'unknown');
  const demo=verdict(window(0,0,{source:'demo'}));
  assert.equal(demo.decision.level,'unknown');
});

test('shared CCTV rules keep approach rain local and require trusted observations',()=>{
  const samples=Array.from({length:3},()=>({mm:0,probability:0}));
  const camera=(sector,extra={})=>({sector,rainNow:'yes',cameraUsable:true,confidence:.9,roadWet:false,...extra});
  assert.equal(evaluateRunWindow(samples,[camera('남')],{requireSamples:3}).decision.reasonCode,'cctv_rain');
  assert.equal(evaluateRunWindow(samples,[camera('남'),camera('서')],{requireSamples:3}).decision.level,'red');
  assert.equal(evaluateRunWindow(samples,[camera('북'),camera('동')],{requireSamples:3}).decision.reasonCode,'low');
  assert.equal(evaluateRunWindow(samples,[camera('남',{confidence:.5})],{requireSamples:3}).decision.reasonCode,'low');
  const wet=(id)=>({id,rainNow:'no',cameraUsable:true,confidence:.9,roadWet:true});
  assert.equal(evaluateRunWindow(samples,[wet(1),wet(2)],{requireSamples:3}).decision.reasonCode,'surface_cctv');
});
test('weekly data keeps null distinct from zero and contains seven calendar days',()=>{
  const dates=Array.from({length:8},(_,i)=>`2026-09-${12+i}`);
  const data=normalizeWeekly({hourly:{time:['2026-09-12T00:00','2026-09-12T01:00'],temperature_2m:[0,12],precipitation_probability:[null,0],wind_speed_10m:[null,0]},daily:{time:dates,sunrise:dates.map(d=>`${d}T06:20`),sunset:dates.map(d=>`${d}T18:35`)}},ROUTES.seokchon,'2026-09-11T15:00:00Z');
  assert.equal(data.daily.length,7);assert.equal(data.hourly[0].temperature,0);assert.equal(data.hourly[0].probability,null);assert.equal(data.hourly[1].probability,0);assert.equal(data.units.windSpeed,'m/s');
  assert.equal(data.daily[0].sunrise,'2026-09-12T06:20');assert.equal(data.daily[6].sunset,'2026-09-18T18:35');
  assert.equal(data.expiresAt,'2026-09-11T15:30:00.000Z');
});
test('weekly normalization rejects quoted numeric samples instead of coercing them to zero',()=>{
  const data=normalizeWeekly({hourly:{time:['2026-09-12T00:00','2026-09-12T01:00'],temperature_2m:['0',1]},daily:{time:['2026-09-12'],temperature_2m_min:['0'],temperature_2m_max:[1],sunrise:['2026-09-13T06:20'],sunset:['invalid']}},ROUTES.seokchon,'2026-09-11T15:00:00Z');
  assert.equal(data.hourly[0].temperature,null);
  assert.equal(data.daily[0].low,null);
  assert.equal(data.daily[0].high,1);
  assert.equal(data.daily[0].sunrise,null);assert.equal(data.daily[0].sunset,null);
});
test('hourly temperature uses exact local-hour buckets and shared negative rounding',()=>{
  const hourly=[
    {time:'2026-09-18T23:00:00+09:00',temperature:-2.5},
    {time:'2026-09-19T00:00:00+09:00',temperature:0},
    {time:'2026-09-19T06:00:00+09:00',temperature:-1.4},
  ];
  assert.equal(hourlyBucketEpoch('2026-09-19T06:24:00+09:00'),hourlyBucketEpoch('2026-09-19T06:00:00+09:00'));
  assert.equal(hourlyPointAt(hourly,'2026-09-19T06:24:00+09:00')?.temperature,-1.4);
  assert.equal(hourlyTemperatureAt(hourly,'2026-09-19T00:59:00+09:00'),0);
  assert.equal(hourlyTemperatureAt(hourly,'2026-09-19T05:59:00+09:00'),null);
  assert.equal(hourlyTemperatureAt([{time:'2026-09-19T06:00:00+09:00',temperature:null}], '2026-09-19T06:00:00+09:00'),null);
  assert.equal(hourlyTemperatureAt([{time:'2026-09-19T06:00:00+09:00',temperature:'0'}], '2026-09-19T06:00:00+09:00'),null);
  assert.equal(roundTemperature(0),0);
  assert.equal(roundTemperature(-2.5),-3);
  assert.equal(roundTemperature(-1.4),-1);
  assert.equal(roundTemperature(-0.2),0);
  assert.equal(roundTemperature(null),null);
});
const hours=[{time:'2026-09-18T23:00:00+09:00',feelsLike:11.9,windSpeed:3,gusts:5,precipitation:0},{time:'2026-09-19T00:00:00+09:00',feelsLike:12.1,windSpeed:9,gusts:13,precipitation:1}];
test('clothing uses full hour including midnight, has wind note without double subtraction',()=>{
  const normal=recommendRunningWear(hours,hours[0].time);
  assert.equal(normal.windy,true);assert.match(normal.notes.join(' '),/바람막이/);assert.match(normal.notes.join(' '),/비·눈/);
  const calm=recommendRunningWear(hours.map(h=>({...h,windSpeed:0,gusts:0})),hours[0].time);
  assert.equal(normal.top,calm.top);
  assert.notEqual(normal.top,recommendRunningWear(hours,hours[0].time,'cold').top);
  assert.equal(normal.top,recommendRunningWear(hours.map(h=>({...h,feelsLike:h.feelsLike+0.1})),hours[0].time).top);
  assert.equal(recommendRunningWear([hours[0]],hours[0].time),null);
  assert.equal(recommendRunningWear([hours[0],{...hours[1],feelsLike:null}],hours[0].time),null);
});
test('expired raw data revalidates and preserves original update time on failure',async()=>{
  resetRawCacheForTest();const trace=[];
  await cachedRawLoad('v1|test|weather|place|now|test',async()=>({a:1}),{freshMs:-1,staleMs:10000,trace});
  const original=trace.at(-1).fetchedAt;
  const value=await cachedRawLoad('v1|test|weather|place|now|test',async()=>{throw Error('offline');},{trace});
  assert.deepEqual(value,{a:1});assert.equal(trace.at(-1).state,'stale-if-error');assert.equal(trace.at(-1).fetchedAt,original);
});
test('ITS CCTV accepts only known list or explicit zero responses',()=>{
  assert.deepEqual(parseItsCctvResponse('{"response":{"data":[],"datacount":"0"}}'),[]);
  assert.equal(parseItsCctvResponse('{"response":{"data":[{"cctvname":"검증 카메라"}]}}')[0].cctvname,'검증 카메라');
  assert.deepEqual(parseItsCctvResponse('<response><datacount>0</datacount></response>'),[]);
  for(const body of ['<html><title>Unauthorized</title></html>','{"response":{"resultCode":"000","resultMsg":"System error"}}','{"error":"bad gateway"}','{"response":{}}'])assert.throws(()=>parseItsCctvResponse(body),/ITS CCTV/);
});
test('ITS CCTV stale fallback keeps a last known valid list after an invalid upstream response',async()=>{
  resetRawCacheForTest();const trace=[],key='v1|its|cctv-info|fixture|live|strict-parser';
  const list=await cachedRawLoad(key,async()=>parseItsCctvResponse('{"response":{"data":[{"cctvname":"최근 카메라"}]}}'),{freshMs:-1,staleMs:10000,trace});
  const original=trace.at(-1).fetchedAt;
  const stale=await cachedRawLoad(key,async()=>parseItsCctvResponse('<html>upstream error</html>'),{trace});
  assert.deepEqual(stale,list);assert.equal(trace.at(-1).state,'stale-if-error');assert.equal(trace.at(-1).fetchedAt,original);
});
test('API rejects invalid custom coordinates instead of silently returning Jamsil',async()=>{
  const req={url:'/api/weekly-forecast',method:'POST',headers:{},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({location:{lat:0,lon:0}}));}};
  let status,body;const res={writeHead(s){status=s;},end(b){body=JSON.parse(b);}};
  await requestHandler(req,res);assert.equal(status,400);assert.match(body.error,/대한민국/);
});

test('weekly API sends selected coordinates, m/s and return-hour coverage to provider',async()=>{
  resetRawCacheForTest();const nativeFetch=globalThis.fetch;let called;const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  globalThis.fetch=async(url)=>{
    called=new URL(url);
    return new Response(JSON.stringify({hourly:{time:[`${today}T00:00`,`${today}T01:00`],temperature_2m:[20,21]},daily:{time:[today],temperature_2m_min:[20],temperature_2m_max:[21],sunrise:[`${today}T06:20`],sunset:[`${today}T18:35`]}}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  try {
    const req={url:'/api/weekly-forecast',method:'POST',headers:{},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({location:{lat:35.1796,lon:129.0756,name:'부산'}}));}};
    let status,body;const res={writeHead(s){status=s;},end(b){body=JSON.parse(b);}};
    await requestHandler(req,res);assert.equal(status,200);assert.equal(called.searchParams.get('latitude'),'35.1796');assert.equal(called.searchParams.get('longitude'),'129.0756');assert.equal(called.searchParams.get('wind_speed_unit'),'ms');assert.equal(called.searchParams.get('forecast_days'),'8');assert.equal(called.searchParams.get('past_days'),'1');assert.ok(called.searchParams.get('daily').includes('sunrise,sunset'));assert.equal(body.location.name,'부산');assert.equal(body.daily[0].sunrise,`${today}T06:20`);assert.equal(body.daily[0].sunset,`${today}T18:35`);
  } finally {globalThis.fetch=nativeFetch;}
});

test('browser cache retains expired results and excludes legacy samples',async()=>{
  const memory=new Map();globalThis.localStorage={getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v)};
  const {readForecastCache,writeForecastCache,storage}=await import('../assets/mobile-extra.js');
  const result={hourly:[],daily:[],fetchedAt:'2020-01-01T00:00:00Z',expiresAt:'2020-01-01T00:30:00Z'};
  writeForecastCache('weekly','37,127',result);assert.deepEqual(readForecastCache('weekly','37,127'),result);
  writeForecastCache('core','37,127',{...result,demo:true});assert.equal(readForecastCache('core','37,127'),null);
  for(let i=0;i<12;i++)writeForecastCache('weekly',String(i),result);
  assert.equal(Object.keys(storage.read('runcast.cache.weekly.v1')).length,10);
  globalThis.localStorage={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
  assert.equal(readForecastCache('weekly','37,127'),null);assert.equal(storage.write('test',{}),false);
  delete globalThis.localStorage;
});

test('UI intervals align rain probability and gusts to exact return hour',async()=>{
  const {runningIntervals,nextDepartureTime}=await import('../assets/weather-domain.mjs');
  const raw=[{time:'2026-09-19T23:00:00+09:00',temperature:22,feelsLike:24,windSpeed:2,gusts:30,probability:70,precipitation:2},
    {time:'2026-09-20T00:00:00+09:00',temperature:21,feelsLike:25,windSpeed:3,gusts:5,probability:0,precipitation:0.1}];
  const model=runningIntervals(raw);
  assert.equal(model[0].temperature,22);assert.equal(model[0].precipitation,0.1);assert.equal(model[0].probability,0);assert.equal(model[0].gusts,5);
  assert.equal(model[0].endAt,raw[1].time);assert.equal(recommendRunningWear(model,raw[0].time,'normal',true).windy,false);
  assert.equal(model[1].precipitation,null);assert.equal(model[1].endAt,null);
  const gap=runningIntervals([raw[0],{...raw[1],time:'2026-09-20T01:00:00+09:00'}]);assert.equal(gap[0].precipitation,null);assert.equal(gap[0].endAt,null);
  assert.equal(nextDepartureTime(new Date('2026-09-13T14:17:00+09:00')),'2026-09-13T15:00:00+09:00');
  assert.equal(nextDepartureTime(new Date('2026-09-13T23:17:00+09:00')),'2026-09-14T00:00:00+09:00');
});
test('legacy preferences preserve location and comfort while discarding old list field',async()=>{
  const memory=new Map([['runcast.preferences.v1',JSON.stringify({location:{lat:37.55,lon:127,name:'기존 이름'},comfort:'hot',favorites:[ROUTES.seokchon]})]]);
  globalThis.localStorage={getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v)};
  try{const{preferences}=await import('../assets/mobile-extra.js?legacy-test');assert.equal(preferences.location.name,'기존 이름');assert.equal(preferences.comfort,'hot');assert.equal(Object.hasOwn(preferences,'favorites'),false);}
  finally{delete globalThis.localStorage;}
});


function minorRainWindow() {
  return Array.from({length:3},(_,index)=>({
    minutes:1320 + index*30, mm:0, probability:index===2?0:20,
    multiModel:{models:[
      {id:'ecmwf', probability:8, amount:0},
      {id:'gfs', probability:6, amount:index===2?0:0.3},
      {id:'jma', probability:null, amount:0},
      {id:'icon', probability:8, amount:0},
    ]},
  }));
}

test('a single trace-rain model keeps the run green with an explicit explanation',()=>{
  const samples=minorRainWindow();
  const {decision,summary}=evaluateRunWindow(samples,[],{requireSamples:3});
  assert.equal(decision.level,'green');
  assert.equal(decision.reasonCode,'low');
  assert.equal(decision.headline,'눈·비 걱정 적어요');
  assert.equal(decision.reason,'비교 예보 4개 중 1개는 소량의 비를 예상해요.');
  assert.equal(summary.officialProbabilityMax,20);
  assert.equal(summary.estimatedAmount,0);
  assert.equal(summary.disagreement,true); // Preserve the underlying model comparison.
  assert.equal(makeDecision(samples.map((sample,index)=>({...sample,minutes:index*30}))).reason,decision.reason);
  // No disagreement: preserve the original low-rain copy.
  for(const sample of samples)sample.multiModel.models[1].amount=0;
  assert.equal(evaluateRunWindow(samples).decision.reason,'러닝 시간대 눈·비 걱정이 적어요.');
});

test('the minor-rain exception checks the entire run and conservative boundaries',()=>{
  const guards=[
    ['0.5mm',s=>s.multiModel.models[1].amount=0.5],
    ['50 percent',s=>s.multiModel.models[1].probability=50],
    ['two wet models',s=>{s.multiModel.models[0].amount=0.2;s.multiModel.models[1].amount=0.3;}],
    ['official probability above 30',s=>s.probability=31],
    ['official precipitation',s=>s.mm=0.1],
    ['missing official probability',s=>s.probability=null],
    ['missing official amount',s=>s.mm=null],
    ['fewer than four models',s=>s.multiModel.models.pop()],
    ['missing model amount',s=>s.multiModel.models[0].amount=null],
  ];
  for(const [name,change] of guards){
    const samples=minorRainWindow();
    change(samples[2]); // A dry departure must not hide a concerning return.
    assert.equal(evaluateRunWindow(samples).decision.level,'yellow',name);
  }
  const boundary=minorRainWindow();
  for(const sample of boundary){sample.probability=30;sample.multiModel.models[1].amount=0.49;}
  assert.equal(evaluateRunWindow(boundary).decision.level,'green');
});

test('minor model differences cannot override snow, heavy rain, probability or wet surfaces',()=>{
  for(const [change,reason,level] of [
    [s=>s.precipitationType=3,'snow','red'],
    [s=>s.mm=8,'rain_heavy','red'],
    [s=>s.probability=80,'probability','yellow'],
    [s=>s.previousHourMm=1,'surface','yellow'],
  ]){
    const samples=minorRainWindow();change(samples[1]);
    const {decision}=evaluateRunWindow(samples);
    assert.equal(decision.reasonCode,reason);assert.equal(decision.level,level);
  }
});

test('current surface evidence appears only for an immediate run, including expanded details',async()=>{
  const source=await readFile(new URL('../assets/mobile.js',import.meta.url),'utf8');
  const render=source.slice(source.indexOf('function renderEvidence()'),source.indexOf('\nfunction ',source.indexOf('function renderEvidence()')+1));
  for(const immediate of [true,false]){
    const nodes={'#evidenceSummary':{},'#evidenceDetail':{}};
    runInNewContext(`${render}; renderEvidence();`,{
      $:selector=>nodes[selector],escapeHtml:String,extras:{stamp:String},
      state:{location:{},thermal:null},locationKey:()=>'',
      evidenceRows:()=>({mode:{immediate},first:{},models:null,recent:{recentTotalMm:0},surface:{short:'건조 추정'}}),
    });
    assert.equal(nodes['#evidenceSummary'].innerHTML.includes('<b>노면</b>'),immediate);
    assert.equal(nodes['#evidenceSummary'].innerHTML.includes('최근 3시간'),immediate);
    assert.equal(nodes['#evidenceDetail'].innerHTML.includes('<b>노면 추정</b>'),immediate);
    assert.ok(nodes['#evidenceSummary'].innerHTML.includes('다른 예보'));
    assert.ok(nodes['#evidenceDetail'].innerHTML.includes('눈·비: 기상청'));
  }
});
