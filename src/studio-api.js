import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, copyFile, readFile } from 'node:fs/promises';
import { AppError, invariant } from './errors.js';
import { studioUpload } from './studio-upload.js';
import { analysisWindows, emptyStory, emptyEdits, validateEdits, planStudio, studioPrompt } from './story.js';
import { publicProject, publicJob } from './store.js';
import { probe, prepareImage, prepareVoice, prepareViews, outputDimensions, previewFrame } from './media.js';
import { CHARACTER_EDIT_POLICY } from '../public/character-edit.js';
import { VocalignProvider } from './provider.js';
import { inspectNarrationAudio } from './narration.js';
import { ffmpeg } from './media.js';
import { QUALITY_VERSION } from './content-review.js';
import { CONTINUITY_VERSION } from './continuity.js';
import { fullDialogueScriptHash } from './full-dialogue.js';
import { fileSHA256 } from './file-hash.js';
import { propRole } from '../public/prop-role.js';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
function contained(root, relative) {
  const file = path.resolve(root, relative);
  invariant(file.startsWith(path.resolve(root) + path.sep), '文件路径不正确。'); return file;
}

export function studioRouter({ store, vault, directory, analysis, engine, toolsStatus, review }) {
  const router = express.Router(), busy = new Set(), frameTasks = new Map();
  const dir = id => path.join(directory, 'projects', id);
  const view = project => ({ ...publicProject(project), keyMatches: vault.hash() === project.keyHash, active: analysis.active === project.id });
  const editable = id => {
    const project = store.project(id); invariant(project.state === 'ready', '视频分析完成后才能编辑资产和台词。', 409); return project;
  };
  router.get('/projects', (req, res) => res.json(store.projects().map(view)));
  router.get('/projects/:id', (req, res) => res.json(view(store.project(req.params.id))));
  router.get('/voices', async (req, res) => { res.json(await new VocalignProvider(vault.require()).listVoices()); });
  router.post('/projects/:id/narration', async (req,res) => {
    const project=editable(req.params.id);
    invariant(project.edits.fullDialogue?.enabled && project.edits.fullDialogue.text.trim(),'请先保存完整新稿，再导入对应的整篇录音。',422);
    invariant(!busy.has(project.id), '请等待当前保存或导入完成。',409);
    busy.add(project.id);
    const relative=path.join('narration',randomUUID()), destination=contained(dir(project.id),relative);
    let saved=false;
    try {
      await mkdir(destination,{recursive:true});
      const {files}=await studioUpload(req,destination,{kind:'audio',fields:[]});
      const raw=contained(destination,files[0].file), info=await inspectNarrationAudio(raw);
      invariant(info.duration<=project.source.duration+0.001,'整篇配音比原视频长，请调整录音或视频长度；不会自动截断台词。',422);
      const file=path.join(relative,'audio.wav');
      await ffmpeg(['-xerror','-protocol_whitelist','file,pipe','-i',raw,'-map','0:a:0','-vn','-af','asetpts=PTS-STARTPTS','-ar','48000','-ac','2','-c:a','pcm_s16le',contained(dir(project.id),file)]);
      res.json(view(store.updateProject(project.id,p=>{p.edits.narration={file,duration:info.duration,names:[files[0].name],scriptHash:fullDialogueScriptHash(project),revision:p.revision+1};p.revision++;}))); saved=true;
    } finally { if(!saved)await rm(destination,{recursive:true,force:true});busy.delete(project.id); }
  });
  router.get('/projects/:id/narration/media',(req,res)=>{
    const project=store.project(req.params.id); invariant(project.edits.narration?.file,'尚未导入整篇配音。',404);
    res.sendFile(contained(dir(project.id),project.edits.narration.file),{dotfiles:'allow'});
  });
  router.delete('/projects/:id/narration',(req,res)=>{
    const project=editable(req.params.id);invariant(!busy.has(project.id),'请等待当前导入或保存完成。',409);
    res.json(view(store.updateProject(project.id,p=>{delete p.edits.narration;p.revision++;})));
  });
  router.post('/projects', async (req, res) => {
    vault.require(); invariant(toolsStatus.ffmpeg && toolsStatus.ffprobe, 'FFmpeg / FFprobe 未就绪。', 503);
    const id = req.get('x-project-request-id') || randomUUID(); invariant(uuid(id), '导入请求编号无效。');
    const old = store.projects().find(p => p.id === id);
    if (old) { vault.require(old.keyHash); req.resume(); return res.json(view(old)); }
    invariant(!busy.has(id), '同一视频正在导入。', 409); busy.add(id);
    const temporary = path.join(directory, 'incoming', 'project-' + id), destination = dir(id), keyHash = vault.hash();
    let moved = false, saved = false;
    try {
      await mkdir(temporary, { recursive: true });
      const { files, fields } = await studioUpload(req, temporary);
      invariant((fields.title || '').length <= 100, '项目名称不能超过 100 字。');
      const source = await probe(path.join(temporary, files[0].file));
      invariant(/(?:mov|mp4|matroska|webm|avi)/.test(source.format), '文件内容不是受支持的视频容器。');
      invariant(source.width <= 8192 && source.height <= 8192 && Math.max(source.width / source.height, source.height / source.width) <= 8, '原视频尺寸或宽高比超出支持范围。');
      const windows = analysisWindows(source.duration); vault.require(keyHash);
      await mkdir(path.dirname(destination), { recursive: true }); await rename(temporary, destination); moved = true;
      const now = new Date().toISOString();
      const project = {
        id, created: now, updated: now, title: fields.title?.trim() || files[0].name, sourceName: files[0].name, sourceFile: files[0].file, sourceBytes: files[0].bytes, source,
        keyHash, state: 'analysis_queued', phase: '等待 Omni-Analysis 分析', revision: 0, analysis: { model: 'Omni-Analysis', windows }, story: emptyStory(), edits: emptyEdits(), error: null,
      };
      store.createProject(project); saved = true; res.status(201).json(view(project)); analysis.pump();
    } finally {
      if (!saved) await rm(moved ? destination : temporary, { recursive: true, force: true }); busy.delete(id);
    }
  });
  router.post('/projects/:id/analysis/resume', (req, res) => { analysis.resume(req.params.id); res.json(view(store.project(req.params.id))); });
  router.post('/projects/:id/actions', (req, res) => {
    invariant(review && req.body?.confirmAnalysis === true, '请确认补充动作分析将使用 Omni-Analysis 用量。');
    res.json(view(review.enqueue('actions', req.params.id)));
  });
  router.post('/projects/:id/actions/reparse', async (req, res) => { invariant(review, '检查服务未就绪。'); res.json(view(await review.reparse('actions', req.params.id))); });
  router.post('/projects/:id/actions/resume', (req, res) => { invariant(review, '检查服务未就绪。'); review.resume('actions', req.params.id); res.json(view(store.project(req.params.id))); });
  router.post('/projects/:id/actions/:index/retry', (req, res) => { invariant(review && /^\d+$/.test(req.params.index), '检查分段无效。'); review.retry('actions', req.params.id, Number(req.params.index), req.body?.verifiedPrevious === true && req.body?.confirmAnalysis === true); res.json(view(store.project(req.params.id))); });
  router.post('/projects/:id/analysis/reparse', async (req, res) => { res.json(view(await analysis.reparse(req.params.id))); });
  router.post('/projects/:id/analysis/:index/retry', (req, res) => {
    invariant(/^\d+$/.test(req.params.index), '分析分段无效。');
    analysis.retry(req.params.id, Number(req.params.index), req.body?.confirmNewCharge === true && req.body?.verifiedPrevious === true);
    res.json(view(store.project(req.params.id)));
  });
  router.get('/projects/:id/analysis/:index/raw', async (req, res) => {
    const project = store.project(req.params.id), part = project.analysis.windows[Number(req.params.index)];
    invariant(part?.responseFile, '尚未获得分析文本。', 404);
    let content;
    try { content = JSON.parse(await readFile(contained(dir(project.id), part.responseFile), 'utf8')); }
    catch { throw new AppError('仅保存了部分流式文字，请先核对本机 analysis 目录与平台记录。', 404); }
    res.type('text/plain').send(content.text);
  });
  router.put('/projects/:id/edits', (req, res) => {
    const project = editable(req.params.id);
    invariant(!busy.has(project.id), '正在导入素材或冻结版本，请等待完成后保存。',409);
    invariant(req.body?.revision === project.revision, '项目已有新修改，请刷新项目后再保存。', 409);
    const edits = validateEdits(project, req.body.edits);
    res.json(view(store.updateProject(project.id, p => { p.edits = edits; p.revision++; })));
  });
  router.post('/projects/:id/assets/:assetId/:slot', async (req, res) => {
    const project = editable(req.params.id), asset = project.story.assets.find(a => a.id === req.params.assetId), slot = req.params.slot;
    invariant(asset && (slot==='main' || ['views','voice'].includes(slot)&&asset.type==='character' || slot==='finish'&&asset.type==='prop'&&propRole(asset,project.edits.assets[asset.id])==='material'), '此资产不支持这种导入项。');
    invariant(!busy.has(project.id), '此项目还有素材正在保存，请稍候。', 409); busy.add(project.id);
    const revision = randomUUID(), relative = `assets/${revision}`, folder = contained(dir(project.id), relative);
    let saved = false;
    try {
      await mkdir(folder, { recursive: true });
      const { files,fields } = await studioUpload(req, folder, { kind: slot === 'voice' ? 'audio' : 'image', count: slot === 'views' ? 3 : 1, fields: slot==='finish'?['characterId']:[] });
      let binding;
      if(slot==='finish') {
        invariant(project.story.assets.some(a=>a.type==='character'&&a.id===fields.characterId),'请为薄匀终态图选择对应的人物。',422);
        const output=path.join(folder,'finish.png'), info=await prepareImage(path.join(folder,files[0].file),output);
        const actor=project.edits.assets[fields.characterId]||{};
        binding={...info,revision,file:`${relative}/finish.png`,names:files.map(f=>f.name),characterId:fields.characterId,actorReference:{main:actor.main?.file||null,views:actor.views?.file||null}};
      } else if (slot === 'voice') {
        const info = await prepareVoice(path.join(folder, files[0].file), path.join(folder, 'voice.wav'), path.join(folder, 'voice-short.wav'));
        binding = { ...info, revision, file: `${relative}/voice.wav`, shortFile: `${relative}/voice-short.wav`, names: files.map(f => f.name) };
      } else {
        const output = path.join(folder, slot + '.png');
        const info = slot === 'views' ? await prepareViews(files.map(f => path.join(folder, f.file)), output) : await prepareImage(path.join(folder, files[0].file), output);
        binding = { ...info, revision, file: `${relative}/${slot}.png`, names: files.map(f => f.name) };
      }
      const updated = store.updateProject(project.id, p => { p.edits.assets[asset.id] ||= {}; p.edits.assets[asset.id][slot==='finish'?'materialFinish':slot] = binding; if(slot==='main')delete p.edits.assets[asset.id].uploadedImageRole; p.revision++; });
      saved = true; res.json(view(updated));
    } finally { if (!saved) await rm(folder, { recursive: true, force: true }); busy.delete(project.id); }
  });
  router.delete('/projects/:id/assets/:assetId/:slot', (req, res) => {
    const project = editable(req.params.id);
    invariant(!busy.has(project.id), '请等待当前素材保存。', 409);
    invariant(project.story.assets.some(a => a.id === req.params.assetId) && ['main', 'views', 'voice','finish'].includes(req.params.slot), '素材位置不正确。');
    res.json(view(store.updateProject(project.id, p => { if (p.edits.assets[req.params.assetId]) delete p.edits.assets[req.params.assetId][req.params.slot==='finish'?'materialFinish':req.params.slot]; if(req.params.slot==='main')delete p.edits.assets[req.params.assetId]?.uploadedImageRole; p.revision++; })));
  });
  router.post('/projects/:id/assets/:assetId/material/crop',async(req,res)=>{
    const project=editable(req.params.id),asset=project.story.assets.find(a=>a.id===req.params.assetId),main=project.edits.assets[req.params.assetId]?.main;
    invariant(asset&&propRole(asset,project.edits.assets[asset.id])==='material'&&main?.file,'请先为膏体材质导入来源图片。',422);
    invariant(req.body?.revision===project.revision,'项目已修改，请保存最新内容后再取样。',409);
    invariant(!busy.has(project.id),'请等待当前素材保存完成。',409);
    const revision=randomUUID(),relative=`assets/${revision}`,folder=contained(dir(project.id),relative);let saved=false;
    // Claim the project before any asynchronous read, so a second crop or
    // image upload cannot pass the same revision check while probe is running.
    busy.add(project.id);
    try {
      const unchanged = current => current.revision === project.revision && current.edits.assets[asset.id]?.main?.file === main.file;
      invariant(unchanged(store.project(project.id)), '来源图片或项目已修改，请重新选择膏体区域。',409);
      const info=await probe(contained(dir(project.id),main.file)), rect=Object.fromEntries(['x','y','width','height'].map(k=>[k,Number(req.body[k])]));
      invariant(Object.values(rect).every(Number.isInteger)&&rect.x>=0&&rect.y>=0&&rect.width>=24&&rect.height>=24&&rect.x+rect.width<=info.width&&rect.y+rect.height<=info.height&&Math.max(rect.width/rect.height,rect.height/rect.width)<=8,'请选择图片中有效的膏体区域，最小24像素，不含罐沿、包装或文字。',422);
      await mkdir(folder,{recursive:true});
      const scale=Math.max(240/Math.min(rect.width,rect.height),Math.min(1,2048/Math.max(rect.width,rect.height)));
      await ffmpeg(['-i',contained(dir(project.id),main.file),'-vf',`crop=${rect.width}:${rect.height}:${rect.x}:${rect.y},scale=${Math.round(rect.width*scale)}:${Math.round(rect.height*scale)}`,'-frames:v','1','-update','1',path.join(folder,'material.png')]);
      invariant(unchanged(store.project(project.id)), '来源图片或项目已修改，请重新选择膏体区域。',409);
      const result=store.updateProject(project.id,p=>{p.edits.assets[asset.id].main={...p.edits.assets[asset.id].main,materialFile:`${relative}/material.png`,cropRect:rect,materialRevision:revision};p.revision++;});saved=true;res.json(view(result));
    } finally {
      try {if(!saved)await rm(folder,{recursive:true,force:true});}
      finally {busy.delete(project.id);}
    }
  });
  router.get('/projects/:id/plan', (req, res) => {
    const project = editable(req.params.id), plan = planStudio(project);
    const recipe = { story: project.story, edits: project.edits, source: { duration: project.source.duration }, sourceCuts:project.sourceCuts||[], characterEditPolicy: CHARACTER_EDIT_POLICY, characterModes: plan.characterModes, dialoguePlan: plan.dialoguePlan };
    for (const segment of plan.segments) studioPrompt({ recipe }, segment);
    res.json({ ...plan, qualityCalls: project.edits.continuity?.autoReview !== false ? plan.segments.length : 0, segments: plan.segments.map(s => ({ index: s.index, start: s.start, duration: s.duration, requestDuration: s.requestDuration, audioChanged: s.audioChanged, characterModes: s.characterModes, cutReason: s.cutReason, boundaryRisk: s.boundaryRisk, images: s.bindings.filter(b => b.type === 'reference_image').length, voices: s.bindings.filter(b => b.type === 'reference_audio').length })) });
  });
  router.post('/projects/:id/generate', async (req, res) => {
    const project = editable(req.params.id); vault.require(project.keyHash);
    const id = req.body?.requestId; invariant(uuid(id), '生成请求编号无效。');
    const existing = store.list().find(j => j.id === id);
    if (existing) { invariant(existing.projectId === project.id, '生成请求不属于当前项目。', 409); return res.json(publicJob(existing)); }
    invariant(req.body?.revision === project.revision, '项目已修改，请保存最新内容再生成。', 409);
    invariant(!busy.has(project.id), '请等待素材上传或当前版本保存完成。', 409);
    const plan = planStudio(project); invariant(plan.hasChanges, '请至少导入一项替换素材、音色或修改一句台词。');
    invariant(!plan.blockers.length, plan.blockers.join('\n'), 422);
    const recipe = { story: structuredClone(project.story), edits: structuredClone(project.edits), source: { duration: project.source.duration }, sourceCuts:structuredClone(project.sourceCuts||[]), characterEditPolicy: CHARACTER_EDIT_POLICY, characterModes: structuredClone(plan.characterModes), dialoguePlan: structuredClone(plan.dialoguePlan) };
    for (const segment of plan.segments) segment.prompt = studioPrompt({ recipe }, segment);
    busy.add(project.id);
    const destination = path.join(directory, 'jobs', id); let saved = false;
    try {
      await mkdir(destination, { recursive: true });
      const sourceFile = 'source' + path.extname(project.sourceFile);
      await copyFile(contained(dir(project.id), project.sourceFile), path.join(destination, sourceFile));
      const sourceSHA256=await fileSHA256(path.join(destination,sourceFile));
      const refs = new Set(plan.segments.flatMap(s => s.bindings.map(b => b.file)));
      for(const asset of project.story.assets)if(propRole(asset,project.edits.assets[asset.id])==='material')for(const file of [project.edits.assets[asset.id]?.main?.file,project.edits.assets[asset.id]?.main?.materialFile])if(file)refs.add(file);
      if (plan.audioMode==='narration' && project.edits.fullDialogue.delivery==='uploaded') refs.add(project.edits.narration.file);
      const frozenFiles=[];
      for (const relative of refs) {
        const target = contained(destination, relative); await mkdir(path.dirname(target), { recursive: true }); await copyFile(contained(dir(project.id), relative), target);
        frozenFiles.push({file:relative,sha256:await fileSHA256(target)});
      }
      const cover = plan.segments.flatMap(s => s.bindings).find(b => b.type === 'reference_image');
      if (cover) await copyFile(contained(dir(project.id), cover.file), path.join(destination, 'reference.png'));
      else await previewFrame(path.join(destination, sourceFile), 0, path.join(destination, 'reference.png'));
      vault.require(project.keyHash);
      const now = new Date().toISOString();
      const job = {
        id, created: now, updated: now, projectId: project.id, projectRevision: project.revision, workflow: 'studio', title: project.title + ' · 资产与台词编辑',
        mode: 'studio', target: '', model: project.edits.model, keyHash: project.keyHash, sourceFile, sourceName: project.sourceName, sourceBytes: project.sourceBytes, sourceSHA256, frozenFiles, source: project.source,
        output: outputDimensions(project.source, project.edits.model), state: 'queued', phase: '等待按分镜生成', segments: plan.segments, audioMode: plan.audioMode,
        recipe, generationOptions: plan.generationOptions, warnings: plan.warnings, prepared: false, pauseRequested: false, error: null,
        continuityVersion: CONTINUITY_VERSION, quality: project.edits.continuity?.autoReview !== false ? { enabled: true, version: QUALITY_VERSION, state: 'waiting' } : null,
        events: [{ at: now, message: `已冻结资产与台词版本，计划 ${plan.segments.length} 段；${plan.audioMode === 'mixed' ? '修改声音的分段使用 WAN 新音轨' : '保留原音轨'}。` }],
      };
      store.create(job); saved = true; res.status(201).json(publicJob(job)); engine.pump();
    } finally { if (!saved) await rm(destination, { recursive: true, force: true }); busy.delete(project.id); }
  });
  router.get('/projects/:id/media/source', (req, res) => {
    const project = store.project(req.params.id); res.sendFile(contained(dir(project.id), project.sourceFile), { dotfiles: 'allow' });
  });
  router.get('/projects/:id/assets/:assetId/:slot/media', (req, res) => {
    const project = store.project(req.params.id);
    invariant(['main', 'views', 'voice','finish','material'].includes(req.params.slot), '素材不存在。', 404);
    const binding = project.edits.assets[req.params.assetId]?.[req.params.slot==='finish'?'materialFinish':req.params.slot==='material'?'main':req.params.slot]; invariant(binding?.file, '素材不存在。', 404);
    if(req.params.slot==='material'){invariant(binding.materialFile,'尚未选择膏体取样区域。',404);return res.sendFile(contained(dir(project.id),binding.materialFile),{dotfiles:'allow'});}
    res.sendFile(contained(dir(project.id), binding.file), { dotfiles: 'allow' });
  });
  router.get('/projects/:id/poster/:assetId', async (req, res) => {
    const project = store.project(req.params.id), asset = project.story.assets.find(a => a.id === req.params.assetId);
    invariant(asset, '资产不存在。', 404);
    const time = Math.max(0, Math.min(asset.firstSeen, project.source.duration - 0.04)), frame = Math.round(time * 30);
    const folder = path.join(dir(project.id), 'posters'); await mkdir(folder, { recursive: true });
    const output = path.join(folder, `frame-${frame}.jpg`);
    if (!frameTasks.has(output)) frameTasks.set(output, previewFrame(contained(dir(project.id), project.sourceFile), time, output).finally(() => frameTasks.delete(output)));
    await frameTasks.get(output); res.sendFile(output, { dotfiles: 'allow' });
  });
  router.get('/projects/:id/script', (req, res) => {
    const project = store.project(req.params.id);
    res.attachment('storyboard-' + project.id.slice(0, 8) + '.json').json({ source: project.sourceName, duration: project.source.duration, story: project.story, edits: project.edits });
  });
  return router;
}
