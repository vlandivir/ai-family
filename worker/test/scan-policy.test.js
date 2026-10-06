import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogTasks, searchDue, checkTask, checkNext } from '../src/scan.js';
import { claimTask, finishTask, normalizeScanState, searchSlot, createScanStore } from '../src/scan-state.js';
import { priceRejected } from '../src/listing-policy.js';
const now = Date.parse('2026-10-06T10:00:00Z');
test('new apartments precede fit, conditional, price-only exclusions and every house', () => {
  const rows = ['excluded','conditional','fit'].map((status,i) => ({id:i,status,fit:status==='excluded'?'Цена выше лимита 200000 EUR':'',source_url:`https://4zida.rs/${i}`,details:{category:'living'}}));
  const tasks = catalogTasks([...rows,{id:'house',status:'fit',source_url:'https://4zida.rs/house',details:{category:'houses'}},{id:'reject',status:'excluded',fit:'Первый этаж',source_url:'https://4zida.rs/reject',details:{category:'living'}}]);
  const state=normalizeScanState({queue:[{kind:'new',scenario:'houses',url:'https://4zida.rs/new-house'},...tasks,{kind:'new',scenario:'newbuild',url:'https://4zida.rs/new-apartment'}]},now);
  const order=[];while(true){const t=claimTask(state,now);if(!t)break;order.push(t.url);finishTask(state,t);}
  assert.deepEqual(order.slice(0,4),['https://4zida.rs/new-apartment','https://4zida.rs/2','https://4zida.rs/1','https://4zida.rs/0']);
  assert.equal(order.length,6);assert.ok(!order.includes('https://4zida.rs/reject'));
});
test('search uses Belgrade slots including midnight, DST and the overnight gap', () => {
  assert.equal(searchSlot(Date.parse('2026-10-06T04:00:00Z')),'2026-10-06T06');
  assert.equal(searchSlot(Date.parse('2026-12-06T05:00:00Z')),'2026-12-06T06');
  for(const hour of [0,6,8,10,12,14,16,18,20]){
    const start=Date.parse(`2026-10-06T${String(hour).padStart(2,'0')}:00:00+02:00`);
    assert.equal(searchDue({lastDiscovery:new Date(start-1000).toISOString()},start),true);
    assert.equal(searchDue({lastDiscovery:new Date(start).toISOString()},start+1000),false);
  }
  assert.equal(searchDue({lastDiscovery:'2026-10-06T20:00:00+02:00'},Date.parse('2026-10-06T23:59:59+02:00')),false);
  assert.equal(searchDue({lastDiscovery:'2026-10-06T00:00:00+02:00'},Date.parse('2026-10-06T05:59:59+02:00')),false);
});
test('old queue budgets migrate and stale searches restart under new filters', () => {
  const state=normalizeScanState({queue:[{kind:'new',url:'https://4zida.rs/a',maxPriceEur:250000}],lastDiscovery:new Date(now).toISOString(),searchRun:{remaining:[{url:'https://4zida.rs/old'}]}},now);
  assert.equal(state.queue[0].maxPriceEur,240000);assert.equal(state.searchRun,null);assert.equal(state.lastDiscovery,null);
});
test('only explicit price refusals may be reconsidered', () => {
  assert.equal(priceRejected({status:'excluded',fit:'Цена выше лимита 200000 EUR'}),true);
  assert.equal(priceRejected({status:'excluded',fit:'Покупатель отказался: высокая цена и первый этаж'}),false);
  assert.equal(priceRejected({status:'excluded',fit:'Цена выше лимита',details:{exclusionReason:'district'}}),false);
});
test('price-only exclusions receive a full reassessment at the new budget', async () => {
  let analyzed=false;
  await checkTask({kind:'existing',listingId:'old',url:'https://4zida.rs/old',checkedAt:new Date(now).toISOString()}, {}, 'p', {
    now:()=>now,get:async()=>[{id:'old',status:'excluded',fit:'Цена выше лимита 200000 EUR',details:{category:'living'}}],
    check:async()=>{throw Error('must reassess');},analyze:async (message,key,topic)=>{analyzed=true;assert.equal(topic.scan.maxPriceEur,240000);return {scanResult:'processed'};},
  });assert.equal(analyzed,true);
});
test('rejected new objects stay ignored while price rejects return behind suitable apartments', async () => {
  for(const result of ['excluded','over_budget']){
    const store=createScanStore('/unused',{load:async()=>({queue:[{kind:'new',url:'https://4zida.rs/a'}]}),save:async()=>{},now:()=>now});
    await checkNext({},'p',store,{now:()=>now,record:async()=>{},process:async()=>({scanResult:result})});
    const state=await store.read();assert.equal(Boolean(state.dismissedUrls['https://4zida.rs/a']),result==='excluded');
    if(result==='over_budget'){assert.equal(state.queue[0].kind,'price');assert.equal(claimTask(state,now),null);}
  }
});

test('previously dismissed price-only URLs return after restart while other refusals stay dismissed', () => {
  const price='https://4zida.rs/price',district='https://4zida.rs/district';
  const state=normalizeScanState({version:3,dismissedUrls:{[price]:{result:'over_budget',reason:'Цена выше лимита 200000 EUR',checkedAt:'2026-10-01T10:00:00Z'},[district]:{result:'excluded',reason:'район'}}},now);
  assert.equal(state.queue[0].kind,'price');assert.equal(state.queue[0].url,price);
  assert.equal(state.dismissedUrls[price],undefined);assert.ok(state.dismissedUrls[district]);
});
