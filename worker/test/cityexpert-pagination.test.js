import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paginationUrls, searchSweep } from '../src/scan.js';
import { createScanStore } from '../src/scan-state.js';
const base='https://cityexpert.rs/prodaja-nekretnina/beograd?ptId=1&maxPrice=240000&minSize=40&maxSize=70&bedroomsArray=r1';
const listing=id=>`https://cityexpert.rs/prodaja-nekretnina/beograd/${id}/dvosoban-stan-beograd`;
function page(number,total,ids=[]) {
  const state={response:{u:'/api/Search?req=%7B%7D',b:{result:ids.map(propId=>({propId})),info:{pageNumber:number,pageCount:total}}}};
  return `<script type="application/json" id="ng-state">${JSON.stringify(state)}</script>${ids.map(id=>`<a href="${listing(id)}">Listing</a>`).join('')}`;
}
test('City Expert transfer state yields the next public page with every filter intact',()=>{
  const [next]=paginationUrls(page(1,3),base);
  const url=new URL(next);assert.equal(url.searchParams.get('currentPage'),'2');
  for(const [key,value] of new URL(base).searchParams)assert.equal(url.searchParams.get(key),value);
  assert.deepEqual(paginationUrls(page(2,3),next),[next.replace('currentPage=2','currentPage=3')]);
  assert.deepEqual(paginationUrls(page(3,3),next.replace('currentPage=2','currentPage=3')),[]);
});
test('malformed and unrelated transfer state never expands the configured search',()=>{
  assert.deepEqual(paginationUrls('<script id="ng-state">invalid</script>',base),[]);
  assert.deepEqual(paginationUrls(page(1,2),base+'&currentPage=2'),[]);
  assert.deepEqual(paginationUrls(page(1,2).replace('/api/Search','https://other.com/api/Search'),base),[]);
  assert.deepEqual(paginationUrls(page(1,2),'https://cityexpert.rs/a/novogradnja/beograd'),[]);
});
test('a sweep passes all pages to the durable queue once and survives a restart',async()=>{
  const now=Date.parse('2026-10-06T12:00:00Z');let saved,stopped=false;
  const options={load:async()=>saved||{},save:async(path,state)=>{saved=structuredClone(state);},now:()=>now};
  const store=createScanStore('/unused',options), fetched=[];
  const deps={repo:async()=>'/repo',searches:async()=>[{url:base,scenario:'rental',maxPriceEur:240000}],listings:async()=>[],record:async()=>{},now:()=>now,
    fetch:async url=>{fetched.push(url);const n=Number(new URL(url).searchParams.get('currentPage')||1);if(n===1)stopped=true;return {status:200,html:page(n,3,n===1?[1000,1001]:n===2?[1001,1002]:[1003])};}};
  await searchSweep({},'project',store,{...deps,stopped:()=>stopped});
  assert.equal(saved.searchRun.remaining.length,1);assert.equal(saved.queue.length,2);
  await searchSweep({},'project',createScanStore('/unused',options),deps);
  assert.deepEqual(fetched.map(url=>Number(new URL(url).searchParams.get('currentPage')||1)),[1,2,3]);
  assert.deepEqual(saved.queue.map(task=>task.url),[1000,1001,1002,1003].map(listing));
  assert.ok(saved.queue.every(task=>task.scenario==='rental'&&task.maxPriceEur===240000));
  assert.equal(saved.searchRun,null);
});

test('pagination upgrade forces one fresh discovery and preserves the unfinished cursor', async()=>{
  const now=Date.parse('2026-10-06T12:00:00Z');let saved;
  const store=createScanStore('/unused',{load:async()=>({version:3,policyVersion:3,lastDiscovery:new Date(now).toISOString(),searchRun:{remaining:[{url:base+'&currentPage=2'}],visited:[base]}}),save:async(path,state)=>{saved=structuredClone(state);},now:()=>now});
  const state=await store.read();assert.equal(state.lastDiscovery,null);assert.equal(state.searchRun.remaining[0].url,base+'&currentPage=2');
  await store.update(state=>{state.lastDiscovery=new Date(now).toISOString();});
  const restarted=createScanStore('/unused',{load:async()=>saved,save:async()=>{},now:()=>now});
  assert.equal((await restarted.read()).lastDiscovery,new Date(now).toISOString());
});
