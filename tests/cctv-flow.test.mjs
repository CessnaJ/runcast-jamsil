import test from 'node:test';
import assert from 'node:assert/strict';
import {createCctvBroker} from '../lib/cctv-broker.mjs';
import {loadCctv} from '../assets/cctv-client.mjs';
import {CCTV_POLICY as P,selectCctvRows,validCctvUrl} from '../assets/cctv-domain.mjs';

const point={lat:37.5082,lon:127.1001};
const camera={coordy:37.51,coordx:127.11,cctvname:'테스트 CCTV',cctvurl:'https://cctvsec.ktict.co.kr:8090/test',cctvtype:'3'};
function fixture(){let time=Date.now();const broker=createCctvBroker({apiKey:'test-key',now:()=>time});return {broker,advance:ms=>time+=ms};}
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});

function transport(broker,{rejectUpload=false,itsError=false,onUpload=()=>{}}={}){
  const calls=[];
  return {calls,fetch:async(url,options)=>{
    const path=String(url);calls.push(path.startsWith('https:')?'ITS':path);
    if(path==='/api/cctv/prepare')return json(broker.prepare(point));
    if(path==='/api/cctv/complete'){
      onUpload();
      if(rejectUpload)return new Response('',{status:409});
      return json(broker.complete(point,JSON.parse(options.body)));
    }
    assert.equal(url.hostname,'openapi.its.go.kr');
    assert.equal(options.mode,'cors');assert.equal(options.credentials,'omit');
    assert.equal(options.referrerPolicy,'no-referrer');
    if(itsError)throw new TypeError('Network request failed');
    return json({response:{data:[camera]}});
  }};
}

test('cache miss issues one lease; cache hit returns list without API key; replay is rejected',()=>{
  const {broker}=fixture();const first=broker.prepare(point);
  assert.equal(first.acquisition.request.params.apiKey,'test-key');
  const waiting=broker.prepare(point);assert.equal(waiting.acquisition,null);assert.equal(waiting.cctv.pending,true);
  broker.complete(point,{token:first.acquisition.token,rows:[camera]});
  const hit=broker.prepare(point);assert.equal(hit.cctvs.length,1);assert.equal(hit.acquisition,null);
  assert.ok(!JSON.stringify(hit).includes('test-key'));
  assert.throws(()=>broker.complete(point,{token:first.acquisition.token,rows:[]}),{statusCode:409});
});

test('abandoned leases expire; failures impose cooldown; stale lists have a hard lifetime',()=>{
  const {broker,advance}=fixture();const abandoned=broker.prepare(point);
  advance(P.leaseMs+1);const next=broker.prepare(point);assert.notEqual(next.acquisition.token,abandoned.acquisition.token);
  assert.throws(()=>broker.complete(point,{token:abandoned.acquisition.token,rows:[camera]}),{statusCode:409});
  broker.complete(point,{token:next.acquisition.token,rows:[camera]});
  advance(P.freshMs+1);const refresh=broker.prepare(point);assert.equal(refresh.cctv.stale,true);assert.equal(refresh.cctvs.length,1);
  broker.complete(point,{token:refresh.acquisition.token,failed:true});
  const cooldown=broker.prepare(point);assert.equal(cooldown.acquisition,null);assert.equal(cooldown.cctvs.length,1);
  advance(P.failureMs+1);const expired=broker.prepare(point);assert.equal(expired.cctvs.length,0);assert.ok(expired.acquisition);
});

test('upload validates token, location, camera URL and does not accept weather analysis',()=>{
  const {broker}=fixture();const {token}=broker.prepare(point).acquisition;
  assert.throws(()=>broker.complete({...point,lat:point.lat+0.1},{token,rows:[camera]}),{statusCode:409});
  for(const bad of [{...camera,cctvurl:'http://127.0.0.1/'},{...camera,coordx:0},{...camera,cctvurl:'javascript:alert(1)'}]){
    assert.throws(()=>broker.complete(point,{token,rows:[bad]}),{statusCode:400});
  }
  const stored=broker.complete(point,{token,rows:[{...camera,rainNow:'yes',confidence:1}]});
  assert.equal(stored.cctvs[0].rainNow,'unknown');assert.equal(stored.cctvs[0].confidence,0);
});

test('valid port 8090 is allowed, misleading hosts and credentials are rejected',()=>{
  assert.equal(validCctvUrl(camera.cctvurl),true);
  for(const url of ['https://cctvsec.ktict.co.kr.evil.test/','https://x@cctvsec.ktict.co.kr/','https://cctvsec.ktict.co.kr:1234/'])assert.equal(validCctvUrl(url),false);
  assert.equal(selectCctvRows([camera,camera],point).length,1);
});

test('empty lists are cached and unconfigured server does not issue a request',()=>{
  const {broker}=fixture();const {token}=broker.prepare(point).acquisition;
  broker.complete(point,{token,rows:[]});assert.equal(broker.prepare(point).acquisition,null);
  const empty=createCctvBroker().prepare(point);assert.equal(empty.cctv.configured,false);assert.equal(empty.acquisition,null);
});

test('browser displays ITS result before upload; subsequent call uses BE cache only',async()=>{
  const {broker}=fixture();let shown=false;
  const io=transport(broker,{onUpload:()=>assert.equal(shown,true)});
  const result=await loadCctv({location:point,fetchImpl:io.fetch,onReady:()=>shown=true});
  assert.equal(result.cctvs.length,1);assert.equal(result.acquisition,undefined);
  assert.deepEqual(io.calls,['/api/cctv/prepare','ITS','/api/cctv/complete']);
  io.calls.length=0;await loadCctv({location:point,fetchImpl:io.fetch});
  assert.deepEqual(io.calls,['/api/cctv/prepare']);
});

test('upload reaching another instance cannot erase the successful browser result',async()=>{
  const {broker}=fixture();const io=transport(broker,{rejectUpload:true});let shown=0;
  const result=await loadCctv({location:point,fetchImpl:io.fetch,onReady:data=>shown=data.cctvs.length});
  assert.equal(shown,1);assert.equal(result.cctvs.length,1);assert.equal(result.refresh.failed,false);
});

test('ITS failure reports cooldown and does not trigger an automatic retry loop',async()=>{
  const {broker}=fixture();const io=transport(broker,{itsError:true});
  const failed=await loadCctv({location:point,fetchImpl:io.fetch});assert.equal(failed.refresh.failed,true);assert.ok(failed.refresh.retryAt);
  io.calls.length=0;await loadCctv({location:point,fetchImpl:io.fetch});
  assert.deepEqual(io.calls,['/api/cctv/prepare']);
});

test('lifecycle abort stops acquisition without reporting failure or uploading',async()=>{
  const {broker}=fixture();const controller=new AbortController();let calls=0;
  const fetchImpl=async(url,options)=>{
    calls++;
    if(calls===1)return json(broker.prepare(point));
    controller.abort();throw new DOMException('Aborted','AbortError');
  };
  await assert.rejects(loadCctv({location:point,signal:controller.signal,fetchImpl}),{name:'AbortError'});
  assert.equal(calls,2);
});

test('oversized ITS response is rejected before publication',async()=>{
  const {broker}=fixture();let count=0;let displayed=false;
  const fetchImpl=async()=>{
    count++;
    if(count===1)return json(broker.prepare(point));
    if(count===2)return new Response('x',{headers:{'content-length':String(P.maxResponseBytes+1)}});
    return json({});
  };
  const result=await loadCctv({location:point,fetchImpl,onReady:()=>displayed=true});
  assert.equal(result.refresh.failed,true);assert.equal(displayed,false);assert.equal(count,3);
});
