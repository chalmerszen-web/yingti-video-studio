import test from 'node:test';
import assert from 'node:assert/strict';
import { contentExpectation, normalizeSpokenText, normalizeSpeechReview, normalizeSubtitleReview, normalizeProductReview, normalizeMaterialReview, contentReviewState, auditFullSpeech, QUALITY_VERSION, QUALITY_KINDS } from '../src/content-review.js';
import { normalizeQuality } from '../src/quality.js';

const window = { start: 0, duration: 10, coreStart: 0, coreDuration: 10 };
function fixture() {
  return { recipe: { story: { assets: [{ id: 'P001', type: 'prop', name: 'JOVISSE面霜瓶' }, { id: 'P002', type: 'prop', name: '产品包装盒' }], dialogues: [], shots: [], actions: [] }, edits: { assets: { P001: { main: { file: 'jar.jpg' } }, P002: { main: { file: 'box.jpg' } } }, fullDialogue: { enabled: true }, dialogues: [] } }, contentContract: { brands: ['维希缇'], criticalTerms: ['三大件'] }, quality: { referenceAssetIds: ['P001', 'P002'] }, segments: [{ index: 0, start: 0, duration: 10, dialogueLines: [{ id: 'FULL001', start: 0, end: 9, text: '维希缇双十一福利大促！拍一到手三大件，这么多只要99！' }] }] };
}
const expected = () => contentExpectation(fixture(), window);
const speech = (text, extra = {}) => ({ audioAvailable: true, heardText: text, confidence: 'high', coverage: 'complete', observations: [{ start: 0.5, end: 9, text, confidence: 'high' }], ...extra });
const modelCheck = kind => ({ kind, status: 'pass', time: null, detail: '模型声称通过' });

test('strict speech comparison accepts spoken Chinese digits but rejects changed offers and homophones', () => {
  const e = expected();
  assert.equal(normalizeSpeechReview(speech('维希缇双十一福利大促，拍一到手三大件，这么多只要九十九。'), e, window).status, 'pass');
  const wrong = normalizeSpeechReview(speech('洁薇丝双十一福利大促，拍一到手七件，这么多只要一百二十九。'), e, window);
  assert.equal(wrong.status, 'fail'); assert.match(wrong.detail, /数字发生变化/); assert.deepEqual(wrong.criticalMismatches, ['维希缇', '三大件']);
  assert.equal(normalizeSpeechReview(speech(e.text.replace('维希缇', '维希提')), e, window).status, 'fail');
  assert.equal(normalizeSpokenText('99.9'), normalizeSpokenText('九十九点九'));
  assert.notEqual(normalizeSpokenText('99.9'), normalizeSpokenText('999'));
  assert.notEqual(normalizeSpokenText('三两下'), normalizeSpokenText('三十二下'));
});

test('a copied expected script without independent complete timed hearing cannot pass', () => {
  const e = expected();
  for (const extra of [{ audioAvailable: false }, { confidence: 'medium' }, { coverage: 'partial' }, { observations: [] }]) assert.equal(normalizeSpeechReview(speech(e.text, extra), e, window).status, 'uncertain');
  assert.equal(normalizeSpeechReview(speech(e.text, { observations: [{ start: 0, end: 9, text: '原台词', confidence: 'high' }] }), e, window).status, 'uncertain');
  assert.equal(normalizeSpeechReview(speech('错误正文', { confidence: 'low' }), e, window).status, 'uncertain');
});

test('core range excludes neighboring speech and refuses partial boundary lines', () => {
  const job = fixture();
  const core = { start: 9.4, duration: 5.6, coreStart: 10, coreDuration: 5 };
  job.segments.push({ index: 1, start: 10, duration: 5, dialogueLines: [{ id: 'FULL002', start: 10.2, end: 14.5, text: '快去直播间抢购吧！' }] });
  const e = contentExpectation(job, core); assert.equal(e.localStart, 0.5999999999999996); assert.equal(e.text, '快去直播间抢购吧！');
  const observed = speech(e.text, { observations: [{ start: 0.8, end: 5.1, text: e.text, confidence: 'high' }] });
  assert.equal(normalizeSpeechReview(observed, e, core).status, 'pass');
  job.segments[1].dialogueLines[0].start = 9.8;
  const partial = contentExpectation(job, core); assert.equal(partial.partial, true); assert.equal(normalizeSpeechReview(observed, partial, core).status, 'uncertain');
});

test('wrong burned-in brand, bundle count and price fail independently of the requested prompt', () => {
  const e = expected();
  for (const text of ['JOVISSE洁薇丝', '拍一到手七件', '这么多只要129']) {
    const check = normalizeSubtitleReview({ visible: true, confidence: 'high', coverage: 'complete', observations: [{ time: 4, text, confidence: 'high' }] }, e, window, modelCheck('subtitles'));
    assert.equal(check.status, 'fail'); assert.equal(check.time, 4);
  }
  const uncertain = normalizeSubtitleReview({ confidence: 'low', coverage: 'partial', observations: [{ time: 4, text: 'JOVISSE', confidence: 'low' }] }, e, window, modelCheck('subtitles'));
  assert.equal(uncertain.status, 'uncertain');
});

test('products inspect bag contents and mixed jar-box instances against actual reference images', () => {
  const e = expected();
  const observation = { time: 6, assetId: 'P002', context: 'bag_contents', status: 'old_product', confidence: 'high', detail: '透明袋内仍为原蓝色JOVISSE盒子，目标参考为紫色盒' };
  const fail = normalizeProductReview({ visible: true, confidence: 'high', coverage: 'complete', observations: [observation] }, e, window, modelCheck('products'));
  assert.equal(fail.status, 'fail'); assert.equal(fail.time, 6); assert.match(fail.detail, /袋内/);
  const matched = { ...observation, status: 'matched', detail: '瓶罐、包装、袋内及背景实例逐镜头均与目标图相符' };
  const raw = { visible: true, confidence: 'high', coverage: 'complete', observations: [matched], assetCoverage: [{ assetId: 'P001', visibility: 'absent', confidence: 'high', detail: '左右本镜头均为袋内盒子，没有单独瓶罐或背景罐子' }, { assetId: 'P002', visibility: 'visible', confidence: 'high', detail: '逐一核对袋内所有盒子及包装' }] };
  assert.equal(normalizeProductReview(raw, e, window, modelCheck('products')).status, 'pass');
  assert.equal(normalizeProductReview(raw, { ...e, referenceAssetIds: [] }, window, modelCheck('products')).status, 'uncertain');
  assert.equal(normalizeProductReview({ ...raw, coverage: 'partial' }, e, window, modelCheck('products')).status, 'uncertain');
  assert.equal(normalizeProductReview({ ...raw, assetCoverage: [] }, e, window, modelCheck('products')).status, 'uncertain');
  assert.equal(normalizeProductReview({ ...raw, observations: [{ ...matched, status: 'mixed', confidence: 'low' }] }, e, window, modelCheck('products')).status, 'uncertain');
});

test('an empty scene needs complete observed evidence to mark product checks not applicable', () => {
  const check = { ...modelCheck('products'), status: 'not_applicable' }, e = expected();
  const raw = { visible: false, confidence: 'high', coverage: 'complete', observations: [] };
  assert.equal(normalizeProductReview(raw, e, window, check).status, 'uncertain');
  assert.equal(normalizeProductReview({ ...raw, absenceEvidence: '左右整个区间都是面部近景，没有瓶罐、盒子、提袋或背景陈列。' }, e, window, check).status, 'not_applicable');
});

test('six model passes cannot bypass missing speech, subtitle or product observations', () => {
  const result = normalizeQuality({ checks: QUALITY_KINDS.map(modelCheck) }, window, fixture());
  assert.deepEqual(result.slice(3).map(c => c.status), ['uncertain', 'uncertain', 'uncertain']);
});

test('legacy, pending and incomplete reviews remain unverified and issues never launch a retry', () => {
  const results = QUALITY_KINDS.map(modelCheck);
  const job = { quality: { version: QUALITY_VERSION, state: 'completed', windows: [{ state: 'completed', result: results }] } };
  assert.equal(contentReviewState(job).state, 'passed');
  job.quality.version = 1; assert.equal(contentReviewState(job).state, 'unverified');
  job.quality.version = QUALITY_VERSION; job.quality.windows[0].result = results.slice(0, 3); assert.equal(contentReviewState(job).state, 'unverified');
  job.quality.windows[0].result = results.map(c => c.kind === 'products' ? { ...c, status: 'fail', time: 6 } : c); assert.equal(contentReviewState(job).state, 'issues');
  assert.equal(job.quality.windows[0].attempts, undefined);
  job.quality.state = 'running'; assert.equal(contentReviewState(job).state, 'unverified');
});

function voiceFixture(delivery = 'voiceover') {
  const job = fixture(), text = job.segments[0].dialogueLines[0].text;
  job.recipe.edits.fullDialogue = { enabled: true, delivery, text };
  job.segments = [{ index: 0, start: 0, duration: 5, frames: 150, dialogueLines: [{ id: 'FULL001', start: 0, end: 4.9, text: '维希缇双十一福利大促！' }] }, { index: 1, start: 5, duration: 5, frames: 150, dialogueLines: [{ id: 'FULL002', start: 5, end: 9.9, text: '拍一到手三大件，这么多只要99！' }] }];
  const windows = [{ index: 0, start: 0, duration: 5.6, coreStart: 0, coreDuration: 5, state: 'completed' }, { index: 1, start: 4.4, duration: 5.6, coreStart: 5, coreDuration: 5, state: 'completed' }];
  const heard = ['维希缇双十一福利大促拍一', '到手三大件这么多只要九十九'];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i], e = contentExpectation(job, w), local = e.localStart;
    w.result = [normalizeSpeechReview(speech(heard[i], { observations: [{ start: local, end: e.localEnd, text: heard[i], confidence: 'high' }] }), e, w)];
  }
  return { job, windows, heard };
}

test('independent voiceover and uploaded tracks verify the actual full script across estimated sentence boundaries', () => {
  for (const delivery of ['voiceover', 'uploaded']) {
    const { job, windows } = voiceFixture(delivery);
    assert.deepEqual(windows.map(w => w.result[0].status), ['uncertain', 'uncertain']);
    assert.equal(auditFullSpeech(job, windows).status, 'pass');
    assert.equal(auditFullSpeech(job, windows).expectedText, job.recipe.edits.fullDialogue.text);
  }
});

test('independent full speech detects omitted words, changed99/129 and repeated context without new calls', () => {
  for (const wrong of ['到手三大件这么多只要一百二十九', '到手三件这么多只要九十九', '拍一到手三大件这么多只要九十九']) {
    const { job, windows } = voiceFixture();
    const w = windows[1], e = contentExpectation(job, w);
    w.result = [normalizeSpeechReview(speech(wrong, { observations: [{ start: e.localStart, end: e.localEnd, text: wrong, confidence: 'high' }] }), e, w)];
    const audit = auditFullSpeech(job, windows); assert.equal(audit.status, 'fail'); assert.equal(audit.time, 5);
  }
  const { job, windows, heard } = voiceFixture();
  const e = contentExpectation(job, windows[1]);
  windows[1].result = [normalizeSpeechReview(speech(heard[1], { observations: [{ start: 0, end: e.localEnd, text: heard[1], confidence: 'high' }] }), e, windows[1])];
  assert.equal(auditFullSpeech(job, windows).status, 'uncertain');
});

test('full speech audit cannot pass with missing hearing coverage, gaps or an omitted aggregate result', () => {
  const { job, windows } = voiceFixture();
  windows[1].result[0].auditReady = false; assert.equal(auditFullSpeech(job, windows).status, 'uncertain');
  windows[1].result[0].auditReady = true; windows[1].coreStart = 5.2; assert.equal(auditFullSpeech(job, windows).status, 'uncertain');
  job.quality = { version: QUALITY_VERSION, state: 'completed', windows: [{ state: 'completed', result: QUALITY_KINDS.map(modelCheck) }] };
  assert.equal(contentReviewState(job).state, 'unverified');
});

const materialWindow = { start: 13, duration: 5, coreStart: 13, coreDuration: 5 };
function materialFixture(mode = 'auto') {
  const job = fixture();
  job.recipe.story.assets.push({ id: 'C001', type: 'character', name: '涂脸人物' });
  job.recipe.story.actions = [{ id: 'A_SMEAR', type: 'spread', start: 13, end: 17, characterId: 'C001', propId: null, region: '画面右侧脸颊', before: '脸颊已有白色厚膏块', after: '白色厚膏被指腹推开为薄层', contact: '手指持续接触皮肤已有膏体', motion: '从鼻翼向脸颊外侧推开', evidence: '指腹接触已有膏体并向外推开，膏体铺展变薄', confidence: 'high' }];
  job.recipe.edits.continuity = { actions: { A_SMEAR: mode } };
  return job;
}
function materialEvidence(extra = {}) {
  return { visible: true, confidence: 'high', coverage: 'complete', actionCoverage: [{ actionId: 'A_SMEAR', visibility: 'visible', continuityEvidence: 'same_shot', confidence: 'high', detail: '起点13秒、指腹经过及17秒收手后的脸颊均清楚可见' }], observations: [
    { actionId: 'A_SMEAR', time: 0, phase: 'entry', sourceState: 'thick', generatedState: 'thick', contact: 'not_applicable', progression: 'not_applicable', confidence: 'high', detail: '左右脸颊均有可见厚白块，指腹尚未推过该区域' },
    { actionId: 'A_SMEAR', time: 1, phase: 'during', sourceState: 'thick', generatedState: 'thick', contact: 'continuous', progression: 'spreading', confidence: 'high', detail: '指腹接触并开始向外推，覆盖更广且接触路径边缘变薄，未经过处仍留厚膏' },
    { actionId: 'A_SMEAR', time: 2, phase: 'during', sourceState: 'thin', generatedState: 'thin', contact: 'continuous', progression: 'spreading', confidence: 'high', detail: '指腹接触并向外推，接触路径覆盖更广且边缘变薄，未经过处仍留厚膏' },
    { actionId: 'A_SMEAR', time: 3, phase: 'during', sourceState: 'thin', generatedState: 'thin', contact: 'continuous', progression: 'spreading', confidence: 'high', detail: '指腹保持接触并完成最后向外推的动作，厚边界持续变薄' },
    { actionId: 'A_SMEAR', time: 4, phase: 'exit', sourceState: 'thin', generatedState: 'thin', contact: 'not_applicable', progression: 'not_applicable', confidence: 'high', detail: '收手后左右脸颊均为连续薄层，已推过区域没有固定厚白块' },
  ], ...extra };
}
const materialExpected = (mode = 'auto') => contentExpectation(materialFixture(mode), materialWindow);
const materialCheck = () => modelCheck('material');

test('a historical b111-style generic material pass cannot bypass absent timed observations', () => {
  const e = materialExpected();
  assert.equal(normalizeMaterialReview(undefined, e, materialWindow, { ...materialCheck(), detail: '面霜自然推开，接触真实' }).status, 'uncertain');
  assert.equal(normalizeMaterialReview({ visible: true, confidence: 'high', coverage: 'complete', observations: [] }, e, materialWindow, materialCheck()).status, 'uncertain');
  const result = normalizeQuality({ checks: QUALITY_KINDS.map(modelCheck) }, materialWindow, materialFixture());
  assert.equal(result.find(c => c.kind === 'material').status, 'uncertain');
});

test('source endpoint thin at17 and generated thick is a localized failure regardless of a model pass', () => {
  const raw = materialEvidence(), end = raw.observations.at(-1); end.generatedState = 'thick'; end.detail = '左侧17秒收手已薄匀，右侧脸颊仍为原形厚白块';
  const result = normalizeMaterialReview(raw, materialExpected(), materialWindow, materialCheck());
  assert.equal(result.status, 'fail'); assert.equal(result.time, 17); assert.match(result.detail, /仍有厚膏块/);
});

test('clear entry, visible spreading and matching finish evidence can pass without white-area math', () => {
  const result = normalizeMaterialReview(materialEvidence(), materialExpected(), materialWindow, materialCheck());
  assert.equal(result.status, 'pass'); assert.equal(result.observations.length, 5); assert.equal(result.observations[2].time, 15);
  assert.match(result.observations[1].detail, /覆盖更广/);
});

test('source preservation and reviewed thin-finish override compare distinct endpoints', () => {
  const raw = materialEvidence(), end = raw.observations.at(-1); end.sourceState = 'thick'; end.generatedState = 'thick';
  end.detail = '原片结束时仅局部推开，左右仍有未推到的厚膏';
  assert.equal(normalizeMaterialReview(raw, materialExpected(), materialWindow, materialCheck()).status, 'pass');
  assert.equal(normalizeMaterialReview(raw, materialExpected('spread_finish'), materialWindow, materialCheck()).status, 'fail');
  end.generatedState = 'thin';
  assert.equal(normalizeMaterialReview(raw, materialExpected(), materialWindow, materialCheck()).status, 'fail');
  assert.equal(normalizeMaterialReview(raw, materialExpected('spread_finish'), materialWindow, materialCheck()).status, 'pass');
});

test('unseen endpoint, missing contact, incomplete coverage or a distant endpoint never proves spreading complete', () => {
  for (const change of [
    raw => { raw.observations.pop(); },
    raw => { raw.observations.at(-1).time = 3; },
    raw => { raw.observations.at(-1).generatedState = 'occluded'; },
    raw => { raw.observations[1].contact = 'occluded'; },
    raw => { raw.observations[1].progression = 'uncertain'; },
    raw => { raw.coverage = 'partial'; },
    raw => { raw.actionCoverage = []; },
    raw => { raw.observations.at(-1).confidence = 'medium'; },
  ]) { const raw = materialEvidence(); change(raw); assert.equal(normalizeMaterialReview(raw, materialExpected(), materialWindow, materialCheck()).status, 'uncertain'); }
});

test('fixed thick patches after contact and abrupt material errors fail without triggering paid retries', () => {
  for (const progression of ['static_patch', 'floating', 'disappeared', 'reappeared']) {
    const raw = materialEvidence(); raw.observations[1].progression = progression; raw.observations[1].detail = '手指推过脸颊后厚块原形未变或出现无对应接触的异常';
    const result = normalizeMaterialReview(raw, materialExpected(), materialWindow, materialCheck());
    assert.equal(result.status, 'fail'); assert.equal(result.time, 14); assert.equal(result.attempts, undefined);
  }
});

test('disabled actions and unrelated face observations cannot invent a material pass', () => {
  const e = materialExpected('off'); assert.deepEqual(e.materialActions, []);
  assert.equal(normalizeMaterialReview(materialEvidence(), e, materialWindow, materialCheck()).status, 'uncertain');
  assert.equal(normalizeMaterialReview({ visible: false, confidence: 'high', coverage: 'complete', observations: [], absenceEvidence: '左右整个区间没有涂抹或膏体残留' }, e, materialWindow, materialCheck()).status, 'not_applicable');
  const raw = materialEvidence(); raw.observations[1].actionId = 'OTHER_FACE';
  assert.equal(normalizeMaterialReview(raw, materialExpected(), materialWindow, materialCheck()).status, 'uncertain');
});

test('version2 reviews lack material observation coverage and remain historical unverified', () => {
  assert.equal(contentReviewState({ quality: { version: 2, state: 'completed', windows: [{ state: 'completed', result: QUALITY_KINDS.map(modelCheck) }] } }).state, 'unverified');
});

test('a source jump cut to clean skin is not proof of continuous cream spreading', () => {
  for (const continuityEvidence of ['cut', 'occluded', 'uncertain', undefined]) {
    const raw = materialEvidence(); raw.actionCoverage[0].continuityEvidence = continuityEvidence;
    assert.equal(normalizeMaterialReview(raw, materialExpected(), materialWindow, materialCheck()).status, 'uncertain');
  }
  const sparse = materialEvidence(); sparse.observations = sparse.observations.filter(item => [0, 2, 4].includes(item.time));
  assert.equal(normalizeMaterialReview(sparse, materialExpected(), materialWindow, materialCheck()).status, 'uncertain');
  const outside = materialEvidence(); outside.observations[0].time = 4.5;
  assert.equal(normalizeMaterialReview(outside, materialExpected(), materialWindow, materialCheck()).status, 'uncertain');
});

test('cut-after display still fails a thick patch at17 even when the final frame happens to be clean', () => {
  const e = { materialActions: [{ id: 'DISPLAY', type: 'residue', localStart: 3, localEnd: 5, region: '面部', exit: { kind: 'observed' } }] };
  const raw = { visible: true, confidence: 'high', coverage: 'complete', actionCoverage: [{ actionId: 'DISPLAY', visibility: 'visible', continuityEvidence: 'not_applicable', confidence: 'high', detail: '独立查看切后面部，不将此镜头当连续推开' }], observations: [
    { actionId: 'DISPLAY', time: 3.01, phase: 'entry', sourceState: 'none', generatedState: 'thin', contact: 'not_applicable', progression: 'not_applicable', confidence: 'high', detail: '切后两侧均无明显厚块' },
    { actionId: 'DISPLAY', time: 4, phase: 'during', sourceState: 'none', generatedState: 'thick', contact: 'not_applicable', progression: 'not_applicable', confidence: 'high', detail: '原片17秒额头无可见厚膏，生成片额头有固定厚块' },
    { actionId: 'DISPLAY', time: 4.97, phase: 'exit', sourceState: 'none', generatedState: 'none', contact: 'not_applicable', progression: 'not_applicable', confidence: 'high', detail: '最后时刻未见厚块' },
  ] };
  const result = normalizeMaterialReview(raw, e, materialWindow, materialCheck());
  assert.equal(result.status, 'fail'); assert.equal(result.time, 17); assert.match(result.detail, /展示状态不一致/);
});

test('normal hand withdrawal at a clear completed exit is not a contact-loss error', () => {
  const raw = materialEvidence(), end = raw.observations.at(-1);
  end.contact = 'lost'; end.detail = '左右指腹均已完成推开并自然收手，接触终止后脸颊薄层清晰可见，没有厚块';
  assert.equal(normalizeMaterialReview(raw, materialExpected(), materialWindow, materialCheck()).status, 'pass');
  end.generatedState = 'thick'; end.detail = '生成片虽已收手，但原片薄匀而生成片仍有厚白片';
  const thick = normalizeMaterialReview(raw, materialExpected(), materialWindow, materialCheck());
  assert.equal(thick.status, 'fail'); assert.match(thick.detail, /仍有厚膏块/);
});

test('contact loss during the required spreading process remains an independently localized failure', () => {
  for (const phase of ['entry', 'during']) {
    const raw = materialEvidence(), row = raw.observations.find(item => item.phase === phase);
    row.contact = 'lost'; row.detail = '原片对应时刻指腹保持接触，生成片手离开膏体，厚膏缺少真实接触';
    const result = normalizeMaterialReview(raw, materialExpected(), materialWindow, materialCheck());
    assert.equal(result.status, 'fail'); assert.equal(result.time, materialWindow.start + row.time); assert.match(result.detail, /接触或材料变化异常/);
  }
});
