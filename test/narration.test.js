import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, copyFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareNarration, narrationRequest, inspectNarrationAudio } from '../src/narration.js';

function wav(duration, rate = 48000) {
  const samples = Math.round(duration * rate), audio = Buffer.alloc(44 + samples * 2);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(rate, 24); audio.writeUInt32LE(rate * 2, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  for (let index = 0; index < samples; index++) audio.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / rate) * 8000), 44 + index * 2);
  return audio;
}
const script = '平时你不买我不管，但是你千万不能错过维希缇双十一福利大促！拍一到手三大件，这么多只要99！';
function fixture(frames = 90) {
  return { id: 'test-job', keyHash: 'account-A', segments: [{ frames }], recipe: { story: { assets: [{ id: 'C001', type: 'character', name: '女人' }] },
    edits: { fullDialogue: { enabled: true, delivery: 'voiceover', speakerId: 'narrator', voiceId: 'voice_ready', speed: 1, text: script } } } };
}
const mediaTools = {
  inspect: async file => { const audio = await readFile(file); return { duration: audio.readUInt32LE(40) / audio.readUInt32LE(28), sampleRate: audio.readUInt32LE(24), channels: audio.readUInt16LE(22) }; },
  normalize: copyFile,
  pad: async (source, destination, samples) => { const audio = await readFile(source); const duration = audio.readUInt32LE(40) / audio.readUInt32LE(28); assert.ok(samples / 48000 >= duration); await writeFile(destination, wav(samples / 48000)); },
};
function provider(duration = 1, status = 'ready') {
  return { reads: 0, posts: 0,
    async listVoices() { this.reads++; return [{ id: 'voice_ready', status }]; },
    async synthesizeSpeech(request, file) { this.posts++; await writeFile(file, wav(duration)); return { bytes: (await readFile(file)).length, contentType: 'audio/wav' }; },
  };
}

test('whole-script narration freezes a marker before one POST and reuses saved audio', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-narration-'));
  try {
    const job = fixture(), voice = provider(), states = [];
    const submit = voice.synthesizeSpeech.bind(voice);
    voice.synthesizeSpeech = async (request, file) => {
      assert.equal(request.input, script);
      const state = JSON.parse(await readFile(path.join(path.dirname(file), 'state.json'), 'utf8'));
      const marker = JSON.parse(await readFile(path.join(path.dirname(file), 'submitted.json'), 'utf8'));
      assert.equal(state.state, 'submitting'); assert.equal(marker.idempotencyKey, request.idempotencyKey);
      assert.equal(states.at(-1), 'submitting');
      return submit(request, file);
    };
    const result = await prepareNarration(directory, job, voice, fields => { job.narration = fields; states.push(fields.state); }, { mediaTools });
    assert.equal(result.duration, 1); assert.equal(result.targetDuration, 3); assert.equal(job.narration.state, 'ready');
    assert.equal((await mediaTools.inspect(path.join(directory, result.file))).duration, 3);
    const repeated = await prepareNarration(directory, job, voice, fields => { job.narration = fields; }, { mediaTools });
    assert.equal(repeated.requestHash, result.requestHash); assert.equal(voice.posts, 1); assert.equal(voice.reads, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unknown submissions survive restart and another job without duplicate paid calls', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-narration-unknown-'));
  try {
    const job = fixture(), voice = provider(), cacheDirectory = path.join(directory, 'account-A-cache');
    voice.synthesizeSpeech = async () => { voice.posts++; throw new Error('network failure'); };
    await assert.rejects(prepareNarration(path.join(directory, 'job-1'), job, voice, fields => { job.narration = fields; }, { mediaTools, cacheDirectory }));
    assert.equal(job.narration.state, 'unknown');
    await assert.rejects(prepareNarration(path.join(directory, 'job-1'), structuredClone(job), voice, () => {}, { mediaTools, cacheDirectory }), /上次配音结果未知/u);
    await assert.rejects(prepareNarration(path.join(directory, 'job-2'), fixture(), voice, () => {}, { mediaTools, cacheDirectory }), /上次配音结果未知/u);
    assert.equal(voice.posts, 1); assert.equal(voice.reads, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('too-long audio remains complete and a longer new job can reuse it without paying again', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-narration-length-'));
  try {
    const voice = provider(2), first = fixture(30), cacheDirectory = path.join(directory, 'account-A-cache');
    await assert.rejects(prepareNarration(path.join(directory, 'short'), first, voice, fields => { first.narration = fields; }, { mediaTools, cacheDirectory }), error => error.code === 'narration_too_long');
    assert.equal(first.narration.state, 'too_long');
    assert.equal((await mediaTools.inspect(path.join(directory, 'short', first.narration.sourceFile))).duration, 2);
    await assert.rejects(access(path.join(directory, 'short', first.narration.file)));
    const result = await prepareNarration(path.join(directory, 'long'), fixture(90), voice, () => {}, { mediaTools, cacheDirectory });
    assert.equal(result.duration, 2); assert.equal(result.targetDuration, 3); assert.equal(voice.posts, 1); assert.equal(voice.reads, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('account caches do not reuse audio across keys, and identical concurrent jobs share one synthesis', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-narration-cache-'));
  try {
    const voice = provider(), cacheDirectory = path.join(directory, 'account-A-cache');
    const results = await Promise.all(['one', 'two'].map(name => prepareNarration(path.join(directory, name), fixture(), voice, () => {}, { mediaTools, cacheDirectory })));
    assert.equal(voice.posts, 1);
    for (let index = 0; index < results.length; index++) assert.equal((await mediaTools.inspect(path.join(directory, ['one', 'two'][index], results[index].file))).duration, 3);
    const other = fixture(); other.keyHash = 'account-B';
    await assert.rejects(prepareNarration(path.join(directory, 'wrongly-shared-cache'), other, voice, () => {}, { mediaTools, cacheDirectory }), /其他账户/u);
    assert.equal(voice.posts, 1);
    await prepareNarration(path.join(directory, 'different-account'), other, voice, () => {}, { mediaTools, cacheDirectory: path.join(directory, 'account-B-cache') });
    assert.equal(voice.posts, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('pause or KEY change during voice query cancels before a paid marker and can resume safely', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-narration-stop-'));
  try {
    const job = fixture(), voice = provider(); let guardCalls = 0;
    const request = narrationRequest(job), marker = path.join(directory, 'narration', request.requestHash, 'submitted.json');
    await assert.rejects(prepareNarration(directory, job, voice, fields => { job.narration = fields; }, { mediaTools, beforeSubmit: () => { guardCalls++; throw new Error('known local pause or key change'); } }));
    assert.equal(voice.posts, 0); assert.equal(guardCalls, 1); assert.equal(job.narration, undefined);
    await assert.rejects(access(marker));
    await prepareNarration(directory, job, voice, fields => { job.narration = fields; }, { mediaTools, beforeSubmit: () => { guardCalls++; } });
    assert.equal(voice.posts, 1); assert.equal(job.narration.state, 'ready');
    assert.ok(!Object.hasOwn(job.narration, 'accountHash'));
    await prepareNarration(directory, job, voice, () => {}, { mediaTools, beforeSubmit: () => { throw new Error('cached audio must not invoke a POST guard'); } });
    assert.equal(voice.posts, 1); assert.equal(guardCalls, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('private voice readiness is checked before any paid request or video work', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-narration-ready-'));
  try {
    const voice = provider(1, 'processing');
    await assert.rejects(prepareNarration(directory, fixture(), voice, () => {}, { mediaTools }), /尚未就绪/u);
    assert.equal(voice.posts, 0);
    const missing = provider(); missing.listVoices = async () => [{ id: 'voice_other', status: 'ready' }];
    await assert.rejects(prepareNarration(directory, fixture(), missing, () => {}, { mediaTools }), /当前账户/u);
    assert.equal(missing.posts, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('voiceover cannot silently become a character conversation or read speaker labels', () => {
  const job = fixture();
  job.recipe.edits.fullDialogue.text = '[旁白]：维希缇，只要99。';
  assert.equal(narrationRequest(job).input, '维希缇，只要99。');
  job.recipe.edits.fullDialogue.text = '[C001]：维希缇，只要99。';
  assert.throws(() => narrationRequest(job), /人物发言标签/u);
  job.recipe.edits.fullDialogue.text = script; job.recipe.edits.fullDialogue.speakerId = 'C001';
  assert.throws(() => narrationRequest(job), /画外旁白/u);
  job.recipe.edits.fullDialogue.delivery = 'uploaded'; assert.equal(narrationRequest(job), null);
});

test('real FFmpeg conversion preserves complete audio and pads with silence to frame duration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-narration-real-'));
  try {
    const result = await prepareNarration(directory, fixture(30), provider(0.5), () => {});
    const raw = await inspectNarrationAudio(path.join(directory, result.sourceFile));
    const padded = await inspectNarrationAudio(path.join(directory, result.file));
    assert.equal(raw.duration, 0.5); assert.equal(padded.duration, 1);
    assert.equal(padded.sampleRate, 48000); assert.equal(padded.channels, 2);
    assert.equal(result.duration, 0.5);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
