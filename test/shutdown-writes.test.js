import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/server.js';

test('shutdown sees an in-flight save and write draining completes only after its response', async () => {
  let release, entered, shutdownPending;
  const began=new Promise(resolve=>{entered=resolve;});
  const held=new Promise(resolve=>{release=resolve;});
  let app;
  const server=createServer((request,response)=>app(request,response));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port, origin='http://127.0.0.1:'+port;
  app=createApp({store:{},directory:'.test-output/drain-unit',port,toolsStatus:{},engine:{pump(){}},vault:{status:()=>({configured:false}),set:async()=>{entered();await held;}},shutdown:()=>{shutdownPending=app.locals.pendingWrites();}});
  try {
    const boot=await(await fetch(origin+'/api/bootstrap')).json();
    const headers={'Content-Type':'application/json','X-CSRF-Token':boot.csrf};
    const saving=fetch(origin+'/api/key',{method:'POST',headers,body:JSON.stringify({key:'not-a-real-key',remember:false})});
    await began;assert.equal(app.locals.pendingWrites(),1);
    const closing=await fetch(origin+'/api/shutdown',{method:'POST',headers});assert.equal(closing.status,200);await closing.json();
    await new Promise(resolve=>setImmediate(resolve));assert.equal(shutdownPending,1);
    release();const saved=await saving;await saved.json();assert.equal(saved.status,200);assert.equal(app.locals.pendingWrites(),0);
  } finally {release();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
