// Isolated browser QA only. This server never calls VocalignTech.
import path from 'node:path';
import { mkdir, mkdtemp, copyFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { KeyVault } from '../src/keys.js';
import { QueueEngine } from '../src/engine.js';
import { createApp } from '../src/server.js';
import { AnalysisEngine } from '../src/analysis.js';
import { demoProject } from '../public/studio-demo.js';
import { probe } from '../src/media.js';

const base = path.resolve('.test-output'); await mkdir(base, { recursive: true });
const directory = process.argv[2] ? path.resolve(process.argv[2]) : await mkdtemp(path.join(base, 'ui-session-'));
if (!directory.startsWith(base + path.sep)) throw new Error('UI tests must use .test-output only');
const store = new Store(directory), vault = new KeyVault(directory);
const uploads = new Map(), tasks = new Map();
const provider = {
  check: async () => ({ models: ['Omni-Analysis', 'wan3.0-720p', 'wan3.0-480p'] }),
  upload: async file => { const url = 'oss://qa/' + randomUUID(); uploads.set(url, file); return url; },
  analyzeVideo: async (url, prompt, onText) => {
    const duration = (await probe(uploads.get(url))).duration, factor = duration / 24;
    const story = demoProject().story;
    const raw = {
      summary: '独立界面测试返回的模拟脚本。此结果用于验证动态编辑流程，并非真实 Omni-Analysis 对色条视频的分析。',
      characters: story.assets.filter(a => a.type === 'character').map(a => ({ ...a, firstSeen: a.firstSeen * factor })),
      scenes: story.assets.filter(a => a.type === 'scene').map(a => ({ ...a, firstSeen: a.firstSeen * factor })),
      props: story.assets.filter(a => a.type === 'prop').map(a => ({ ...a, firstSeen: a.firstSeen * factor })),
      shots: story.shots.map(s => ({ ...s, start: s.start * factor, end: Math.min(duration, s.end * factor) })),
      dialogues: story.dialogues.map(l => ({ ...l, start: l.start * factor, end: l.end * factor })), warnings: [],
    };
    const text = JSON.stringify(raw); await onText(text.slice(0, 150)); await onText(text.slice(150));
    return { text, complete: true, usage: { total_tokens: 123 }, responseId: 'qa-analysis' };
  },
  create: async body => {
    const id = 'qa-simulated-' + randomUUID();
    tasks.set(id, { file: uploads.get(body.metadata.input.media[0].url), polls: 0 });
    return id;
  },
  status: async id => ({ status: ++tasks.get(id).polls > 2 ? 'completed' : 'in_progress' }),
  download: async (id, destination) => copyFile(tasks.get(id).file, destination),
};
const engine = new QueueEngine({ fundingGate: { ensure: async () => ({ state: 'approved' }) }, store, vault, directory, providerFactory: () => provider, pollInterval: 2500 });
const analysis = new AnalysisEngine({ store, vault, directory, providerFactory: () => provider });
const port = Number(process.env.WAN_EDITOR_QA_PORT || 3212);
let closing = false;
const shutdown = () => {
  if (closing) return; closing = true; engine.stop(); analysis.stop(); server.close(); server.closeIdleConnections();
  const timer = setInterval(() => { if (!engine.active && !analysis.active) { clearInterval(timer); store.close(); process.exit(0); } }, 100);
};
const app = createApp({ store, vault, engine, analysis, directory, port, toolsStatus: { ffmpeg: true, ffprobe: true, testing: true }, shutdown });
const server = app.listen(port, '127.0.0.1', () => { console.log(`Isolated mock UI test: http://127.0.0.1:${port}`); engine.start(); analysis.start(); });
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
