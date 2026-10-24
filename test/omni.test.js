import test from 'node:test';
import assert from 'node:assert/strict';
import { VocalignProvider } from '../src/provider.js';

function streamed(text, chunkSize = 11) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
test('Omni SSE handles split UTF-8, final usage and DONE without a final newline', async () => {
  let body, calls = 0, chunks = '';
  const provider = new VocalignProvider('test-only-omni-key', { fetchImpl: async (url, options) => {
    calls++; body = JSON.parse(options.body);
    return streamed('data: ' + JSON.stringify({ id: 'response-test', choices: [{ delta: { content: '{"台词":' } }] }) + '\r\n\r\ndata: ' + JSON.stringify({ choices: [{ delta: { content: '"你好"}' } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { total_tokens: 123 } }) + '\n\ndata: [DONE]');
  } });
  const result = await provider.analyzeVideo('oss://test/video.mp4', '分析脚本', async delta => { chunks += delta; });
  assert.equal(calls, 1); assert.equal(body.model, 'Omni-Analysis'); assert.equal(body.messages[0].content.length, 2); assert.deepEqual(body.modalities, ['text']); assert.equal(body.stream_options.include_usage, true);
  assert.equal(result.text, '{"台词":"你好"}'); assert.equal(chunks, result.text); assert.equal(result.usage.total_tokens, 123); assert.equal(result.complete, true);
});
test('an interrupted Omni stream preserves partial text and never retries', async () => {
  let calls = 0, text = '';
  const provider = new VocalignProvider('test-only-omni-key', { fetchImpl: async () => { calls++; return streamed('data: {"choices":[{"delta":{"content":"部分结果"}}]}\n\n'); } });
  await assert.rejects(provider.analyzeVideo('oss://test/video.mp4', '分析', async delta => { text += delta; }), /完成标记/);
  assert.equal(text, '部分结果'); assert.equal(calls, 1);
});
test('Omni never accepts non-SSE or error events as completed analysis', async () => {
  const provider = new VocalignProvider('test-only-omni-key', { fetchImpl: async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(provider.analyzeVideo('oss://test', '分析'), /返回异常/);
  provider.fetch = async () => streamed('data: {"error":{"message":"failure"}}\n\ndata: [DONE]\n\n');
  await assert.rejects(provider.analyzeVideo('oss://test', '分析'), /返回错误/);
});

test('exact analysis model selection uses the same SSE contract and rejects unknown IDs before billing', async () => {
  let calls=0,body;
  const provider=new VocalignProvider('test-only-omni-key',{fetchImpl:async(_url,options)=>{calls++;body=JSON.parse(options.body);return streamed('data: {"choices":[{"delta":{"content":"已独立观察"}}]}\n\ndata: {"usage":{"total_tokens":12}}\n\ndata: [DONE]\n\n');}});
  const result=await provider.analyzeVideo('oss://test/video.mp4','独立观察',async()=>{},{model:'Omni-Analysis'});
  assert.equal(body.model,'Omni-Analysis');assert.equal(result.complete,true);assert.equal(calls,1);
  assert.equal(body.messages[0].content[0].type,'video_url');assert.equal(body.stream_options.include_usage,true);
  await assert.rejects(provider.analyzeVideo('oss://test/video.mp4','独立观察',async()=>{},{model:'omni-analysis'}),/唯一支持的视频分析模型/);
  await assert.rejects(provider.analyzeVideo('oss://test/video.mp4','独立观察',async()=>{},{model:'Omni-Plus'}),/唯一支持的视频分析模型/);
  assert.equal(calls,1,'Unsupported IDs cannot spend or silently fall back to a different model');
});
