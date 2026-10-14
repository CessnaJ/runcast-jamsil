import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {normalizeWeekly,ROUTES,runningIntervals,yesterdayFeelsLikeComparison,kstDay,nextDepartureTime,recommendRunningWear} from '../assets/weather-domain.mjs';

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
  assert.deepEqual(yesterdayFeelsLikeComparison(data.hourly,time,now),{hour:20,delta:-2});
  assert.equal(yesterdayFeelsLikeComparison(data.hourly,'2026-10-14T20:00:00+09:00',now),null);
  assert.equal(yesterdayFeelsLikeComparison(data.hourly,'2026-10-16T20:00:00+09:00',now),null);
  const previous=data.hourly.find(h=>h.time==='2026-10-14T20:00:00+09:00');previous.feelsLike=null;
  assert.equal(yesterdayFeelsLikeComparison(data.hourly,time,now),null);
  previous.feelsLike=12.1;assert.equal(yesterdayFeelsLikeComparison(data.hourly,time,now).delta,0);
});

test('Korea midnight and year boundary compare yesterday at the exact hour',()=>{
  const at='2027-01-01T00:00:00+09:00';
  const hours=[{time:'2026-12-31T00:00:00+09:00',feelsLike:-1},{time:at,feelsLike:-3}];
  assert.deepEqual(yesterdayFeelsLikeComparison(hours,at,new Date(at)),{hour:0,delta:-2});
});

const source=await readFile(new URL('../assets/mobile-extra.js',import.meta.url),'utf8');
const extract=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const wear=extract('  function renderWear()', '  function boot()');
const initial=extract('  function chooseInitial(', '  function renderWeekly()');
function fixedDate(iso){const date=new Date(iso);return class extends Date{constructor(...args){super(...(args.length?args:[+date]));}static now(){return +date;}};}

test('yesterday hides clothing; today renders comparison; missing history omits comparison',()=>{
  const data=normalizeWeekly(payload(),ROUTES.seokchon,now.toISOString());
  const card={hidden:false,innerHTML:'',querySelectorAll:()=>[]};
  const sandbox={Date:fixedDate(now),$:id=>id==='#wearCard'?card:null,selectedDay:'2026-10-14',selectedTime:'2026-10-14T20:00:00+09:00',weekly:data,intervals:runningIntervals(data.hourly),preferences:{comfort:'normal'},kstDay:()=>kstDay(now),recommendRunningWear,yesterdayFeelsLikeComparison:(h,t)=>yesterdayFeelsLikeComparison(h,t,now),temperatureWithUnit:v=>`${v}°`,icon:()=>''};
  runInNewContext(wear+';renderWear();',sandbox);assert.equal(card.hidden,true);assert.equal(card.innerHTML,'');
  sandbox.selectedDay='2026-10-15';sandbox.selectedTime='2026-10-15T20:00:00+09:00';
  runInNewContext('renderWear();',sandbox);assert.equal(card.hidden,false);assert.match(card.innerHTML,/어제 20시보다 체감 2° 낮아요/);
  data.hourly=data.hourly.filter(h=>!h.time.startsWith('2026-10-14'));
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
