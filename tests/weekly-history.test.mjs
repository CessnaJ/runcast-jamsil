import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {normalizeWeekly,ROUTES,runningIntervals,feelsLikeComparison,kstDay,nextDepartureTime,recommendRunningWear} from '../assets/weather-domain.mjs';

const now=new Date('2026-10-15T12:00:00+09:00');
function payload(){
  const times=Array.from({length:9*24},(_,i)=>new Date(Date.UTC(2026,9,14)+i*3600000).toISOString().slice(0,16));
  const dates=Array.from({length:9},(_,i)=>times[i*24].slice(0,10));
  return {hourly:{time:times,temperature_2m:times.map(()=>15),apparent_temperature:times.map((_,i)=>i<24?14:12),precipitation:times.map((_,i)=>i),precipitation_probability:times.map(()=>20)},daily:{time:dates,temperature_2m_min:dates.map((_,i)=>i),temperature_2m_max:dates.map((_,i)=>10+i),sunrise:dates.map(d=>`${d}T06:30`),sunset:dates.map(d=>`${d}T17:50`)}};
}

test('yesterday is separate from seven forecast days, without losing last return-hour sample',()=>{
  const data=normalizeWeekly(payload(),ROUTES.seokchon,now.toISOString());
  assert.equal(data.baseDate,'2026-10-15');assert.equal(data.schemaVersion,2);
  assert.equal(data.pastDaily.length,1);assert.equal(data.pastDaily[0].date,'2026-10-14');assert.equal(data.pastDaily[0].low,0);
  assert.equal(data.daily.length,7);assert.equal(data.daily[0].date,'2026-10-15');assert.equal(data.daily[0].low,1);assert.equal(data.daily[6].date,'2026-10-21');
  const intervals=runningIntervals(data.hourly);
  for(const day of ['2026-10-14','2026-10-21']){
    const hour=intervals.find(h=>h.time===`${day}T23:00:00+09:00`);
    assert.ok(hour.endAt.endsWith('T00:00:00+09:00'));assert.ok(Number.isFinite(hour.precipitation));
  }
  assert.equal(data.expiresAt,new Date(+now+30*60000).toISOString());
});

test('today comparison uses the same hour and rounded apparent temperature only',()=>{
  const data=normalizeWeekly(payload(),ROUTES.seokchon,now.toISOString());
  const time='2026-10-15T20:00:00+09:00';
  assert.deepEqual(feelsLikeComparison(data.hourly,time,now),{hour:20,delta:-2,referenceLabel:'어제'});
  assert.equal(feelsLikeComparison(data.hourly,'2026-10-14T20:00:00+09:00',now),null);
  assert.deepEqual(feelsLikeComparison(data.hourly,'2026-10-16T20:00:00+09:00',now),{hour:20,delta:0,referenceLabel:'오늘'});
  const previous=data.hourly.find(h=>h.time==='2026-10-14T20:00:00+09:00');previous.feelsLike=null;
  assert.equal(feelsLikeComparison(data.hourly,time,now),null);
  previous.feelsLike=12.1;assert.equal(feelsLikeComparison(data.hourly,time,now).delta,0);
});

test('Korea midnight and year boundary compare yesterday at the exact hour',()=>{
  const at='2027-01-01T00:00:00+09:00';
  const hours=[{time:'2026-12-31T00:00:00+09:00',feelsLike:-1},{time:at,feelsLike:-3}];
  assert.deepEqual(feelsLikeComparison(hours,at,new Date(at)),{hour:0,delta:-2,referenceLabel:'어제'});
});

test('all future days compare with today, not the day before the selected date',()=>{
  const data=normalizeWeekly(payload(),ROUTES.seokchon,now.toISOString());
  data.hourly.find(h=>h.time==='2026-10-15T20:00:00+09:00').feelsLike=10.4;
  data.hourly.find(h=>h.time==='2026-10-16T20:00:00+09:00').feelsLike=13.6;
  data.hourly.find(h=>h.time==='2026-10-20T20:00:00+09:00').feelsLike=21;
  data.hourly.find(h=>h.time==='2026-10-21T20:00:00+09:00').feelsLike=-2.5;
  assert.deepEqual(feelsLikeComparison(data.hourly,'2026-10-16T20:00:00+09:00',now),{hour:20,delta:4,referenceLabel:'오늘'});
  assert.deepEqual(feelsLikeComparison(data.hourly,'2026-10-21T20:00:00+09:00',now),{hour:20,delta:-13,referenceLabel:'오늘'});
  const todayPoint=data.hourly.find(h=>h.time==='2026-10-15T20:00:00+09:00');
  for(const missing of [null,undefined,NaN,'10']){
    todayPoint.feelsLike=missing;
    assert.equal(feelsLikeComparison(data.hourly,'2026-10-16T20:00:00+09:00',now),null);
  }
  todayPoint.feelsLike=10;
  data.hourly.find(h=>h.time==='2026-10-16T20:00:00+09:00').feelsLike=null;
  assert.equal(feelsLikeComparison(data.hourly,'2026-10-16T20:00:00+09:00',now),null);
});

test('future comparison respects Korea midnight across year boundaries and missing hours',()=>{
  const at='2027-01-02T00:00:00+09:00';
  const hours=[{time:'2027-01-01T00:00:00+09:00',feelsLike:0},{time:at,feelsLike:-3}];
  const midnight=new Date('2026-12-31T15:00:00Z');
  assert.deepEqual(feelsLikeComparison(hours,at,midnight),{hour:0,delta:-3,referenceLabel:'오늘'});
  assert.deepEqual(feelsLikeComparison(hours,'2027-01-01T15:00:00Z',midnight),{hour:0,delta:-3,referenceLabel:'오늘'});
  assert.equal(feelsLikeComparison(hours.slice(1),at,midnight),null);
  assert.equal(feelsLikeComparison(hours,'invalid',midnight),null);
  assert.equal(feelsLikeComparison(hours,null,midnight),null);
});

const source=await readFile(new URL('../assets/mobile-extra.js',import.meta.url),'utf8');
const extract=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const wear=extract('  function renderWear()', '  function boot()');
const initial=extract('  function chooseInitial(', '  function renderWeekly()');
function fixedDate(iso){const date=new Date(iso);return class extends Date{constructor(...args){super(...(args.length?args:[+date]));}static now(){return +date;}};}

test('yesterday hides clothing; today renders comparison; missing history omits comparison',()=>{
  const data=normalizeWeekly(payload(),ROUTES.seokchon,now.toISOString());
  const card={hidden:false,innerHTML:'',querySelectorAll:()=>[]};
  const sandbox={Date:fixedDate(now),$:id=>id==='#wearCard'?card:null,selectedDay:'2026-10-14',selectedTime:'2026-10-14T20:00:00+09:00',weekly:data,intervals:runningIntervals(data.hourly),preferences:{comfort:'normal'},kstDay:()=>kstDay(now),recommendRunningWear,feelsLikeComparison:(h,t)=>feelsLikeComparison(h,t,now),temperatureWithUnit:v=>`${v}°`,icon:()=>''};
  runInNewContext(wear+';renderWear();',sandbox);assert.equal(card.hidden,true);assert.equal(card.innerHTML,'');
  sandbox.selectedDay='2026-10-15';sandbox.selectedTime='2026-10-15T20:00:00+09:00';
  runInNewContext('renderWear();',sandbox);assert.equal(card.hidden,false);assert.match(card.innerHTML,/어제 20시보다 체감 2° 낮아요/);
  data.hourly=data.hourly.filter(h=>!h.time.startsWith('2026-10-14'));
  runInNewContext('renderWear();',sandbox);assert.doesNotMatch(card.innerHTML,/wear-comparison/);
});

test('future clothing renders higher, lower and similar comparisons with today',()=>{
  const data=normalizeWeekly(payload(),ROUTES.seokchon,now.toISOString());
  const time='2026-10-17T20:00:00+09:00', selected=data.hourly.find(h=>h.time===time);
  const card={hidden:false,innerHTML:'',querySelectorAll:()=>[]};
  const sandbox={Date:fixedDate(now),$:id=>id==='#wearCard'?card:null,selectedDay:'2026-10-17',selectedTime:time,weekly:data,intervals:runningIntervals(data.hourly),preferences:{comfort:'normal'},kstDay:()=>kstDay(now),recommendRunningWear,feelsLikeComparison:(h,t)=>feelsLikeComparison(h,t,now),temperatureWithUnit:v=>`${v}°`,icon:()=>''};
  runInNewContext(wear,sandbox);
  for(const [feelsLike,copy] of [[15,'오늘 20시보다 체감 3° 높아요'],[9,'오늘 20시보다 체감 3° 낮아요'],[12.1,'오늘 20시와 체감이 비슷해요']]){
    selected.feelsLike=feelsLike;
    runInNewContext('renderWear();',sandbox);
    assert.equal(card.hidden,false);assert.ok(card.innerHTML.includes(copy));
    assert.doesNotMatch(card.innerHTML,/어제 20시/);
  }
  data.hourly=data.hourly.filter(h=>h.time!=='2026-10-15T20:00:00+09:00');
  runInNewContext('renderWear();',sandbox);assert.doesNotMatch(card.innerHTML,/wear-comparison/);
});

test('initial weekly selection remains today, including 23:00',()=>{
  for(const hour of [12,23]){
    const at=new Date(`2026-10-15T${hour}:30:00+09:00`);
    const sandbox={selectedDay:'',selectedTime:'',preferredHour:0,lastDay:'2026-10-15',kstDay:()=>kstDay(at),nextDepartureTime:()=>nextDepartureTime(at),days:[{date:'2026-10-14'},{date:'2026-10-15'},{date:'2026-10-16'}]};
    runInNewContext(initial+';chooseInitial(days);',sandbox);
    assert.equal(sandbox.selectedDay,'2026-10-15');assert.equal(sandbox.preferredHour,hour===23?23:13);
  }
});
