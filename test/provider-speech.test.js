import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VocalignProvider, API_ORIGIN } from '../src/provider.js';

function wav() {
  const audio = Buffer.alloc(44 + 4800 * 2); audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(48000, 24);
  audio.writeUInt32LE(96000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  return audio;
}
const request = { voiceId: 'voice_ready', input: '维希缇，拍一到手三大件，这么多只要99！', speed: 1.1, idempotencyKey: 'stable-speech-request-001' };

test('private voice list exposes only public identifiers and status, without creating voices', async () => {
  const calls = [];
  const provider = new VocalignProvider('do-not-log-key', { fetchImpl: async (url, options) => {
    calls.push([url, options.method]);
    return new Response(JSON.stringify({ data: [{ id: 'voice_ready', name: '中文口播', status: 'ready', secret: 'private-token' },
      { id: 'voice_pending', status: 'processing' }, { id: 'vendor_internal', status: 'ready' }] }));
  } });
  assert.deepEqual(await provider.listVoices(), [{ id: 'voice_ready', name: '中文口播', status: 'ready' }, { id: 'voice_pending', name: 'voice_pending', status: 'processing' }]);
  assert.deepEqual(calls, [[API_ORIGIN + '/v1/audio/voices', 'GET']]);
});

test('speech submits exact script once and atomically saves binary WAV', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-speech-'));
  try {
    const destination = path.join(directory, 'original.wav'), calls = [], audio = wav();
    const provider = new VocalignProvider('test-key', { fetchImpl: async (url, options) => {
      calls.push({ url, options }); return new Response(audio, { headers: { 'content-type': 'audio/wav', 'content-length': String(audio.length) } });
    } });
    const result = await provider.synthesizeSpeech(request, destination);
    assert.equal(calls.length, 1); assert.equal(calls[0].url, API_ORIGIN + '/v1/audio/speech');
    assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.redirect, 'manual');
    assert.deepEqual(JSON.parse(calls[0].options.body), { model: 'openai-tts', voice: request.voiceId, input: request.input, speed: 1.1, response_format: 'wav' });
    assert.equal(calls[0].options.headers['Idempotency-Key'], request.idempotencyKey);
    assert.deepEqual(await readFile(destination), audio); assert.equal(result.bytes, audio.length);
    await assert.rejects(access(destination + '.partial'));
    await assert.rejects(provider.synthesizeSpeech(request, destination), /已存在/u); assert.equal(calls.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unknown network and failed HTTP POST never retry or reveal raw error details', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-speech-failure-'));
  try {
    for (const mode of ['network', 'http']) {
      let calls = 0, sleeps = 0;
      const provider = new VocalignProvider('sensitive-key', { sleep: async () => { sleeps++; }, fetchImpl: async () => {
        calls++; if (mode === 'network') throw new Error('Bearer sensitive-key');
        return new Response('private server error', { status: 503 });
      } });
      await assert.rejects(provider.synthesizeSpeech(request, path.join(directory, mode + '.wav')), error => {
        assert.ok(!error.message.includes('sensitive-key')); return mode === 'network' ? error.code === 'speech_unknown' : error.code === 'speech_http_503';
      });
      assert.equal(calls, 1); assert.equal(sleeps, 0);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('WAV response validation rejects JSON, invalid binary and oversized payload without publishing a file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-speech-invalid-'));
  try {
    const cases = [
      () => new Response(JSON.stringify({ error: 'not audio' }), { headers: { 'content-type': 'application/json' } }),
      () => new Response(Buffer.alloc(60), { headers: { 'content-type': 'audio/wav' } }),
      () => new Response(wav(), { headers: { 'content-type': 'audio/wav', 'content-length': String(100 * 1024 * 1024 + 1) } }),
    ];
    for (let index = 0; index < cases.length; index++) {
      let calls = 0; const destination = path.join(directory, index + '.wav');
      const provider = new VocalignProvider('test-key', { fetchImpl: async () => { calls++; return cases[index](); } });
      await assert.rejects(provider.synthesizeSpeech(request, destination));
      assert.equal(calls, 1); await assert.rejects(access(destination)); await assert.rejects(access(destination + '.partial'));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('speech preflight guards invalid parameters and existing partial response before any POST', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-speech-preflight-'));
  try {
    let calls = 0; const provider = new VocalignProvider('test-key', { fetchImpl: async () => { calls++; return new Response(wav()); } });
    for (const values of [{ voiceId: 'built-in-voice' }, { speed: 2.1 }, { speed: '1' }, { input: '' }, { idempotencyKey: '' }]) {
      await assert.rejects(provider.synthesizeSpeech({ ...request, ...values }, path.join(directory, 'audio.wav')));
    }
    await writeFile(path.join(directory, 'audio.wav.partial'), 'partial-record');
    await assert.rejects(provider.synthesizeSpeech(request, path.join(directory, 'audio.wav')), /部分响应/u);
    assert.equal(calls, 0); assert.equal(await readFile(path.join(directory, 'audio.wav.partial'), 'utf8'), 'partial-record');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
