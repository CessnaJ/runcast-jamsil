import {randomUUID} from 'node:crypto';
import {CCTV_POLICY as P,cctvBounds,cctvResult,selectCctvRows} from '../assets/cctv-domain.mjs';

// Instance-local, bounded, best-effort cache. A different Vercel instance may
// miss both data and leases; the browser must still retain its successful list.
export function createCctvBroker({apiKey='',now=Date.now,onCameras=()=>{}}={}) {
  const records=new Map();
  const keyFor=point=>`${point.lat.toFixed(6)},${point.lon.toFixed(6)}`;
  function record(point) {
    const time=now(),key=keyFor(point);
    for(const [id,value] of records)if(value.touchedAt+120_000<time)records.delete(id);
    let value=records.get(key)||{};
    records.delete(key);records.set(key,value);value.touchedAt=time;
    while(records.size>120)records.delete(records.keys().next().value);
    return value;
  }
  function result(point,value,extra={}) {
    const entry=value.entry && value.entry.fetchedAt+P.staleMs>now()?value.entry:null;
    const output=cctvResult(entry?.rows||[],point,{configured:Boolean(apiKey),
      fetchedAt:entry?new Date(entry.fetchedAt).toISOString():null,
      stale:Boolean(entry && entry.fetchedAt+P.freshMs<=now()),...extra});
    onCameras(output.cctvs);
    return output;
  }
  return {
    prepare(point) {
      const value=record(point),time=now();
      if(!apiKey)return {...result(point,value),acquisition:null};
      if(value.entry && value.entry.fetchedAt+P.freshMs>time)return {...result(point,value),acquisition:null};
      const retryAt=Math.max(value.retryAt||0,value.lease?.expiresAt||0);
      if(retryAt>time)return {...result(point,value,{retryAt:new Date(retryAt).toISOString(),pending:Boolean(value.lease?.expiresAt>time)}),acquisition:null};
      value.lease={token:randomUUID(),issuedAt:time,expiresAt:time+P.leaseMs};
      return {...result(point,value),acquisition:{version:1,token:value.lease.token,expiresAt:new Date(value.lease.expiresAt).toISOString(),
        request:{url:'https://openapi.its.go.kr:9443/cctvInfo',params:{apiKey,type:'all',cctvType:'3',...cctvBounds(point),getType:'json'},timeoutMs:P.timeoutMs}}};
    },
    complete(point,body) {
      const value=record(point),lease=value.lease;
      if(!lease || lease.expiresAt<=now() || typeof body.token!=='string' || body.token!==lease.token)
        throw Object.assign(new Error('CCTV 저장 요청이 만료되었어요.'),{statusCode:409});
      if(body.failed===true){
        delete value.lease;value.retryAt=now()+P.failureMs;
        return result(point,value,{retryAt:new Date(value.retryAt).toISOString()});
      }
      if(!Array.isArray(body.rows)||body.rows.length>8)throw Object.assign(new Error('CCTV 목록 형식이 올바르지 않아요.'),{statusCode:400});
      let rows;
      try{rows=selectCctvRows(body.rows,point);}catch{throw Object.assign(new Error('CCTV 목록을 검증하지 못했어요.'),{statusCode:400});}
      if(rows.length!==body.rows.length)throw Object.assign(new Error('CCTV 주소 또는 위치가 올바르지 않아요.'),{statusCode:400});
      // Use server-issued time so delayed/replayed uploads cannot extend old URLs.
      value.entry={rows,fetchedAt:lease.issuedAt};delete value.lease;delete value.retryAt;
      return {...result(point,value),saved:true};
    },
  };
}
