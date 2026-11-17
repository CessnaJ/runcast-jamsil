import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendRunningWear } from '../assets/weather-domain.mjs';
import { renderWearReference } from '../assets/wear-reference.mjs';

const at='2026-11-17T20:00:00+09:00';
const hours=temperature=>[
  {time:at,feelsLike:temperature,windSpeed:0},
  {time:'2026-11-17T21:00:00+09:00',feelsLike:temperature,windSpeed:0,precipitation:0,gusts:0},
];
const selectedRow=html=>html.match(/<tr class="selected-wear-band"[^>]*>(.*?)<\/tr>/s)?.[1];

test('reference highlights the adjusted temperature band at exact boundaries',()=>{
  for(const [temperature,comfort,label] of [[-10,'normal','−10~−5°'],[-5,'normal','−5~0°'],[0,'normal','0~4°'],[4,'normal','4~8°'],[8,'normal','8~12°'],[24,'normal','24° 이상'],[9,'cold','4~8°']]){
    const recommendation=recommendRunningWear(hours(temperature),at,comfort);
    const html=renderWearReference({recommendation});
    assert.equal((html.match(/aria-current="true"/g)||[]).length,1);
    assert.ok(selectedRow(html).includes(label));
    assert.equal((html.match(/<th scope="row">/g)||[]).length,9);
  }
  for(const recommendation of [null,recommendRunningWear(hours(-11),at),recommendRunningWear(hours(-9),at,'cold')]){
    assert.equal(selectedRow(renderWearReference({recommendation})),undefined);
  }
});

test('table shows the shared base outfit while rain can replace the recommendation shell',()=>{
  const data=hours(2);data[1].precipitation=.5;
  const recommendation=recommendRunningWear(data,at);
  assert.equal(recommendation.outer,'통기성 있는 방수 러닝 재킷');
  const row=selectedRow(renderWearReference({recommendation}));
  assert.ok(row.includes('얇은 바람막이'));
  assert.ok(row.includes(recommendation.top));
  assert.ok(row.includes(recommendation.accessories));
  assert.ok(!row.includes(recommendation.outer));
});

test('fit preference changes long bottoms in the table while keeping shorts',()=>{
  const recommendation=recommendRunningWear(hours(2),at,'normal',false,'tights');
  const html=renderWearReference({recommendation,bottomFit:'tights'});
  assert.ok(selectedRow(html).includes(recommendation.bottom));
  assert.ok(!html.includes('러닝팬츠'));
  assert.ok(html.includes('반바지'));
  assert.ok(html.includes('귀 보온밴드'));
  assert.ok(html.includes('보온 장갑(필수)'));
});
