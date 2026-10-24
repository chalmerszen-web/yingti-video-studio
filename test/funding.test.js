import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {FundingGate,pendingGenerationCost} from '../src/funding.js';
import {VocalignProvider} from '../src/provider.js';
import {QueueEngine} from '../src/engine.js';
import {Store} from '../src/store.js';
import {KeyVault} from '../src/keys.js';
import {createApp} from '../src/server.js';
import {createServer} from 'node:http';
const profile=keyHash=>({version:1,keyHash,currency:'CNY',videoPerSecond:{'wan3.0-480p':.1,'wan3.0-720p':.2},speechPer1000Characters:1,validUntil:new Date(Date.now()+86400000).toISOString()});
const job=()=>({keyHash:'test-key-hash',model:'wan3.0-720p',segments:[{state:'completed',requestDuration:15},{state:'running',taskId:'already-paid',requestDuration:15},{state:'pending',generationMode:'base_copy',requestDuration:15},{state:'pending',requestDuration:10},{state:'pending',requestDuration:5}]});

test('funding covers all unpaid requests, excludes paid/copied footage, and fails closed for missing or stale rates',async()=>{
 const gate=new FundingGate({profileLoader:profile});const plan=job();assert.equal(pendingGenerationCost(plan,profile(plan.keyHash)).amount,3);
 let reads=0;const provider={balance:async()=>{reads++;return {available:2.99,currency:'CNY'};}};
 await assert.rejects(gate.ensure(plan,provider),e=>e.code==='insufficient_funds');
 provider.balance=async()=>({available:3,currency:'CNY'});assert.equal((await gate.ensure(plan,provider)).state,'approved');
 assert.equal(reads,1);await assert.rejects(new FundingGate({profileLoader:()=>null}).ensure(plan,provider),e=>e.code==='funding_unavailable');
 await assert.rejects(new FundingGate({profileLoader:key=>({...profile(key),validUntil:'2020-01-01'})}).ensure(plan,provider),e=>e.code==='funding_unavailable');
 await assert.rejects(new FundingGate({profileLoader:key=>({...profile(key),keyHash:'other'})}).ensure(plan,provider),e=>e.code==='funding_unavailable');
 const approved=await gate.ensure(plan,provider);assert.doesNotMatch(JSON.stringify(approved),/available|amount|currency|balance/);
});

test('provider uses wallet and token cap with the actual site currency, not the misleading USD field name',async()=>{
 const responses={
  '/api/status':{success:true,data:{quota_display_type:'CNY',quota_per_unit:500000,usd_exchange_rate:7.3,display_token_stat_enabled:false}},
  '/v1/dashboard/billing/subscription':{object:'billing_subscription',hard_limit_usd:100},
  '/v1/dashboard/billing/usage':{object:'list',total_usage:3000},
  '/api/usage/token/':{code:true,data:{object:'token_usage',unlimited_quota:false,total_available:1000000,expires_at:0,model_limits_enabled:false}},
 };
 const provider=new VocalignProvider('test-only',{fetchImpl:async url=>new Response(JSON.stringify(responses[new URL(url).pathname]),{headers:{'content-type':'application/json'}})});
 const balance=await provider.balance();assert.equal(balance.currency,'CNY');assert.equal(balance.accountAvailable,70);assert.equal(balance.available,14.6);
 responses['/api/usage/token/'].data.unlimited_quota=true;assert.equal((await provider.balance()).available,70);
 responses['/v1/dashboard/billing/subscription'].hard_limit_usd=100000000;await assert.rejects(provider.balance(),/无法核实实际账户余额/);
  delete responses['/api/status'].data.display_token_stat_enabled;await assert.rejects(provider.balance(),e=>e.code==='funding_unavailable');
});

test('insufficient funds and unavailable checks never upload or submit, and a later explicit resume checks again',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'yingti-funds-')),store=new Store(directory),vault=new KeyVault(directory);await vault.set('funding-test-key');const id=randomUUID();await mkdir(path.join(directory,'jobs',id),{recursive:true});
 const calls=[];let available=1;const provider={balance:async()=>{calls.push('balance');return {available,currency:'CNY'};},upload:async()=>{calls.push('upload');return 'oss://x';},create:async()=>{calls.push('paid');return 'funded-task';},status:async()=>({status:'completed'}),download:async()=>{}};
 store.create({id,created:new Date().toISOString(),keyHash:vault.hash(),state:'queued',model:'wan3.0-720p',mode:'face',target:'',source:{},segments:[{index:0,state:'pending',requestDuration:10,frames:300,start:0,duration:10,attempts:0}],events:[]});
 const engine=new QueueEngine({directory,store,vault,providerFactory:()=>provider,fundingGate:new FundingGate({profileLoader:profile}),mediaTools:{prepareSegments:async()=>{},normalizeResult:async()=>{},assemble:async()=>({})},pollInterval:1});
 try{await engine.pump();assert.equal(store.get(id).state,'funds_required');assert.equal(calls.includes('upload'),false);assert.equal(calls.includes('paid'),false);assert.equal(store.get(id).segments[0].state,'pending');
 available=2;engine.resume(id);for(let i=0;i<200&&engine.active;i++)await new Promise(r=>setTimeout(r,5));assert.equal(store.get(id).state,'completed');assert.equal(calls.filter(x=>x==='paid').length,1);
 }finally{engine.stop();store.close();await rm(directory,{recursive:true,force:true});}
});

test('user edition cannot read balances or pricing configuration through the developer endpoints',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'yingti-fund-ui-')),store=new Store(directory),vault=new KeyVault(directory);await vault.set('privacy-test-key');
 let called=0;const engine={active:null,pump(){},providerFactory:()=>({balance:async()=>{called++;return {available:12345.6789,currency:'CNY'};}}),funding:new FundingGate({profileLoader:profile})};
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;server.on('request',createApp({store,vault,engine,directory,port,toolsStatus:{},edition:'user'}));
 try{const base=`http://127.0.0.1:${port}`,boot=await(await fetch(base+'/api/bootstrap')).json();assert.equal(boot.edition,'user');
  const denied=await fetch(base+'/api/funding');assert.equal(denied.status,403);assert.equal(called,0);assert.doesNotMatch(await denied.text(),/12345|available|currency/);
  const deniedWrite=await fetch(base+'/api/funding/profile',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':boot.csrf},body:JSON.stringify(profile(vault.hash()))});assert.equal(deniedWrite.status,403);
 }finally{await new Promise(r=>server.close(r));store.close();await rm(directory,{recursive:true,force:true});}
});

for(const edition of ['user','developer'])test(`${edition} shipping defaults disable funding endpoints before any provider access`,async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'yingti-deferred-funding-')),store=new Store(directory),vault=new KeyVault(directory);
 let providerCalls=0;
 const engine=new QueueEngine({store,vault,directory,providerFactory:()=>{providerCalls++;throw new Error('must not query platform');}});
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 server.on('request',createApp({store,vault,engine,directory,port,toolsStatus:{},edition}));
 try{
  const base=`http://127.0.0.1:${port}`,boot=await(await fetch(base+'/api/bootstrap')).json();assert.equal(boot.features.fundingPreflight,false);
  const status=edition==='user'?403:409;
  const read=await fetch(base+'/api/funding');assert.equal(read.status,status);
  const write=await fetch(base+'/api/funding/profile',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':boot.csrf},body:'{}'});assert.equal(write.status,status);
  assert.equal(providerCalls,0);assert.equal(engine.funding,null);
 }finally{engine.stop();await new Promise(r=>server.close(r));store.close();await rm(directory,{recursive:true,force:true});}
});
