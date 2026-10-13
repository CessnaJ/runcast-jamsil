import {CCTV_POLICY as P,parseItsCctvResponse,selectCctvRows,cctvResult} from './cctv-domain.mjs';

function boundedSignal(parent,timeoutMs) {
  const controller=new AbortController();
  const abort=()=>controller.abort(parent?.reason);
  if(parent?.aborted)abort();else parent?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  return {signal:controller.signal,dispose(){clearTimeout(timer);parent?.removeEventListener('abort',abort);}};
}
async function readLimited(response) {
  if(!response.ok)throw new Error('CCTV 자료 요청 실패');
  if(Number(response.headers.get('content-length'))>P.maxResponseBytes)throw new Error('CCTV 응답이 너무 큽니다.');
  const reader=response.body.getReader(),chunks=[];let total=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;
      if(total>P.maxResponseBytes)throw new Error('CCTV 응답이 너무 큽니다.');chunks.push(value);}
  } catch(error){await reader.cancel().catch(()=>{});throw error;} finally{reader.releaseLock();}
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder().decode(bytes);
}
function failure(point,previous,retryAt) {
  const usable=previous?.cctv?.usableUntil && Date.parse(previous.cctv.usableUntil)>Date.now();
  return usable?{...previous,cctv:{...previous.cctv,stale:true,retryAt},refresh:{failed:false,stale:true,retryAt},acquisition:undefined}
    :{...cctvResult([],point,{retryAt}),errors:['CCTV: 목록을 불러오지 못했어요.'],refresh:{failed:true,stale:false,retryAt}};
}

// Two stages: ask our server for cached data/a lease, then call ITS directly.
// Completion only warms the server cache; it never gates a successful display.
export async function loadCctv({location,signal,fetchImpl=globalThis.fetch,onReady=()=>{}}) {
  async function post(path,body,timeoutMs=5000) {
    const guard=boundedSignal(signal,timeoutMs);
    try {
      const response=await fetchImpl(path,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(body),signal:guard.signal,cache:'no-store'});
      if(!response.ok)throw new Error('CCTV 저장 또는 조회 실패');
      return await response.json();
    } finally {guard.dispose();}
  }
  let prepared;
  try {prepared=await post('/api/cctv-prepare',{location});}
  catch(error){if(signal?.aborted)throw error;return failure(location,null,new Date(Date.now()+P.failureMs).toISOString());}
  const {acquisition,...cached}=prepared;
  if(!acquisition){
    // Another browser may own this instance's lease. Respect retryAt; no polling loop.
    if(cached.cctv?.configured && !cached.cctv?.fetchedAt && cached.cctv?.retryAt)
      return {...cached,errors:['CCTV: 목록 갱신 대기 중이에요.'],refresh:{...cached.refresh,failed:true}};
    onReady(cached);return cached;
  }
  let rows;
  const guard=boundedSignal(signal,P.timeoutMs);
  try {
    if(acquisition.version!==1 || acquisition.request?.url!=='https://openapi.its.go.kr:9443/cctvInfo'
      || Date.parse(acquisition.expiresAt)<=Date.now())throw new Error('CCTV 조회 정보가 만료되었어요.');
    const url=new URL(acquisition.request.url);url.search=new URLSearchParams(acquisition.request.params);
    const response=await fetchImpl(url,{signal:guard.signal,mode:'cors',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{Accept:'application/json, application/xml'}});
    rows=selectCctvRows(parseItsCctvResponse(await readLimited(response)),location);
  } catch(error) {
    if(signal?.aborted)throw error;
    let retryAt=new Date(Date.now()+P.failureMs).toISOString();
    try{const failed=await post('/api/cctv-complete',{location,token:acquisition.token,failed:true});retryAt=failed.cctv?.retryAt||retryAt;}catch{}
    return failure(location,cached,retryAt);
  } finally {guard.dispose();}
  if(signal?.aborted)throw new DOMException('Aborted','AbortError');
  const fetchedAt=new Date(Date.parse(acquisition.expiresAt)-P.leaseMs).toISOString();
  const fresh=cctvResult(rows,location,{fetchedAt});
  onReady(fresh); // Show before cache upload, even when a different instance rejects it.
  try{await post('/api/cctv-complete',{location,token:acquisition.token,rows});}catch{}
  return fresh;
}
