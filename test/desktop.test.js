import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { instanceId } from '../src/instance.js';
const {identity,isLocalURL,savedRoute,externalURL}=createRequire(import.meta.url)('../desktop/core.cjs');

test('desktop and backend agree on data identity without exposing an absolute path',()=>{
  const id=identity('data'); assert.equal(id,instanceId('data')); assert.match(id,/^[a-f0-9]{24}$/);
  assert.notEqual(id,identity('another-data'));
});
test('desktop navigation is limited to its own origin and selected HTTPS documentation',()=>{
  const origin='http://127.0.0.1:3210';
  assert.equal(isLocalURL(origin+'/?project=abc',origin),true);
  for(const bad of ['http://127.0.0.1:3211/','http://127.0.0.1.evil.test:3210/','http://user@127.0.0.1:3210/','file:///C:/private','javascript:alert(1)']) assert.equal(isLocalURL(bad,origin),false);
  assert.equal(externalURL('https://platform.vocaligntech.com/docs/'),true);
  for(const bad of ['http://platform.vocaligntech.com/','https://platform.vocaligntech.com.evil.test/','https://user@platform.vocaligntech.com/','https://platform.vocaligntech.com:8443/','file:///C:/private']) assert.equal(externalURL(bad),false);
});
test('saved desktop routes restore only a workspace, never an arbitrary local API or external page',()=>{
  const route='/?project=327c1117-33b7-47f0-b3cf-596f9c6b05a9';
  assert.equal(savedRoute(route),route);assert.equal(savedRoute('/legacy'),'/legacy');
  for(const bad of ['//evil.test','/\\evil.test','/api/shutdown','/api/key','https://evil.test','/?project=not-an-id']) assert.equal(savedRoute(bad),null);
});
