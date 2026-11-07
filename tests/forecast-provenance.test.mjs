import test from 'node:test';
import assert from 'node:assert/strict';

process.env.VERCEL='1';
process.env.KMA_SERVICE_KEY='forecast-provenance-fixture';
const { requestHandler, resetRawCacheForTest }=await import('../server.mjs');

async function forecast() {
  let status,body;
  await requestHandler({url:'/api/mobile-forecast',method:'POST',headers:{},
    async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({route:'seokchon'}));}},
  {writeHead(value){status=value;},end(value){body=JSON.parse(value);}});
  assert.equal(status,200);
  return body;
}

test('API preserves each provider receipt on fresh cache hits and stale fallback without extra requests',async t=>{
  resetRawCacheForTest();
  let clock=Date.now(), fail=false, calls=0;
  t.mock.method(Date,'now',()=>clock);
  const hour=Math.floor(clock/3600000)*3600000;
  const times=Array.from({length:52},(_,i)=>new Date(hour+(i-3)*3600000+9*3600000).toISOString().slice(0,16));
  t.mock.method(globalThis,'fetch',async input=>{
    calls++;
    if(fail)return new Response('{}',{status:503});
    const url=new URL(input);
    if(url.hostname==='api.open-meteo.com'){
      const hourly={time:times};
      for(const model of ['kma_seamless','ecmwf_ifs025','gfs_seamless','jma_seamless','icon_seamless']){
        hourly[`precipitation_probability_${model}`]=times.map(()=>15);
        hourly[`precipitation_${model}`]=times.map(()=>0.2);
      }
      return new Response(JSON.stringify({hourly}));
    }
    assert.equal(url.hostname,'apis.data.go.kr');
    let item;
    if(url.pathname.endsWith('getUltraSrtNcst')){
      item=Object.entries({RN1:'0',T1H:'10',REH:'65',WSD:'2'}).map(([category,obsrValue])=>({category,obsrValue}));
    } else {
      const values=url.pathname.endsWith('getVilageFcst')
        ? {PTY:'0',PCP:'1mm 미만',POP:'20',TMP:'10',REH:'65',WSD:'2'}
        : {PTY:'0',RN1:'2.0mm',T1H:'10',REH:'65',WSD:'2'};
      item=times.flatMap(time=>Object.entries(values).map(([category,fcstValue])=>({
        category,fcstValue,fcstDate:time.slice(0,10).replaceAll('-',''),fcstTime:time.slice(11,16).replace(':',''),
      })));
    }
    return new Response(JSON.stringify({response:{header:{resultCode:'00'},body:{items:{item}}}}));
  });
  const first=await forecast(), sample=first.runModes.find(mode=>mode.id==='now').samples[0];
  assert.equal(sample.source,'ultra');
  assert.equal(sample.amountText,'2.0mm');
  assert.equal(sample.probabilityAmountText,'1mm 미만');
  assert.equal(sample.villagePrecipitationType,0);
  assert.notEqual(sample.issuedAt,sample.probabilityMeta.issuedAt);
  for(const [dataset,meta] of [
    ['ultra-srt-fcst',{issuedAt:sample.issuedAt,fetchedAt:sample.sourceFetchedAt}],
    ['village-fcst',sample.probabilityMeta],
    ['forecast',sample.multiModel],
  ]){
    const event=first.cacheDiagnostics.events.find(entry=>entry.dataset===dataset&&entry.state==='stored');
    assert.ok(event);
    assert.equal(meta.fetchedAt,event.fetchedAt);
    if(dataset!=='forecast')assert.equal(meta.issuedAt,event.sourceIssuedAt);
  }
  const firstCalls=calls;
  clock+=60000;
  const second=await forecast(), cached=second.runModes.find(mode=>mode.id==='now').samples[0];
  assert.equal(calls,firstCalls);
  assert.equal(cached.sourceFetchedAt,sample.sourceFetchedAt);
  assert.equal(cached.probabilityMeta.fetchedAt,sample.probabilityMeta.fetchedAt);
  assert.equal(cached.multiModel.fetchedAt,sample.multiModel.fetchedAt);

  clock+=5*60000;fail=true;
  const third=await forecast(), stale=third.runModes.find(mode=>mode.id==='now').samples[0];
  assert.ok(calls>firstCalls);
  assert.equal(stale.sourceStale,true);
  assert.equal(stale.probabilityMeta.stale,true);
  assert.equal(stale.multiModel.stale,true);
  assert.equal(stale.sourceFetchedAt,sample.sourceFetchedAt);
  assert.equal(stale.probabilityMeta.fetchedAt,sample.probabilityMeta.fetchedAt);
  assert.equal(stale.multiModel.fetchedAt,sample.multiModel.fetchedAt);
  assert.equal(third.refresh.stale,true);
});

test('forecast details module is served for the web and PWA app shell',async()=>{
  let status,headers,body;
  await requestHandler({url:'/assets/forecast-details.mjs',method:'GET',headers:{}},
    {writeHead(s,h){status=s;headers=h;},end(value){body=String(value);}});
  assert.equal(status,200);
  assert.match(headers['Content-Type'],/text\/javascript/);
  assert.match(body,/export function renderForecastDetails/);
});
