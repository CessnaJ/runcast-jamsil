import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {createRefreshScheduler,REFRESH_INTERVALS} from '../assets/refresh-scheduler.mjs';

const source=await readFile(new URL('../assets/mobile.js',import.meta.url),'utf8');
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end));
const functions=[
  section('function currentContext()', '// A cached core response'),
  section('function contextNeedsRefresh()', 'function hydrateCoreCache()'),
  section('function renderCctv()', 'function renderAviation()'),
  section('function scheduleContextRetry(', 'async function refreshData('),
].join('\n');

async function fixture({pending=false}={}){
  let now=Date.now(),saved=null,calls=0,timerId=0;
  const storage={read:(_key,fallback)=>saved||fallback,write:(_key,value)=>{saved=structuredClone(value);return true;}};
  const options={now:()=>now,random:()=>0,storage};
  const key='37.5082,127.1001';
  const original=createRefreshScheduler(options);
  if(pending){
    let release;
    const request=original.request('context',key,{fetcher:()=>new Promise(resolve=>release=resolve)});
    const persisted=structuredClone(saved);
    release({});await request;saved=persisted;
  }else await original.request('context',key,{fetcher:async()=>({})});
  const state={location:{lat:37.5082,lon:127.1001},view:'decision',runtime:{mode:'public'},context:{locationKey:key,status:'idle',cctvs:null,cctv:null,errors:[]}};
  const nodes=new Map(),timers=new Map();
  const document={visibilityState:'visible',activeElement:null};
  const $=selector=>{
    if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',addEventListener(){},setAttribute(){}});
    return nodes.get(selector);
  };
  const scheduler=createRefreshScheduler(options);
  const sandbox={state,document,navigator:{onLine:true},locationKey:()=>key,refreshScheduler:scheduler,REFRESH_INTERVALS,
    Date:class extends Date{static now(){return now;}},$,icon:()=>'',escapeHtml:String,
    setTimeout:(callback,delay)=>{const id=++timerId;timers.set(id,{callback,at:now+delay});return id;},clearTimeout:id=>timers.delete(id),
    fetch:async()=>({ok:true,json:async()=>({aviation:{metar:[],taf:[]},errors:[]})}),
    loadCctv:async({onReady})=>{
      calls++;
      const value={cctvs:[{id:'camera',name:'CCTV',sector:'동',distance:1,url:'https://example.test/video'}],
        cctv:{configured:true,fetchedAt:new Date(now).toISOString(),usableUntil:new Date(now+45000).toISOString()},errors:[]};
      onReady(value);return value;
    },
  };
  runInNewContext(functions+'\nfunction render(){renderCctv();}',sandbox);
  return {state,sandbox,scheduler,timers,nodes,document,calls:()=>calls,
    async tick(ms){now+=ms;const ready=[...timers.entries()].filter(([,timer])=>timer.at<=now);
      for(const [id,timer] of ready){timers.delete(id);timer.callback();}
      await new Promise(resolve=>setImmediate(resolve));
    },
  };
}

test('reload during success cooldown shows waiting, then automatically fetches once',async()=>{
  const f=await fixture();
  const result=await f.sandbox.refreshContext();
  assert.equal(result.status,'skipped');assert.equal(f.calls(),0);
  assert.equal(f.state.context.status,'waiting');
  assert.match(f.nodes.get('#cctvRail').innerHTML,/잠시 후 CCTV/);
  assert.doesNotMatch(f.nodes.get('#cctvRail').innerHTML,/설정되지/);
  await f.sandbox.refreshContext();assert.equal(f.timers.size,1);
  await f.tick(REFRESH_INTERVALS.context+100);
  assert.equal(f.calls(),1);assert.equal(f.state.context.cctvs.length,1);assert.equal(f.timers.size,0);
  assert.match(f.nodes.get('#cctvRail').innerHTML,/cctv-card/);
});

test('reload while a previous request was pending waits for its finite lease',async()=>{
  const f=await fixture({pending:true});
  await f.sandbox.refreshContext();await f.tick(25000);
  assert.equal(f.calls(),0);assert.equal(f.state.context.status,'waiting');
  await f.tick(5100);assert.equal(f.calls(),1);
});

test('missing context is not reported as missing keys; only explicit configured false is',async()=>{
  const f=await fixture();
  for(const context of [null,{locationKey:'37.5082,127.1001',status:'idle'}]){
    f.state.context=context;f.sandbox.renderCctv();
    assert.doesNotMatch(f.nodes.get('#cctvRail').innerHTML,/설정되지/);
  }
  f.state.context={locationKey:'37.5082,127.1001',status:'ready',cctvs:[],cctv:{configured:false}};
  f.sandbox.renderCctv();assert.match(f.nodes.get('#cctvRail').innerHTML,/설정되지/);
});

test('manual retry observes rate limit but can resume after ten seconds',async()=>{
  const f=await fixture();await f.sandbox.refreshContext(true);assert.equal(f.calls(),0);
  await f.tick(10100);await f.sandbox.refreshContext(true);
  assert.equal(f.calls(),1);assert.equal(f.timers.size,0);
});

test('waiting retry does not issue a request while page is hidden or offline',async()=>{
  for(const mode of ['hidden','offline']){
    const f=await fixture();await f.sandbox.refreshContext();
    if(mode==='hidden')f.document.visibilityState='hidden';else f.sandbox.navigator.onLine=false;
    await f.tick(30100);assert.equal(f.calls(),0);assert.equal(f.timers.size,0);
  }
});
