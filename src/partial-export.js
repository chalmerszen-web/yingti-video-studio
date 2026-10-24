import path from 'node:path';
import {mkdir,stat,writeFile,rename} from 'node:fs/promises';
import {ffmpeg,probe} from './media.js';
import {safeError} from './errors.js';
const exists=async f=>{try{return (await stat(f)).isFile();}catch(e){if(e.code==='ENOENT')return false;throw e;}};

/** Export only real completed downloads, in original order; never fill missing shots. */
export async function preparePartialExport(directory,job){
  const exportRoot=path.join(directory,'exports');await mkdir(exportRoot,{recursive:true});const clips=[],issues=[];
  for(const part of job.segments){
    try{
    const normalized=part.state==='completed',raw=part.downloaded===true;
    if(!normalized&&!raw)continue;
    const input=path.join(directory,'segments',`${normalized?'output':'generated'}-${part.index}.mp4`);
    if(!await exists(input))continue;
    const info=await probe(input);if(!info.frames||!info.duration)continue;
    const relative=`exports/clip-${part.index}.mp4`,target=path.join(directory,relative),temp=target+'.partial.mp4';
    const width=job.output?.width||info.width,height=job.output?.height||info.height;
    const args=['-xerror','-i',input];let audioInput=0,audioMissing=false;
    if(normalized&&job.audioMode!=='mixed'){
      let audio;
      if(job.audioMode==='narration'){
        if(job.narration?.file)audio=path.join(directory,job.narration.file);
        audioMissing=!audio||!await exists(audio);
      }else if(job.source?.hasAudio)audio=path.join(directory,'original-audio.wav');
      if(audio&&await exists(audio)){args.push('-ss',Number(part.start||0).toFixed(9),'-i',audio);audioInput=1;}
      else if(job.source?.hasAudio&&job.audioMode!=='narration'){
        // Saved source starts may differ from picture time. Preserve that offset.
        args.push('-i',path.join(directory,job.sourceFile));audioInput=1;
      } else {args.push('-f','lavfi','-i','anullsrc=r=48000:cl=stereo');audioInput=1;}
    }else if(!info.hasAudio){args.push('-f','lavfi','-i','anullsrc=r=48000:cl=stereo');audioInput=1;}
    args.push('-map','0:v:0','-map',`${audioInput}:a:0`,'-vf',`setpts=PTS-STARTPTS,fps=30,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`);
    let audioFilter='aresample=48000,asetpts=PTS-STARTPTS,apad';
    if(normalized&&audioInput===1&&job.source?.hasAudio&&job.audioMode!=='narration'&&!await exists(path.join(directory,'original-audio.wav'))){
      const offset=job.source.audioOffset||0,align=offset>0?`,adelay=${Math.round(offset*48000)}S:all=1`:offset<0?`,atrim=start=${(-offset).toFixed(9)},asetpts=PTS-STARTPTS`:'';
      audioFilter=`aresample=48000,asetpts=PTS-STARTPTS${align},atrim=start=${Number(part.start||0).toFixed(9)},asetpts=PTS-STARTPTS,apad`;
    }
    args.push('-af',audioFilter,'-t',info.duration.toFixed(9),'-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-ar','48000','-ac','2','-b:a','192k','-video_track_timescale','15360','-movflags','+faststart',temp);
    await ffmpeg(args);await ffmpeg(['-xerror','-i',temp,'-f','null','-']);await rename(temp,target);
    const rendered=await probe(target);clips.push({index:part.index,file:relative,start:part.start||0,duration:rendered.duration,frames:rendered.frames,raw:!normalized,audioMissing,copied:part.generationMode==='base_copy'});
    }catch(error){issues.push({index:part.index,message:safeError(error)});}
  }
  if(!clips.length)return {state:'empty',clips:[],issues,updatedAt:new Date().toISOString()};
  const manifest=path.join(exportRoot,'concat.txt');await writeFile(manifest,clips.map(c=>`file 'clip-${c.index}.mp4'\nduration ${c.frames/30}`).join('\n')+'\n','utf8');
  const temp=path.join(directory,'partial-result.partial.mp4'),target=path.join(directory,'partial-result.mp4');
  try{
    await ffmpeg(['-f','concat','-safe','1','-i',manifest,'-map','0:v:0','-map','0:a:0','-c:v','copy','-c:a','aac','-ar','48000','-ac','2','-af','aresample=async=1:first_pts=0','-t',String(clips.reduce((s,c)=>s+c.frames,0)/30),'-movflags','+faststart',temp]);
    await ffmpeg(['-xerror','-i',temp,'-f','null','-']);await rename(temp,target);
    return {state:'ready',file:'partial-result.mp4',clips,issues,...await probe(target),updatedAt:new Date().toISOString()};
  }catch(error){return {state:'clips_ready',clips,issues,error:safeError(error),updatedAt:new Date().toISOString()};}
}
