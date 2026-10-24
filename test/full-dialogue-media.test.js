import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ffmpeg, normalizeResult, probe } from '../src/media.js';

test('whole-script gaps may be silent but a spoken part may never silently lose its new audio', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), '.wan-script-silence-'));
  try {
    await mkdir(path.join(directory, 'segments'));
    await ffmpeg(['-f','lavfi','-i','color=c=blue:size=160x90:rate=30','-t','2','-an','-c:v','libx264',path.join(directory,'segments','generated-0.mp4')]);
    const job = { audioMode:'mixed', recipe:{edits:{fullDialogue:{enabled:true}}}, source:{hasAudio:true}, output:{width:160,height:90} };
    const segment = { index:0, start:0, frames:60, requestDuration:2, duration:2, audioChanged:true, dialogueIds:[] };
    const result = await normalizeResult(directory,job,segment);
    assert.equal(result.silentFullScriptGap,true);
    const output = path.join(directory,'segments','output-0.mp4'); assert.equal((await probe(output)).hasAudio,true);
    const pcm = path.join(directory,'silence.f32'); await ffmpeg(['-i',output,'-map','0:a:0','-ac','1','-ar','48000','-f','f32le',pcm]);
    const bytes = await readFile(pcm); let peak=0; for(let i=0;i<bytes.length;i+=4) peak=Math.max(peak,Math.abs(bytes.readFloatLE(i)));
    assert.equal(peak,0);
    await assert.rejects(normalizeResult(directory,job,{...segment,dialogueIds:['FULL001']}), /没有返回声音/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
