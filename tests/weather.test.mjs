import test from 'node:test';
import assert from 'node:assert/strict';
import { ROUTES, resolveLocation, isSupportedLocation, normalizeWeekly, recommendRunningWear } from '../assets/weather-domain.mjs';
process.env.VERCEL='1';
const { assessRunForecast, makeDecision, summarizeRunWindow, cachedRawLoad, resetRawCacheForTest, requestHandler } = await import('../server.mjs');

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
test('weekly data keeps null distinct from zero and contains seven calendar days',()=>{
  const data=normalizeWeekly({hourly:{time:['2026-09-12T00:00','2026-09-12T01:00'],temperature_2m:[0,12],precipitation_probability:[null,0],wind_speed_10m:[null,0]},daily:{time:Array.from({length:8},(_,i)=>`2026-09-${12+i}`)}},ROUTES.seokchon,'2026-09-11T15:00:00Z');
  assert.equal(data.daily.length,7);assert.equal(data.hourly[0].temperature,0);assert.equal(data.hourly[0].probability,null);assert.equal(data.hourly[1].probability,0);assert.equal(data.units.windSpeed,'m/s');
  assert.equal(data.expiresAt,'2026-09-11T15:30:00.000Z');
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
test('API rejects invalid custom coordinates instead of silently returning Jamsil',async()=>{
  const req={url:'/api/weekly-forecast',method:'POST',headers:{},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({location:{lat:0,lon:0}}));}};
  let status,body;const res={writeHead(s){status=s;},end(b){body=JSON.parse(b);}};
  await requestHandler(req,res);assert.equal(status,400);assert.match(body.error,/대한민국/);
});

test('weekly API sends selected coordinates, m/s and return-hour coverage to provider',async()=>{
  resetRawCacheForTest();const nativeFetch=globalThis.fetch;let called;
  globalThis.fetch=async(url)=>{
    called=new URL(url);
    return new Response(JSON.stringify({hourly:{time:['2026-09-12T00:00','2026-09-12T01:00'],temperature_2m:[20,21]},daily:{time:['2026-09-12'],temperature_2m_min:[20],temperature_2m_max:[21]}}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  try {
    const req={url:'/api/weekly-forecast',method:'POST',headers:{},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({location:{lat:35.1796,lon:129.0756,name:'부산'}}));}};
    let status,body;const res={writeHead(s){status=s;},end(b){body=JSON.parse(b);}};
    await requestHandler(req,res);assert.equal(status,200);assert.equal(called.searchParams.get('latitude'),'35.1796');assert.equal(called.searchParams.get('longitude'),'129.0756');assert.equal(called.searchParams.get('wind_speed_unit'),'ms');assert.equal(called.searchParams.get('forecast_days'),'8');assert.equal(body.location.name,'부산');
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
