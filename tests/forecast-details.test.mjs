import test from 'node:test';
import assert from 'node:assert/strict';
import { renderForecastDetails } from '../assets/forecast-details.mjs';
import { evaluateRunWindow } from '../assets/weather-domain.mjs';

function fixture() {
  const samples = ['출발','30분','복귀'].map((phase, index) => ({
    phase, at:new Date(Date.parse('2026-11-07T10:20:00+09:00') + index*1800000).toISOString(),
    source:'ultra', sourceTime:index ? '2026-11-07T11:00:00+09:00' : '2026-11-07T10:00:00+09:00',
    issuedAt:'2026-11-07T09:30:00+09:00', sourceFetchedAt:'2026-11-07T09:47:00+09:00',
    probability:20 + index*20, mm:3, amountText:'3.0mm', precipitationType:2, villageMm:0.5, villagePrecipitationType:3, probabilityAmountText:'1mm 미만',
    probabilityMeta:{sourceTime:'2026-11-07T11:00:00+09:00',issuedAt:'2026-11-07T08:00:00+09:00',fetchedAt:'2026-11-07T09:46:00+09:00'},
    multiModel:{validAt:'2026-11-07T11:00:00+09:00',fetchedAt:'2026-11-07T09:48:00+09:00',models:[
      {id:'ecmwf',label:'ECMWF',probability:10 + index*10,amount:0.1,nextProbability:100,nextAmount:9},
      {id:'gfs',label:'GFS',probability:null,amount:0.3,nextProbability:100,nextAmount:9},
    ]},
  }));
  return {mode:{immediate:true,departureAt:samples[0].at,endAt:samples[2].at,samples},
    thermal:{status:'ready',data:{fetchedAt:'2026-11-07T09:45:00+09:00',hourly:[
      {time:'2026-11-07T10:00:00+09:00',temperature:9.6,feelsLike:7.3,windSpeed:2.1,gusts:4.2,humidity:65},
      {time:'2026-11-07T11:00:00+09:00',temperature:10.4,feelsLike:8.2,windSpeed:3.1,gusts:5.2,humidity:60},
      {time:'2026-11-07T12:00:00+09:00',temperature:11.4,feelsLike:9.2,windSpeed:9.1},
    ]}}, recent:{observations:[{observedAt:'2026-11-07T09:00:00+09:00',rainMm:0}]}};
}
const section = (html, title) => html.slice(html.indexOf(`<h3>${title}`), html.indexOf('</section>',html.indexOf(`<h3>${title}`)));
const source = (html, title) => {
  const start = html.indexOf(`>${title}</a>`);
  return html.slice(start, html.indexOf('</section>',start));
};

test('provider amounts retain their wording and each source keeps its own times', () => {
  const html = renderForecastDetails(fixture());
  const village = source(html,'눈·비: 기상청 단기예보');
  const ultra = source(html,'눈·비: 기상청 초단기예보');
  assert.ok(village.includes('1mm 미만'));
  assert.match(village, /<th scope="row">강수형태<\/th><td>눈<\/td>/);
  assert.ok(!village.includes('3.0mm'));
  assert.ok(village.includes('발표 11/07 08:00 · 수신 11/07 09:46'));
  assert.ok(ultra.includes('3.0mm'));
  assert.match(ultra, /<th scope="row">강수형태<\/th><td>비·눈<\/td>/);
  assert.ok(!ultra.includes('1mm 미만'));
  assert.ok(ultra.includes('발표 11/07 09:30 · 수신 11/07 09:47'));
  assert.match(html, /<th scope="col">출발<small>10:20/);
  assert.match(html, /<th scope="col">30분 후<small>10:50/);
  assert.match(html, /<th scope="col">복귀<small>11:20/);
});

test('thermal details use the same hour bucket as the hero, while raw decimals remain visible', () => {
  const html = source(renderForecastDetails(fixture()),'기온·바람: Open-Meteo');
  assert.match(html, /<th scope="row">기온<\/th><td>9.6°C<\/td><td>9.6°C<\/td><td>10.4°C<\/td>/);
  assert.ok(html.includes('4.2m/s'));
  assert.ok(!html.includes('11.4°C'));
  assert.ok(html.includes('수신 11/07 09:45'));
  assert.ok(!html.includes('발표 11/07 09:45'));
});

test('model comparison includes models present only at return and never substitutes next-hour values', () => {
  const data = fixture();
  data.mode.samples[2].multiModel.models.push({id:'jma',label:'JMA',probability:77,amount:0.4});
  const html = source(renderForecastDetails(data),'비교 예보: Open-Meteo');
  assert.ok(html.includes('77%'));
  assert.ok(html.includes('JMA'));
  assert.ok(!html.includes('100%'));
  assert.ok(!html.includes('9mm'));
  assert.ok(html.includes('<span class="forecast-probability">—</span><small>0.3mm</small>'));
  assert.ok(html.includes('모델 발표 시각은 제공되지 않아요.'));
});

test('displayed accumulation formula agrees with the shared evaluator', () => {
  const data = fixture();
  data.mode.samples.forEach((sample, i) => { sample.villageMm=[0,1,4][i];sample.multiModel.models=[]; });
  const html = section(renderForecastDetails(data),'화면 수치 계산');
  const evaluated = evaluateRunWindow(data.mode.samples,[],{requireSamples:3});
  assert.equal(evaluated.summary.estimatedAmount,1.5);
  assert.ok(html.includes(`0 × 0.25 + 1 × 0.5 + 4 × 0.25 = ${evaluated.summary.estimatedAmount}mm`));
  assert.ok(html.includes('5% 단위로 반올림'));
  assert.ok(html.includes('0.5mm로 처리'));
});

test('missing or unsupported values are not shown as zero, and incomplete runs have no formula', () => {
  const data = fixture();
  data.mode.samples[1]={phase:'30분',source:'village',unavailable:true,mm:0,amountText:'0 mm',sourceTime:null};
  data.mode.samples[0].villageMm=null;
  data.mode.samples[0].probabilityAmountText='0 mm';
  data.mode.samples[0].probability=null;
  data.mode.samples[0].probabilityMeta={issuedAt:'invalid',sourceTime:'invalid',fetchedAt:'invalid'};
  data.thermal={status:'loading'};
  const html = renderForecastDetails(data);
  const village = source(html,'눈·비: 기상청 단기예보');
  assert.match(village, /<th scope="row">1시간 강수량<\/th><td>—<\/td><td>—<\/td><td>1mm 미만<\/td>/);
  assert.ok(!html.includes('forecast-formula'));
  assert.ok(!html.includes('Invalid Date'));
  assert.ok(!html.includes('NaN'));
  assert.ok(html.includes('기온 자료를 불러오는 중'));
  assert.doesNotThrow(() => renderForecastDetails());
});

test('village fallback uses its own provenance, partial values survive, and stale receipt time stays intact', () => {
  const data = fixture();
  const sample = data.mode.samples[0];
  Object.assign(sample,{source:'village',issuedAt:'2026-11-07T08:00:00+09:00',sourceFetchedAt:'2026-11-07T08:12:00+09:00',sourceStale:true,mm:null,unavailable:true,probability:0});
  data.cached=true;
  const html=renderForecastDetails(data);
  const village=source(html,'눈·비: 기상청 단기예보');
  assert.ok(village.includes('출발: 발표 11/07 08:00 · 수신 11/07 08:12 · 갱신 지연'));
  assert.match(village, /<th scope="row">강수확률<\/th><td>0%<\/td>/);
  assert.match(village, /<th scope="row">1시간 강수량<\/th><td>—<\/td>/);
  assert.ok(html.includes('저장된 자료를 보고 있어요'));
  assert.ok(!html.includes('forecast-formula'));
});

test('external model labels and provider text are escaped; recent observations belong to immediate runs', () => {
  const data = fixture();
  data.mode.samples[0].multiModel.models[0].label='<img src=x onerror=alert(1)>';
  data.mode.samples[0].probabilityAmountText='<script>alert(1)</script>';
  let html=renderForecastDetails(data);
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('11/07 09:00 관측 · 1시간 강수량 0mm'));
  data.mode.immediate=false;
  html=renderForecastDetails(data);
  assert.ok(!html.includes('09:00 관측'));
  assert.ok(!html.includes('<b>노면 추정</b>'));
});
