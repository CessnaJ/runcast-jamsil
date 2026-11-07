import test from 'node:test';
import assert from 'node:assert/strict';
import {recommendRunningWear, runningIntervals} from '../assets/weather-domain.mjs';

const startTime='2026-11-07T23:00:00+09:00';
const endTime='2026-11-08T00:00:00+09:00';
const samples=(temperature, end={})=>[
  {time:startTime,feelsLike:temperature,windSpeed:0,gusts:0,precipitation:0},
  {time:endTime,feelsLike:temperature,windSpeed:0,gusts:0,precipitation:0,...end},
];
const wear=(temperature, comfort='normal', fit='pants', end={})=>recommendRunningWear(samples(temperature,end),startTime,comfort,false,fit);

test('outfit switches at exact lower-inclusive boundaries without two-degree rounding',()=>{
  const cases=[
    [-10,'기모 긴팔','기모 러닝팬츠','보온 양말'],
    [-5,'기모 긴팔','얇은 기모 러닝팬츠','보온 양말'],
    [0,'약간 두툼한 긴팔','약간 두툼한 긴 러닝팬츠','두툼한 양말'],
    [4,'얇은 긴팔','얇은 긴 러닝팬츠','일반 양말'],
    [8,'얇은 긴팔','얇은 긴 러닝팬츠','일반 양말'],
    [12,'얇은 긴팔','반바지','일반 양말'],
    [15,'얇은 반팔','반바지','일반 양말'],
    [18,'얇은 반팔','반바지','얇은 양말'],
    [24,'통기성 좋은 아주 얇은 반팔','얇은 반바지','얇은 양말'],
  ];
  for (const [temperature,top,bottom,socks] of cases) {
    const result=wear(temperature);
    assert.equal(result.status,'recommended');
    assert.deepEqual([result.top,result.bottom,result.socks],[top,bottom,socks],`${temperature}°`);
  }
  assert.equal(wear(-5.01).bottom,'기모 러닝팬츠');
  assert.equal(wear(-0.01).top,'기모 긴팔');
  assert.equal(wear(3.99).top,'약간 두툼한 긴팔');
  assert.match(wear(7.99).accessories,/장갑/);
  assert.equal(wear(8).accessories,'');
  assert.equal(wear(11.99).bottom,'얇은 긴 러닝팬츠');
  assert.equal(wear(14.99).top,'얇은 긴팔');
  assert.equal(wear(17.99).socks,'일반 양말');
  assert.equal(wear(23.99).bottom,'반바지');
});

test('comfort changes classification only, and lower return temperature drives the outfit',()=>{
  const data=samples(9,{feelsLike:7});
  const normal=recommendRunningWear(data,startTime);
  const cold=recommendRunningWear(data,startTime,'cold');
  const hot=recommendRunningWear(data,startTime,'hot');
  for (const result of [normal,cold,hot]) assert.deepEqual([result.low,result.high],[7,9]);
  assert.deepEqual([normal.adjusted,cold.adjusted,hot.adjusted],[7,5,9]);
  assert.equal(hot.accessories,'');assert.match(cold.accessories,/장갑/);
  assert.equal(wear(13,'cold').bottom,'얇은 긴 러닝팬츠');
  assert.equal(wear(13,'hot').top,'얇은 반팔');
});

test('pants and tights preserve warmth while shorts are independent of fit preference',()=>{
  for (const [temperature,expected] of [[-8,'기모 긴 타이즈'],[-2,'얇은 기모 긴 타이즈'],[2,'약간 두툼한 긴 타이즈'],[6,'얇은 긴 타이즈'],[10,'얇은 긴 타이즈']]) {
    const pants=wear(temperature), tights=wear(temperature,'normal','tights');
    assert.equal(tights.bottom,expected);
    assert.deepEqual({...pants,bottom:tights.bottom},tights);
  }
  assert.equal(wear(12,'normal','tights').bottom,'반바지');
  assert.equal(wear(24,'normal','tights').bottom,'얇은 반바지');
  assert.equal(wear(2,'normal','invalid').bottom,'약간 두툼한 긴 러닝팬츠');
});

test('wind layers use either endpoint wind or interval gust without changing temperature or duplicating shells',()=>{
  assert.equal(wear(6,'normal','pants',{windSpeed:3.99,gusts:7.99}).outer,'');
  for (const end of [{windSpeed:4},{gusts:8}]) {
    const result=wear(6,'normal','pants',end);
    assert.equal(result.outer,'얇은 바람막이');assert.equal(result.adjusted,6);
    assert.equal(result.top,wear(6).top);
  }
  const data=samples(6);data[0].windSpeed=4;
  assert.equal(recommendRunningWear(data,startTime).outer,'얇은 바람막이');
  assert.equal(wear(-2,'normal','pants',{windSpeed:4}).outer,'보통 두께 방풍재킷');
  assert.equal(wear(-8,'normal','pants',{gusts:20}).outer,'통기성 있는 방풍 재킷');
  assert.equal(wear(12,'normal','pants',{windSpeed:4}).outer,'');
});

test('rain replaces the cold shell, keeps warmth level, and offers an optional shell in warm weather',()=>{
  const wet=wear(2,'normal','pants',{precipitation:.1,windSpeed:4});
  assert.equal(wet.outer,'통기성 있는 방수 러닝 재킷');
  assert.equal(wet.top,wear(2).top);assert.equal(wet.bottom,wear(2).bottom);
  assert.match(wet.notes.join(' '),/갈아입을 옷/);
  const warm=wear(24,'normal','pants',{precipitation:1});
  assert.equal(warm.outer,'');assert.match(warm.notes.join(' '),/필요하면.*방수/);
});

test('unsupported cold explains the missing outfit and cannot be bypassed by hot preference',()=>{
  for (const [temperature,comfort] of [[-10.01,'normal'],[-11,'hot'],[-9,'cold']]) {
    const result=wear(temperature,comfort);
    assert.equal(result.status,'outside-range');
    assert.equal(result.top,'');assert.equal(result.bottom,'');
    assert.match(result.notes.join(' '),/개인별 방한 준비/);
  }
  assert.equal(wear(-10).status,'recommended');
  assert.match(wear(-8).accessories,/패딩 조끼/);
  assert.match(wear(-2).accessories,/패딩 조끼/);
  assert.doesNotMatch(wear(-8).notes.join(' '),/보온조끼/);
});

test('missing return-hour data stays unavailable and normalized intervals give the same outfit',()=>{
  for (const feelsLike of [null,undefined,NaN,'0']) assert.equal(wear(2,'normal','pants',{feelsLike}),null);
  assert.equal(recommendRunningWear(samples(2).slice(0,1),startTime),null);
  const data=samples(2,{feelsLike:1,windSpeed:4,precipitation:.1});
  assert.deepEqual(recommendRunningWear(data,startTime,'normal',false,'tights'),recommendRunningWear(runningIntervals(data),startTime,'normal',true,'tights'));
});

test('saved fit restores locally and malformed preferences fall back to pants',async()=>{
  try {
    for (const [savedFit,expected] of [['tights','tights'],['pants','pants'],['invalid','pants'],[null,'pants']]) {
      globalThis.localStorage={getItem:()=>JSON.stringify({comfort:'cold',bottomFit:savedFit})};
      const {preferences}=await import(`../assets/mobile-extra.js?fit-test=${savedFit}`);
      assert.equal(preferences.bottomFit,expected);assert.equal(preferences.comfort,'cold');
    }
  } finally { delete globalThis.localStorage; }
});
