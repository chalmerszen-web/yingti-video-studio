import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ffmpeg, probe, prepareSegments, prepareComparisonVideo, normalizeResult, assemble } from '../src/media.js';

async function toneVideo(file, frequency, duration, color = 'black') {
  await ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=240x426:r=30`, '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000`, '-t', String(duration), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
}
async function audioProjection(file, directory, frequencies, start = 0.25, duration = 1) {
  const wav = path.join(directory, 'inspect.wav');
  await ffmpeg(['-ss', String(start), '-i', file, '-t', String(duration), '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', wav]);
  const bytes = await readFile(wav); let cursor = 12, data;
  while (cursor + 8 <= bytes.length) {
    const kind = bytes.toString('ascii', cursor, cursor + 4), length = bytes.readUInt32LE(cursor + 4);
    if (kind === 'data') { data = bytes.subarray(cursor + 8, cursor + 8 + length); break; }
    cursor += 8 + length + length % 2;
  }
  assert.ok(data?.length > 1000, 'decoded PCM must be available');
  const samples = data.length / 2, result = {};
  for (const frequency of frequencies) {
    let real = 0, imaginary = 0;
    for (let index = 0; index < samples; index++) {
      const value = data.readInt16LE(index * 2) / 32768, angle = 2 * Math.PI * frequency * index / 48000;
      real += value * Math.cos(angle); imaginary += value * Math.sin(angle);
    }
    result[frequency] = 2 * Math.hypot(real, imaginary) / samples;
  }
  return result;
}

test('audible comparison contains only the edited track and the actual labelled target image strip', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yingti-content-compare-'));
  try {
    await mkdir(path.join(directory, 'assets'));
    await toneVideo(path.join(directory, 'source.mp4'), 500, 2, 'blue');
    await toneVideo(path.join(directory, 'result.mp4'), 900, 2, 'red');
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xAA22CC:s=160x120', '-frames:v', '1', '-update', '1', path.join(directory, 'assets', 'target.png')]);
    const job = { sourceFile: 'source.mp4', recipe: { story: { assets: [{ id: 'P001', type: 'prop', name: '目标商品罐' }, { id: 'P002', type: 'prop', name: '面霜膏体', sourceRole: 'material' }, { id: 'P003', type: 'prop', name: '品牌字幕', sourceRole: 'graphic' }] }, edits: { assets: { P001: { main: { file: 'assets/target.png' } }, P002: { main: { file: 'assets/audit-only-jar.png' } }, P003: { main: { file: 'assets/graphic.png' } } } } } };
    const window = { index: 0, start: 0, duration: 2 };
    const file = await prepareComparisonVideo(directory, job, window), info = await probe(file);
    assert.match(path.basename(file), /^compare-v3-/); assert.equal(info.hasAudio, true); assert.equal(info.width, 720); assert.equal(info.height, 910, 'Material audit photos and graphics are not whole-product reference targets');
    const projection = await audioProjection(file, directory, [500, 900]);
    assert.ok(projection[900] > 0.05); assert.ok(projection[900] > projection[500] * 100, JSON.stringify(projection));
    const pixel = path.join(directory, 'reference.rgb');
    await ffmpeg(['-ss', '0.5', '-i', file, '-vf', 'crop=2:2:358:780', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', pixel]);
    const colors = await readFile(pixel); assert.ok(colors[0] > 120 && colors[1] < 80 && colors[2] > 150, `actual target pixels ${[...colors.subarray(0, 3)]}`);
    const bytes = await readFile(file); assert.equal(await prepareComparisonVideo(directory, job, window), file); assert.deepEqual(await readFile(file), bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('full dialogue reference inputs are silent while original-only inputs retain sound', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yingti-content-input-'));
  try {
    const source = path.join(directory, 'source.mp4'); await toneVideo(source, 500, 2);
    const info = await probe(source);
    for (const enabled of [true, false]) {
      const root = path.join(directory, enabled ? 'replacement' : 'original'); await mkdir(root); await copyFile(source, path.join(root, 'source.mp4'));
      const job = { workflow: 'studio', sourceFile: 'source.mp4', source: info, output: { width: 240, height: 426 }, recipe: { edits: { fullDialogue: { enabled } } }, segments: [{ index: 0, start: 0, startFrame: 0, frames: 60, duration: 2, requestDuration: 2 }] };
      await prepareSegments(root, job, async () => {});
      assert.equal((await probe(path.join(root, 'segments', 'input-0.mp4'))).hasAudio, !enabled);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('narration assembly preserves complete independent audio and renders captions from the new frozen script', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yingti-content-assemble-'));
  try {
    await mkdir(path.join(directory, 'segments'));
    await toneVideo(path.join(directory, 'source.mp4'), 500, 3, 'blue');
    await toneVideo(path.join(directory, 'segments', 'generated-0.mp4'), 700, 3);
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=900:sample_rate=48000', '-t', '2.8', '-ac', '2', '-c:a', 'pcm_s16le', path.join(directory, 'narration.wav')]);
    const source = await probe(path.join(directory, 'source.mp4')), script = '维希缇双十一大促！拍一到手三大件只要99！';
    const segment = { index: 0, start: 0, frames: 90, duration: 3, requestDuration: 3, state: 'completed', audioChanged: true, dialogueIds: ['FULL001'] };
    const job = { workflow: 'studio', sourceFile: 'source.mp4', source, audioMode: 'narration', output: { width: 240, height: 426 }, narration: { file: 'narration.wav', duration: 2.8 }, recipe: { edits: { fullDialogue: { enabled: true, delivery: 'uploaded', subtitles: 'replace' } }, dialoguePlan: { spokenText: script } }, segments: [segment] };
    await normalizeResult(directory, job, segment); assert.equal((await probe(path.join(directory, 'segments', 'output-0.mp4'))).hasAudio, false);
    const info = await assemble(directory, job); assert.equal(info.frames, 90); assert.equal(info.hasAudio, true);
    const file = path.join(directory, 'result.mp4'), energy = await audioProjection(file, directory, [500, 700, 900]);
    assert.ok(energy[900] > 0.05); assert.ok(energy[900] > energy[500] * 100 && energy[900] > energy[700] * 100, JSON.stringify(energy));
    assert.ok((await audioProjection(file, directory, [900], 2.55, 0.2))[900] > 0.05, 'end of narration must survive assembly');
    const ass = await readFile(path.join(directory, 'captions.ass'), 'utf8');
    assert.match(ass, /维希缇双十一大促/); assert.match(ass, /三大件只要99/); assert.doesNotMatch(ass, /129|七件|JOVISSE/);
    const image = path.join(directory, 'caption.gray'); await ffmpeg(['-ss', '0.5', '-i', file, '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', image]);
    const pixels = await readFile(image); assert.ok([...pixels.subarray(240 * 180)].filter(pixel => pixel > 220).length > 30, 'white subtitle glyphs must actually render on the black video');
    const saved = await readFile(file);
    await assert.rejects(assemble(directory, { ...job, narration: { ...job.narration, duration: 3.2 } }), /超过视频长度|裁断/);
    assert.deepEqual(await readFile(file), saved, 'overlong narration must not replace an existing result');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
