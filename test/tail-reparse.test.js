import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { KeyVault } from '../src/keys.js';
import { AnalysisEngine } from '../src/analysis.js';
import { analysisWindows, emptyStory, emptyEdits } from '../src/story.js';

test('free local reparse recovers the saved 32.96-second tail with no key or provider and preserves all 11 lines', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), '.wan-tail-reparse-'));
  const store = new Store(directory), vault = new KeyVault(directory), duration = 32.166667;
  let providerCalls = 0, prepareCalls = 0;
  const engine = new AnalysisEngine({ store, vault, directory,
    providerFactory: () => { providerCalls++; throw new Error('A local recovery must never call a paid provider'); },
    prepareVideo: () => { prepareCalls++; throw new Error('A local recovery must never encode or upload'); },
  });
  try {
    const raw = { summary: '片尾失败后免费恢复', characters: [{ id: 'C001', name: '讲解者' }], scenes: [], props: [],
      shots: [{ start: 0, end: duration, summary: '原片', characterIds: ['C001'], propIds: [] }],
      dialogues: [...Array.from({ length: 10 }, (_, i) => ({ start: i * 3, end: i * 3 + 2, text: `第 ${i + 1} 句原文。`, characterId: 'C001', uncertain: false })),
        { start: 31.36, end: 32.96, text: '第 11 句原文，必须完整保留。', characterId: 'C001', uncertain: false }], warnings: [] };
    const project = { id: 'tail-reparse', created: new Date().toISOString(), revision: 0, source: { duration }, keyHash: 'previous-account-key-hash',
      state: 'analysis_attention', error: '台词超出旧 0.500 秒容错', story: emptyStory(), edits: emptyEdits(), analysis: { windows: analysisWindows(duration) } };
    const responseFile = 'analysis/response-0-1.json';
    Object.assign(project.analysis.windows[0], { state: 'parse_error', attempts: 1, responseFile, errorCode: 'analysis_timing',
      responseId: 'saved-tail-response', usage: { total_tokens: 6750 }, error: project.error });
    store.createProject(project);
    await mkdir(path.join(directory, 'projects', project.id, 'analysis'), { recursive: true });
    const file = path.join(directory, 'projects', project.id, responseFile);
    const receipt = JSON.stringify({ complete: true, text: JSON.stringify(raw), responseId: 'saved-tail-response', usage: { total_tokens: 6750 } });
    await writeFile(file, receipt);
    assert.equal(vault.status().configured, false);
    const result = await engine.reparse(project.id), tail = result.story.dialogues.at(-1);
    assert.equal(result.state, 'ready'); assert.equal(result.error, null); assert.equal(result.revision, 1);
    assert.equal(result.story.dialogues.length, 11); assert.deepEqual(result.story.dialogues.map(line => line.text), raw.dialogues.map(line => line.text));
    assert.equal(tail.end, duration); assert.equal(tail.start, 31.36); assert.equal(tail.uncertain, true);
    assert.equal(tail.timingAdjustment.reason, 'tail_boundary_clamp'); assert.equal(tail.timingAdjustment.originalEnd, 32.96);
    assert.equal(result.analysis.windows[0].attempts, 1); assert.equal(result.analysis.windows[0].state, 'completed');
    assert.equal(result.analysis.windows[0].responseId, 'saved-tail-response'); assert.deepEqual(result.analysis.windows[0].usage, { total_tokens: 6750 });
    assert.equal(result.analysis.lastLocalReparse.timingCorrections, 1); assert.equal(result.analysis.lastLocalReparse.complete, true);
    assert.equal(await readFile(file, 'utf8'), receipt); assert.equal(providerCalls, 0); assert.equal(prepareCalls, 0);
    const again = await engine.reparse(project.id);
    assert.equal(again.story.dialogues.length, 11); assert.equal(again.revision, result.revision);
    assert.equal(providerCalls, 0); assert.equal(prepareCalls, 0);
  } finally {
    engine.stop(); store.close(); await rm(directory, { recursive: true, force: true });
  }
});
